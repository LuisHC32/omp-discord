# omp-discord Presence Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency native Discord Rich Presence extension for `omp` (`ExtensionAPI`) that displays real-time coding activity, project context, active tool/file, and model in Discord via local IPC with configurable privacy and idle timeout.

**Architecture:** Four focused TypeScript modules: `src/config.ts` (JSON persistence + environment overrides), `src/activity.ts` (pure transformation from session state + privacy settings into Discord activity payloads), `src/ipc.ts` (native `node:net` binary-framed Discord IPC client with rate-limiting and silent auto-reconnect), and `src/index.ts` (`omp` extension lifecycle hooks + `/discord` slash command).

**Tech Stack:** TypeScript, Bun (`bun test`), `node:net`, `node:fs`, `node:path`, `node:os`, `@oh-my-pi/pi-coding-agent` (`ExtensionAPI` surface).

**Spec:** `docs/superpowers/specs/2026-10-16-omp-discord-presence-design.md`

## Global Constraints

- Zero runtime npm dependencies: IPC uses `node:net` directly against `\\?\pipe\discord-ipc-{0..9}` (Windows) and Unix domain sockets (`$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP`, `/tmp`).
- Default Client ID: `DEFAULT_DISCORD_CLIENT_ID = "782685898163617802"`; overridable via `~/.omp/agent/discord-presence.json`, `OMP_DISCORD_CLIENT_ID`, or `/discord client-id <id>`.
- Default idle timeout: `idleTimeoutMinutes = 10` (`0` disables idle hiding).
- Subagent events (`ctx.agent?.kind === "sub"`) must never overwrite the main session's tool/thinking state; main-session `task` execution reports `"Coordinando subagentes"`.
- No raw `setInterval`/`setTimeout` in `src/index.ts`: periodic tasks must use `ctx.setInterval` / `ctx.setTimeout` so throws never crash `omp`.
- Socket errors and disconnections must be caught internally and logged only via debug logger without surfacing unhandled rejections.

## Review Focus

- **Split/concatenated TCP/pipe buffers in IPC (`src/ipc.ts`):** A single `data` event from `net.Socket` may contain a partial 8-byte header, a partial JSON body, or two frames concatenated back-to-back; parser must buffer bytes and loop until all complete frames are consumed.
- **File path selectors and Windows backslashes (`src/activity.ts`):** `omp` `read` paths often look like `C:\repo\src\foo.ts:10-50` or `src/bar.ts:raw:1-10`; target extraction must strip `:line` / `:raw` suffixes and normalize `\` and `/` before extracting `foo.ts`.
- **Corrupted or partial config file on disk (`src/config.ts`):** If `~/.omp/agent/discord-presence.json` contains malformed JSON or out-of-range fields (e.g., negative `idleTimeoutMinutes`), `loadConfig` must fall back cleanly to defaults without throwing.
- **Rapid tool bursts vs. immediate shutdown (`src/ipc.ts`):** Rapid `setActivity` calls within `minUpdateIntervalMs` (default `2000ms`) must coalesce to the latest activity, whereas `clearActivity()` on shutdown must flush immediately before closing the socket.
- **Subagent event interleaving (`src/index.ts`):** While `task` runs, subagents emit `tool_execution_start` and `agent_end` with `ctx.agent.kind === "sub"`; these must be ignored so the main session's presence is not prematurely marked idle or overwritten.

---

### Task 1: Project Scaffolding & Configuration (`src/config.ts`)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PrivacyLevel = "full" | "moderate" | "private";

  export interface DiscordPresenceConfig {
    enabled: boolean;
    clientId: string;
    privacy: PrivacyLevel;
    showProject: boolean;
    showDetails: boolean;
    showModel: boolean;
    idleTimeoutMinutes: number;
    largeImageKey: string;
    largeImageText: string;
  }

  export const DEFAULT_DISCORD_CLIENT_ID = "782685898163617802";
  export const DEFAULT_CONFIG: DiscordPresenceConfig;

  export function resolveConfigPath(env?: NodeJS.ProcessEnv, homeDir?: string): string;
  export function loadConfig(options?: { configPath?: string; env?: NodeJS.ProcessEnv }): DiscordPresenceConfig;
  export function saveConfig(config: Partial<DiscordPresenceConfig>, options?: { configPath?: string }): DiscordPresenceConfig;
  ```

- [ ] **Step 1: Create `package.json` and `tsconfig.json`, and write failing tests in `test/config.test.ts`**

Create `package.json` with `"name": "omp-discord"`, `"type": "module"`, `"omp": { "extensions": ["./src/index.ts"] }`, `"pi": { "extensions": ["./src/index.ts"] }`, and `"scripts": { "test": "bun test" }`.

Write `test/config.test.ts` asserting:
1. `resolveConfigPath` uses `PI_CODING_AGENT_DIR` when set, otherwise `path.join(homeDir, ".omp", "agent", "discord-presence.json")`.
2. `loadConfig` returns `DEFAULT_CONFIG` (`enabled: true`, `clientId: "782685898163617802"`, `privacy: "full"`, `idleTimeoutMinutes: 10`) when file does not exist or contains invalid JSON / negative `idleTimeoutMinutes`.
3. `saveConfig` persists merged config to disk and `loadConfig` reads it back.
4. Environment variables `OMP_DISCORD_CLIENT_ID`, `OMP_DISCORD_ENABLED` (`"0"`, `"false"`, `"1"`, `"true"`), and `OMP_DISCORD_PRIVACY` override disk values in `loadConfig`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL (`Cannot find module '../src/config.ts'`)

- [ ] **Step 3: Implement `src/config.ts`**

Implement `resolveConfigPath`, `loadConfig`, and `saveConfig` using `node:fs` and `node:path`. Sanitize `idleTimeoutMinutes` so negative or `NaN` values fall back to `10`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS (all tests in `test/config.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json src/config.ts test/config.test.ts
git commit -m "feat(config): add configuration loader, persistence, and env overrides"
```

---

### Task 2: Activity Builder & Privacy Rules (`src/activity.ts`)

**Files:**
- Create: `src/activity.ts`
- Test: `test/activity.test.ts`

**Interfaces:**
- Consumes: `DiscordPresenceConfig`, `PrivacyLevel` from `./config.ts`
- Produces:
  ```ts
  export type AgentPhase =
    | { kind: "thinking" }
    | { kind: "tool"; toolName: string; target?: string }
    | { kind: "subagents"; count?: number }
    | { kind: "idle"; sinceMs: number };

  export interface SessionActivityState {
    sessionStartMs: number;
    projectName: string;
    modelName?: string;
    phase: AgentPhase;
    nowMs: number;
  }

  export interface DiscordActivity {
    details: string;
    state: string;
    timestamps: { start: number };
    assets: {
      large_image: string;
      large_text: string;
      small_image?: string;
      small_text?: string;
    };
  }

  export function extractTargetBasename(rawPath: unknown): string | undefined;
  export function extractProjectName(cwd: string): string;
  export function buildDiscordActivity(
    state: SessionActivityState,
    config: DiscordPresenceConfig,
  ): DiscordActivity | null;
  ```

- [ ] **Step 1: Write failing tests in `test/activity.test.ts`**

Test cases:
1. `extractTargetBasename` strips `:line-range` and `:raw` suffixes and handles both `/` and `\` separators (`"C:\\Users\\app\\src\\main.ts:45-90"` → `"main.ts"`, `"notes.md:raw:1-5"` → `"notes.md"`, `""` / `undefined` → `undefined`).
2. `buildDiscordActivity` returns `null` when `config.enabled === false`.
3. `buildDiscordActivity` returns `"En espera"` when idle before timeout, and `null` when `nowMs - phase.sinceMs >= config.idleTimeoutMinutes * 60_000` (unless `idleTimeoutMinutes === 0`).
4. Tool phase mapping in `privacy: "full"`:
   - `edit` with `target: "index.ts"` → `details: "Proyecto: omp-discord"`, `state: "Editando index.ts"`
   - `read` with `target: "README.md"` → `state: "Leyendo README.md"`
   - `bash` → `state: "Ejecutando comando"`
   - `grep` / `glob` / `lsp` → `state: "Explorando el código"`
   - `task` → `state: "Coordinando subagentes"`
   - `web_search` → `state: "Buscando en la web"`
5. Privacy modes:
   - `privacy: "moderate"` keeps `"Proyecto: omp-discord"` and `small_text: "Modelo: ..."`, but masks tool details as `"Agente trabajando"`.
   - `privacy: "private"` sets `details: "Programando con omp"`, `state: "En sesión activa"` (or `"En espera"` when idle), and omits `small_text`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/activity.test.ts`
Expected: FAIL (`Cannot find module '../src/activity.ts'`)

- [ ] **Step 3: Implement `src/activity.ts`**

Implement `extractTargetBasename`, `extractProjectName`, and `buildDiscordActivity` following Section 2.3 of the spec.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/activity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/activity.ts test/activity.test.ts
git commit -m "feat(activity): add Discord activity formatter and privacy rules"
```

---

### Task 3: Native Discord IPC Client (`src/ipc.ts`)

**Files:**
- Create: `src/ipc.ts`
- Test: `test/ipc.test.ts`

**Interfaces:**
- Consumes: `DiscordActivity` from `./activity.ts`
- Produces:
  ```ts
  export enum IpcOpcode {
    HANDSHAKE = 0,
    FRAME = 1,
    CLOSE = 2,
    PING = 3,
    PONG = 4,
  }

  export interface IpcFrame {
    opcode: IpcOpcode;
    payload: Record<string, unknown>;
  }

  export function encodeFrame(opcode: IpcOpcode, payload: unknown): Buffer;
  export function decodeFrames(buffer: Buffer): { frames: IpcFrame[]; remainder: Buffer };
  export function getCandidateIpcPaths(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];

  export interface DiscordIpcClientOptions {
    clientId: string;
    candidatePaths?: string[];
    minUpdateIntervalMs?: number;
    pid?: number;
    logger?: { debug?: (msg: string, meta?: unknown) => void };
    scheduleTimeout?: (fn: () => void, ms: number) => unknown;
    clearScheduledTimeout?: (handle: unknown) => void;
  }

  export class DiscordIpcClient {
    constructor(options: DiscordIpcClientOptions);
    isConnected(): boolean;
    connect(): Promise<boolean>;
    setClientId(clientId: string): Promise<boolean>;
    setActivity(activity: DiscordActivity | null): Promise<void>;
    clearActivity(): Promise<void>;
    close(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write failing tests in `test/ipc.test.ts`**

Test cases:
1. `encodeFrame` and `decodeFrames` round-trip a single frame, handle concatenated frames in one `Buffer`, and preserve trailing incomplete bytes in `remainder`.
2. `DiscordIpcClient.connect()` connects to a mock `net.Server` listening on a test pipe/socket path, sends `HANDSHAKE` (`opcode = 0`, `{ v: 1, client_id }`), receives `READY` frame, and reports `isConnected() === true`.
3. `setActivity` sends `SET_ACTIVITY` (`opcode = 1`, `cmd: "SET_ACTIVITY"`, `args.pid`, `args.activity`), throttles rapid calls within `minUpdateIntervalMs` to the latest activity, and responds to server `PING` (`opcode = 3`) with `PONG` (`opcode = 4`).
4. `clearActivity()` immediately sends `SET_ACTIVITY` with `activity: null` bypassing throttle, and `close()` cleanly closes the socket.
5. When no IPC socket exists, `connect()` resolves to `false` without throwing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ipc.test.ts`
Expected: FAIL (`Cannot find module '../src/ipc.ts'`)

- [ ] **Step 3: Implement `src/ipc.ts`**

Implement binary framing (`UInt32LE` opcode at offset 0, `UInt32LE` byte length at offset 4), candidate socket path discovery, handshake state machine, `PING` → `PONG` reply, rate-limited `setActivity`, and immediate `clearActivity`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts test/ipc.test.ts
git commit -m "feat(ipc): implement native binary Discord IPC client with throttling"
```

---

### Task 4: `omp` Extension Entrypoint & `/discord` Command (`src/index.ts`)

**Files:**
- Create: `src/index.ts`
- Create: `README.md`
- Test: `test/extension.test.ts`

**Interfaces:**
- Consumes: `src/config.ts`, `src/activity.ts`, `src/ipc.ts`
- Produces:
  ```ts
  export interface ExtensionLike {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    registerCommand(
      name: string,
      options: { description: string; handler: (args: string, ctx: any) => Promise<void> | void },
    ): void;
    setLabel?(label: string): void;
    logger?: { debug?: (msg: string, meta?: unknown) => void };
  }

  export function createDiscordExtension(deps?: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    createIpcClient?: (opts: DiscordIpcClientOptions) => DiscordIpcClient;
    now?: () => number;
  }): (pi: ExtensionLike) => void;

  export default function discordPresenceExtension(pi: ExtensionLike): void;
  ```

- [ ] **Step 1: Write failing tests in `test/extension.test.ts`**

Test cases:
1. Full lifecycle (`session_start` → `agent_start` → `tool_execution_start` (`edit` on `src/app.ts:10-20`) → `tool_execution_end` → `agent_end` → idle timeout tick → `session_shutdown`) emits expected activities (`En espera` → `Pensando...` → `Editando app.ts` → `Pensando...` → `En espera` → `null` after idle timeout → `clearActivity()` + `close()`).
2. Subagent filtering: events where `ctx.agent = { kind: "sub", id: "sub1", name: "scout", depth: 1 }` do not overwrite the main session's state.
3. `/discord` command handlers:
   - `/discord status` notifies connection state and current config.
   - `/discord off` clears activity and persists `enabled: false`; `/discord on` re-enables and updates activity.
   - `/discord privacy private` persists `privacy: "private"` and updates activity to `"Programando con omp"`.
   - `/discord idle 5` updates `idleTimeoutMinutes: 5`.
   - `/discord client-id 123456789012345678` updates `clientId` and reconnects IPC client.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/extension.test.ts`
Expected: FAIL (`Cannot find module '../src/index.ts'`)

- [ ] **Step 3: Implement `src/index.ts` and `README.md`**

Implement `createDiscordExtension` and default export `discordPresenceExtension(pi)` wiring `session_start`, `session_switch`, `before_agent_start`, `agent_start`, `turn_start`, `tool_execution_start`, `tool_call`, `tool_execution_end`, `agent_end`, `session_stop`, `session_shutdown`, and `/discord`. Use `ctx.setInterval` and `ctx.setTimeout` when available on `ctx`. Document installation (`~/.omp/agent/extensions/` or `omp --extension`) and `/discord` commands in `README.md`.

- [ ] **Step 4: Run full test suite to verify all tests pass**

Run: `bun test`
Expected: PASS (all 4 test suites passing)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md test/extension.test.ts
git commit -m "feat(extension): wire omp lifecycle events and /discord command"
```
