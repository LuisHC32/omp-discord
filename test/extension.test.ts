import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscordActivity } from "../src/activity";
import {
	createDiscordExtension,
	type ExtensionCommandHandler,
	type ExtensionEventContext,
	type ExtensionEventHandler,
	type ExtensionLike,
} from "../src/index";
import type { DiscordIpcClientOptions, IpcClientLike } from "../src/ipc";

class FakeIpcClient implements IpcClientLike {
	connected = true;
	clientId: string;
	activities: Array<DiscordActivity | null> = [];
	clearedCount = 0;
	closedCount = 0;

	constructor(options: DiscordIpcClientOptions) {
		this.clientId = options.clientId;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async connect(): Promise<boolean> {
		this.connected = true;
		return true;
	}

	async setClientId(clientId: string): Promise<boolean> {
		this.clientId = clientId;
		this.connected = true;
		return true;
	}

	async setActivity(activity: DiscordActivity | null): Promise<void> {
		this.activities.push(activity);
	}

	async clearActivity(): Promise<void> {
		this.clearedCount += 1;
		this.activities.push(null);
	}

	async close(): Promise<void> {
		this.closedCount += 1;
		this.connected = false;
	}
}

describe("discord extension", () => {
	let tempDir: string;
	let configPath: string;
	let fakeNow: number;
	let ipcClient: FakeIpcClient | undefined;
	let handlers: Record<string, ExtensionEventHandler[]>;
	let commands: Record<string, ExtensionCommandHandler>;
	let intervalCallbacks: Array<() => void>;
	let notifications: Array<{ message: string; level?: string }>;
	let baseCtx: ExtensionEventContext;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-discord-ext-"));
		configPath = path.join(tempDir, "discord-presence.json");
		fakeNow = 1_700_000_000_000;
		ipcClient = undefined;
		handlers = {};
		commands = {};
		intervalCallbacks = [];
		notifications = [];

		baseCtx = {
			cwd: "C:\\Users\\luisH\\Proyectos\\omp-discord",
			agent: { kind: "main", id: "main", name: "main", depth: 0 },
			models: {
				current: () => ({ id: "gemini-4-argon" }),
			},
			ui: {
				notify: (message: string, level?: string) => {
					notifications.push({ message, level });
				},
			},
			setInterval: (fn: () => void) => {
				intervalCallbacks.push(fn);
				return intervalCallbacks.length;
			},
			setTimeout: (fn: () => void) => {
				return fn;
			},
			clearTimer: () => {},
		};

		const pi: ExtensionLike = {
			on(event, handler) {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(handler);
			},
			registerCommand(name, options) {
				commands[name] = options.handler;
			},
			setLabel() {},
		};

		const ext = createDiscordExtension({
			configPath,
			env: {},
			now: () => fakeNow,
			createIpcClient: opts => {
				ipcClient = new FakeIpcClient(opts);
				return ipcClient;
			},
		});
		ext(pi);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function emit(
		event: string,
		payload: Record<string, unknown> = {},
		ctx: ExtensionEventContext = baseCtx,
	): Promise<void> {
		for (const h of handlers[event] ?? []) {
			await h(payload, ctx);
		}
	}

	test("tracks full session lifecycle, ignores subagent tool noise, and expires idle presence", async () => {
		await emit("session_start");
		expect(ipcClient).toBeDefined();
		expect(ipcClient?.activities.at(-1)?.details).toBe("Proyecto: omp-discord");
		expect(ipcClient?.activities.at(-1)?.state).toBe("En espera");
		expect(ipcClient?.activities.at(-1)?.assets.small_text).toBe("Modelo: gemini-4-argon");

		await emit("agent_start");
		expect(ipcClient?.activities.at(-1)?.state).toBe("Pensando...");

		await emit("tool_execution_start", {
			toolName: "edit",
			input: { path: "src/index.ts:10-30" },
		});
		expect(ipcClient?.activities.at(-1)?.state).toBe("Editando index.ts");

		// Subagent event should NOT overwrite main session state
		const subCtx: ExtensionEventContext = {
			...baseCtx,
			agent: { kind: "sub", id: "sub-1", name: "scout", depth: 1 },
		};
		await emit(
			"tool_execution_start",
			{ toolName: "read", input: { path: "src/secret.ts" } },
			subCtx,
		);
		await emit("agent_end", {}, subCtx);
		expect(ipcClient?.activities.at(-1)?.state).toBe("Editando index.ts");

		// Main tool ends -> back to thinking
		await emit("tool_execution_end", { toolName: "edit" });
		expect(ipcClient?.activities.at(-1)?.state).toBe("Pensando...");

		// Main turn ends -> En espera
		fakeNow += 5_000;
		await emit("agent_end");
		expect(ipcClient?.activities.at(-1)?.state).toBe("En espera");

		// Advance past 10-minute idle timeout and run periodic tick
		fakeNow += 11 * 60_000;
		for (const tick of intervalCallbacks) {
			await tick();
		}
		expect(ipcClient?.activities.at(-1)).toBeNull();

		// Shutdown clears activity and closes IPC client
		await emit("session_shutdown");
		expect(ipcClient?.clearedCount).toBeGreaterThanOrEqual(1);
		expect(ipcClient?.closedCount).toBe(1);
	});

	test("/discord command toggles presence, changes privacy, updates idle timeout, and updates client-id", async () => {
		await emit("session_start");
		const cmd = commands.discord;
		expect(cmd).toBeDefined();

		await cmd!("status", baseCtx);
		expect(notifications.at(-1)?.message).toContain("conectado");

		await cmd!("off", baseCtx);
		expect(ipcClient?.activities.at(-1)).toBeNull();

		await cmd!("on", baseCtx);
		expect(ipcClient?.activities.at(-1)?.details).toBe("Proyecto: omp-discord");

		await cmd!("privacy private", baseCtx);
		expect(ipcClient?.activities.at(-1)?.details).toBe("Programando con omp");
		expect(ipcClient?.activities.at(-1)?.assets.small_text).toBeUndefined();

		await cmd!("idle 5", baseCtx);
		expect(notifications.at(-1)?.message).toContain("5 min");

		await cmd!("client-id 123456789012345678", baseCtx);
		expect(ipcClient?.clientId).toBe("123456789012345678");
	});
});
