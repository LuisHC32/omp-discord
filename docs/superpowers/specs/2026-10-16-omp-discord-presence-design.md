# Diseño: Extensión Discord Rich Presence para `omp` (`omp-discord`)

**Fecha:** 2026-10-16  
**Estado:** Aprobado en diseño, pendiente de revisión de especificación

## 1. Propósito y Alcance

`omp-discord` es una extensión nativa para Oh My Pi (`omp`) que muestra en el perfil de Discord del usuario (mediante Discord Rich Presence local) que está programando en `omp`, de forma análoga a la extensión Discord Presence de VS Code.

### Criterios de Éxito
- Se conecta automáticamente al cliente de escritorio local de Discord vía IPC (`discord-ipc-0..9`) sin dependencias npm externas en tiempo de ejecución.
- Refleja en tiempo real el estado de la sesión principal de `omp`: proyecto actual, herramienta o archivo en uso, modelo activo y tiempo de sesión transcurrido.
- Pasa a estado *"En espera (Idle)"* cuando termina el turno del agente y oculta la presencia tras un tiempo de inactividad configurable (10 minutos por defecto), reactivándola al volver a interactuar.
- Permite controlar el estado y nivel de privacidad en caliente mediante el comando `/discord` y persistir la configuración en `~/.omp/agent/discord-presence.json`.
- Es completamente resiliente: si Discord está cerrado o se desconecta, nunca interrumpe ni lanza excepciones no capturadas en el proceso de `omp`.

---

## 2. Arquitectura y Módulos

El proyecto se estructura en cuatro módulos con responsabilidades aisladas:

```
omp-discord/
├── package.json
├── tsconfig.json
├── src/
│   ├── ipc.ts          # Cliente Discord IPC sobre node:net (framing binario + reconexión + throttling)
│   ├── config.ts       # Carga, validación y persistencia de configuración + overrides por entorno
│   ├── activity.ts     # Transformación pura de SessionState + DiscordConfig -> DiscordActivity | null
│   └── index.ts        # Punto de entrada ExtensionAPI (eventos omp, timers seguros, comando /discord)
└── test/
    ├── ipc.test.ts
    ├── config.test.ts
    ├── activity.test.ts
    └── extension.test.ts
```

### 2.1 `src/ipc.ts` — Cliente Discord IPC (`DiscordIpcClient`)
- **Transporte:** `node:net` conectando secuencialmente a los slots `0` a `9`:
  - Windows: `\\?\pipe\discord-ipc-{0..9}`
  - Unix (Linux/macOS): busca en `$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP` y `/tmp` (incluyendo rutas de Flatpak/Snap `app/com.discordapp.Discord/discord-ipc-{0..9}`).
- **Framing binario:**
  - Header de 8 bytes Little Endian: `opcode` (`UInt32LE`) + `length` (`UInt32LE`) seguido del cuerpo JSON en UTF-8.
  - Opcodes soportados: `0` (`HANDSHAKE`), `1` (`FRAME`), `2` (`CLOSE`), `3` (`PING`), `4` (`PONG`).
- **Ciclo de conexión:**
  1. Abre el primer pipe/socket disponible.
  2. Envía `HANDSHAKE` (`opcode = 0`) con `{ v: 1, client_id: clientId }`.
  3. Espera trama `READY` (`cmd: "DISPATCH"`, `evt: "READY"`).
  4. Envía comandos `SET_ACTIVITY` (`opcode = 1`, `{ cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce }`).
- **Control de tasa (Rate Limiting / Throttling):**
  - Discord limita actualizaciones de presencia a 5 cada 20 segundos.
  - `DiscordIpcClient` aplica un intervalo mínimo configurable (`minUpdateIntervalMs = 2000` ms por defecto), reteniendo siempre el último estado pendiente y enviándolo al cumplirse la ventana.
  - Las limpiezas explícitas al cerrar sesión (`clearActivity()` en `session_shutdown`) se envían de inmediato antes de cerrar el socket.

### 2.2 `src/config.ts` — Configuración y Privacidad (`DiscordPresenceConfig`)
- **Ubicación del archivo:** `~/.omp/agent/discord-presence.json` (respetando `PI_CODING_AGENT_DIR` si está definido).
- **Esquema y valores por defecto:**
  ```ts
  export type PrivacyLevel = "full" | "moderate" | "private";

  export interface DiscordPresenceConfig {
    enabled: boolean;            // default: true
    clientId: string;            // default: DEFAULT_DISCORD_CLIENT_ID ("782685898163617802", configurable via /discord client-id <id> o OMP_DISCORD_CLIENT_ID)
    privacy: PrivacyLevel;       // default: "full"
    showProject: boolean;        // default: true  (derivado o sobrescrito por privacy)
    showDetails: boolean;        // default: true  (muestra archivo/herramienta)
    showModel: boolean;          // default: true  (muestra el modelo activo)
    idleTimeoutMinutes: number;  // default: 10 (0 = no ocultar nunca en idle)
    largeImageKey: string;       // default: URL/asset del logo de omp
    largeImageText: string;      // default: "Oh My Pi (omp)"
  }
  ```
- **Variables de entorno (tienen precedencia sobre el archivo):**
  - `OMP_DISCORD_CLIENT_ID`: sobrescribe `clientId`.
  - `OMP_DISCORD_ENABLED`: `"0"` / `"false"` desactiva la presencia; `"1"` / `"true"` la activa.
  - `OMP_DISCORD_PRIVACY`: `"full"` | `"moderate"` | `"private"`.

### 2.3 `src/activity.ts` — Construcción de Actividad (`buildDiscordActivity`)
Recibe el estado actual de la sesión (`SessionActivityState`) y la configuración (`DiscordPresenceConfig`), devolviendo el objeto `DiscordActivity` o `null`.

```ts
export type AgentPhase =
  | { kind: "thinking" }
  | { kind: "tool"; toolName: string; target?: string }
  | { kind: "subagents"; count: number }
  | { kind: "idle"; sinceMs: number };

export interface SessionActivityState {
  sessionStartMs: number;
  projectName: string;
  modelName?: string;
  phase: AgentPhase;
  nowMs: number;
}
```

#### Reglas de Formateo:
1. **Verificación de activación e inactividad:**
   - Si `!config.enabled`, devuelve `null`.
   - Si `phase.kind === "idle"` y `config.idleTimeoutMinutes > 0` y `nowMs - phase.sinceMs >= config.idleTimeoutMinutes * 60_000`, devuelve `null`.
2. **Línea 1 (`details`):**
   - En `privacy === "private"` o `!config.showProject`: `"Programando con omp"`.
   - En caso contrario: `"Proyecto: <projectName>"` (donde `projectName` es `path.basename(cwd)`).
3. **Línea 2 (`state`):**
   - `phase.kind === "thinking"`: `"Pensando..."`
   - `phase.kind === "subagents"`: `"Coordinando subagentes (<count>)"`
   - `phase.kind === "idle"`: `"En espera"`
   - `phase.kind === "tool"`:
     - Si `privacy === "full"` y `config.showDetails`:
       - `edit` | `write` | `ast_edit` | `notebook`: `target ? "Editando " + target : "Editando archivos"`
       - `read`: `target ? "Leyendo " + target : "Leyendo archivos"`
       - `bash` | `eval`: `"Ejecutando comando"`
       - `grep` | `glob` | `find` | `lsp` | `ast_grep`: `"Explorando el código"`
       - `task`: `"Coordinando subagentes"`
       - `web_search` | `fetch`: `"Buscando en la web"`
       - `browser`: `"Usando el navegador"`
       - Cualquier otra herramienta: `"Usando " + toolName`
     - Si `privacy === "moderate"` o `!config.showDetails`: `"Agente trabajando"`
     - Si `privacy === "private"`: `"En sesión activa"`
4. **Sanitización de `target`:**
   - Nunca se incluye una ruta completa ni argumentos de comandos de consola.
   - Para herramientas de archivos (`read`, `edit`, `write`), solo se extrae `path.basename(pathWithoutSelectors)` (eliminando sufijos `:10-20` de `read`).
5. **Timestamps y Assets:**
   - `timestamps: { start: Math.floor(sessionStartMs / 1000) }`
   - `assets`:
     - `large_image`: `config.largeImageKey`
     - `large_text`: `config.largeImageText`
     - `small_text` (solo si `privacy !== "private"` y `config.showModel` y `modelName`): `"Modelo: " + modelName`

### 2.4 `src/index.ts` — Integración con `omp` (`ExtensionAPI`)
- **Filtro de sesión principal:**
  - Los eventos donde `ctx.agent && ctx.agent.kind === "sub"` no pisan el estado principal con sus herramientas individuales; en su lugar, cuando la sesión principal invoca `task`, el estado muestra `"Coordinando subagentes"`.
- **Suscripción a eventos:**
  - `session_start` / `session_switch`: inicializa `sessionStartMs`, detecta `cwd` y modelo (`ctx.models?.current()?.id ?? ctx.model?.id`), conecta el cliente IPC y registra timers con `ctx.setInterval` para:
    1. Reconexión silenciosa cada 30s si Discord no está conectado.
    2. Verificación cada 30s del timeout de inactividad (`idleTimeoutMinutes`).
  - `before_agent_start` / `agent_start` / `turn_start`: pasa a fase `thinking` y actualiza presencia.
  - `tool_execution_start` / `tool_call`: extrae `toolName` y `basename(input.path)` (si aplica), pasa a fase `tool` y actualiza presencia.
  - `tool_execution_end`: vuelve a fase `thinking` mientras el turno sigue activo.
  - `agent_end` / `session_stop`: pasa a fase `idle` con `sinceMs = Date.now()` y actualiza presencia.
  - `session_shutdown`: limpia la actividad en Discord y cierra el socket IPC.
- **Comando `/discord`:**
  - `/discord` o `/discord status`: notifica en la TUI (`ctx.ui.notify`) el estado de conexión IPC, privacidad, timeout de inactividad y Client ID actual.
  - `/discord on` / `/discord off`: activa o desactiva la presencia inmediatamente y persiste en disco.
  - `/discord privacy <full|moderate|private>`: cambia el modo de privacidad, persiste en disco y refresca la actividad en Discord.
  - `/discord idle <minutos>`: cambia el tiempo de espera antes de ocultar la presencia en idle (`0` para desactivar ocultación) y persiste.
  - `/discord client-id <id>`: actualiza el `clientId`, persiste y reconecta el cliente IPC.

---

## 3. Manejo de Errores y Seguridad en Tiempo de Ejecución

- **Aislamiento total:** Todos los timers periódicos usan `ctx.setInterval` / `ctx.setTimeout` provistos por `omp`. Los manejadores de eventos de `net.Socket` (`error`, `close`, `data`) capturan cualquier excepción internamente y registran diagnósticos mediante `pi.logger?.debug(...)` sin propagar errores al bucle de eventos global.
- **Tolerancia a desconexiones:** Si el usuario cierra Discord a mitad de una sesión o abre `omp` sin Discord abierto, la extensión opera en modo desconectado sin degradar el rendimiento ni mostrar errores molestos en la TUI, conectándose automáticamente cuando Discord se abra.

---

## 4. Estrategia de Pruebas

1. **`test/ipc.test.ts`:** Levanta un servidor `net.Server` local simulando el pipe/socket de Discord IPC; verifica el framing binario de 8 bytes (`HANDSHAKE`, respuesta `READY`, `SET_ACTIVITY`, `PING`/`PONG`), el throttling de actualizaciones rápidas y la reconexión tras cierre del servidor.
2. **`test/activity.test.ts`:** Verifica todas las combinaciones de `AgentPhase`, modos de privacidad (`full`, `moderate`, `private`), sanitización de rutas con selectores (`src/foo.ts:10-20` → `foo.ts`) y expiración por `idleTimeoutMinutes`.
3. **`test/config.test.ts`:** Verifica lectura/escritura del JSON de configuración, valores por defecto ante archivos inexistentes o corruptos, y precedencia de variables de entorno.
4. **`test/extension.test.ts`:** Simula `ExtensionAPI` y el ciclo completo de eventos (`session_start` → `agent_start` → `tool_execution_start` → `agent_end` → comando `/discord` → `session_shutdown`), comprobando que las actividades enviadas al cliente IPC coinciden con el flujo esperado y que los subagentes (`kind: "sub"`) no corrompen el estado principal.
