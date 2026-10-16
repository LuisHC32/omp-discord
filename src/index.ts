import {
	type AgentPhase,
	buildDiscordActivity,
	extractProjectName,
	extractTargetBasename,
} from "./activity";
import {
	type DiscordPresenceConfig,
	loadConfig,
	type PrivacyLevel,
	resolveConfigPath,
	saveConfig,
} from "./config";
import { DiscordIpcClient, type DiscordIpcClientOptions, type IpcClientLike } from "./ipc";

export interface ExtensionAgentInfo {
	kind: "main" | "sub";
	id: string;
	name: string;
	depth: number;
	parentId?: string;
}

export interface ExtensionEventContext {
	cwd?: string;
	agent?: ExtensionAgentInfo;
	model?: { id?: string; name?: string };
	models?: {
		current?: () => { id?: string; name?: string } | undefined;
	};
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, value: string | undefined) => void;
	};
	setInterval?: (fn: () => void, ms: number) => unknown;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export type ExtensionEventHandler = (
	event: Record<string, unknown>,
	ctx: ExtensionEventContext,
) => Promise<void> | void;

export type ExtensionCommandHandler = (
	args: string,
	ctx: ExtensionEventContext,
) => Promise<void> | void;

export interface ExtensionLike {
	on(event: string, handler: ExtensionEventHandler): void;
	registerCommand(
		name: string,
		options: {
			description: string;
			handler: ExtensionCommandHandler;
		},
	): void;
	setLabel?(label: string): void;
	logger?: { debug?: (msg: string, meta?: unknown) => void };
}

export interface DiscordExtensionDeps {
	configPath?: string;
	env?: NodeJS.ProcessEnv;
	createIpcClient?: (opts: DiscordIpcClientOptions) => IpcClientLike;
	now?: () => number;
}

function resolveModelLabel(ctx?: ExtensionEventContext): string | undefined {
	const currentModel = ctx?.models?.current?.() ?? ctx?.model;
	if (!currentModel) return undefined;
	return currentModel.id || currentModel.name;
}

function extractToolTarget(event: Record<string, unknown>): string | undefined {
	const rawInput =
		(event.input as Record<string, unknown> | undefined) ??
		(event.args as Record<string, unknown> | undefined) ??
		(event.params as Record<string, unknown> | undefined);
	if (!rawInput || typeof rawInput !== "object") return undefined;

	const candidate = rawInput.path ?? rawInput.file ?? rawInput.file_path ?? rawInput.target;
	return extractTargetBasename(candidate);
}

export function createDiscordExtension(deps?: DiscordExtensionDeps): (pi: ExtensionLike) => void {
	const now = deps?.now ?? (() => Date.now());
	const createClient = deps?.createIpcClient ?? (opts => new DiscordIpcClient(opts));

	return function registerDiscordPresence(pi: ExtensionLike): void {
		pi.setLabel?.("Discord Rich Presence");

		let config: DiscordPresenceConfig = loadConfig({
			configPath: deps?.configPath,
			env: deps?.env,
		});

		let sessionStartMs = now();
		let projectName = extractProjectName(process.cwd());
		let modelName: string | undefined;
		let phase: AgentPhase = { kind: "idle", sinceMs: sessionStartMs };
		let ipcClient: IpcClientLike | null = null;
		let periodicTimer: unknown = undefined;

		function ensureIpcClient(ctx?: ExtensionEventContext): IpcClientLike {
			if (!ipcClient) {
				ipcClient = createClient({
					clientId: config.clientId,
					logger: pi.logger,
					now,
					scheduleTimeout: ctx?.setTimeout ? (fn, ms) => ctx.setTimeout!(fn, ms) : undefined,
					clearScheduledTimeout: ctx?.clearTimer ? handle => ctx.clearTimer!(handle) : undefined,
				});
			}
			return ipcClient;
		}

		async function syncActivity(ctx?: ExtensionEventContext): Promise<void> {
			if (ctx?.cwd) {
				projectName = extractProjectName(ctx.cwd);
			}
			const detectedModel = resolveModelLabel(ctx);
			if (detectedModel) {
				modelName = detectedModel;
			}

			const client = ensureIpcClient(ctx);
			if (!config.enabled) {
				await client.clearActivity();
				return;
			}

			const activity = buildDiscordActivity(
				{
					sessionStartMs,
					projectName,
					modelName,
					phase,
					nowMs: now(),
				},
				config,
			);

			await client.setActivity(activity);
		}

		async function startSession(ctx: ExtensionEventContext): Promise<void> {
			if (ctx.agent && ctx.agent.kind === "sub") return;

			config = loadConfig({ configPath: deps?.configPath, env: deps?.env });
			sessionStartMs = now();
			phase = { kind: "idle", sinceMs: sessionStartMs };

			const client = ensureIpcClient(ctx);
			if (config.enabled) {
				await client.connect();
			}
			await syncActivity(ctx);

			if (periodicTimer !== undefined && ctx.clearTimer) {
				ctx.clearTimer(periodicTimer);
				periodicTimer = undefined;
			}

			if (ctx.setInterval) {
				periodicTimer = ctx.setInterval(() => {
					void syncActivity(ctx);
				}, 30_000);
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			await startSession(ctx);
		});

		pi.on("session_switch", async (_event, ctx) => {
			await startSession(ctx);
		});

		pi.on("before_agent_start", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			phase = { kind: "thinking" };
			await syncActivity(ctx);
		});

		pi.on("agent_start", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			phase = { kind: "thinking" };
			await syncActivity(ctx);
		});

		pi.on("turn_start", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			if (phase.kind === "idle") {
				phase = { kind: "thinking" };
				await syncActivity(ctx);
			}
		});

		const handleToolStart = async (
			event: Record<string, unknown>,
			ctx: ExtensionEventContext,
		): Promise<void> => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			const rawName = event.toolName ?? event.name;
			if (typeof rawName !== "string" || !rawName) return;

			if (rawName === "task") {
				const rawInput = event.input as Record<string, unknown> | undefined;
				const tasksList = Array.isArray(rawInput?.tasks) ? rawInput.tasks : undefined;
				phase = { kind: "subagents", count: tasksList?.length };
			} else {
				phase = {
					kind: "tool",
					toolName: rawName,
					target: extractToolTarget(event),
				};
			}
			await syncActivity(ctx);
		};

		pi.on("tool_call", handleToolStart);
		pi.on("tool_execution_start", handleToolStart);

		pi.on("tool_execution_end", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			phase = { kind: "thinking" };
			await syncActivity(ctx);
		});

		pi.on("agent_end", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			phase = { kind: "idle", sinceMs: now() };
			await syncActivity(ctx);
		});

		pi.on("session_stop", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			phase = { kind: "idle", sinceMs: now() };
			await syncActivity(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.agent && ctx.agent.kind === "sub") return;
			if (periodicTimer !== undefined && ctx.clearTimer) {
				ctx.clearTimer(periodicTimer);
				periodicTimer = undefined;
			}
			if (ipcClient) {
				await ipcClient.clearActivity();
				await ipcClient.close();
			}
		});

		pi.registerCommand("discord", {
			description:
				"Controla Discord Rich Presence (/discord [status|start|on|off|privacy <full|moderate|private>|idle <min>|client-id <id>])",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const sub = (parts[0] ?? "status").toLowerCase();
				const argVal = parts[1];

				const client = ensureIpcClient(ctx);

				if (sub === "start") {
					config = saveConfig({ enabled: true }, { configPath: deps?.configPath });
					const writtenPath = deps?.configPath ?? resolveConfigPath(deps?.env);
					await client.connect();
					await syncActivity(ctx);
					ctx.ui?.notify?.(
						`Discord Rich Presence iniciado. Configuración: ${writtenPath}`,
						"info",
					);
					return;
				}

				if (sub === "on") {
					config = saveConfig({ enabled: true }, { configPath: deps?.configPath });
					await client.connect();
					await syncActivity(ctx);
					ctx.ui?.notify?.("Discord Rich Presence activado.", "info");
					return;
				}

				if (sub === "off") {
					config = saveConfig({ enabled: false }, { configPath: deps?.configPath });
					await client.clearActivity();
					ctx.ui?.notify?.("Discord Rich Presence desactivado.", "info");
					return;
				}

				if (sub === "privacy") {
					const mode = argVal?.toLowerCase() as PrivacyLevel | undefined;
					if (mode !== "full" && mode !== "moderate" && mode !== "private") {
						ctx.ui?.notify?.(
							"Uso: /discord privacy <full|moderate|private>",
							"warning",
						);
						return;
					}
					config = saveConfig({ privacy: mode }, { configPath: deps?.configPath });
					await syncActivity(ctx);
					ctx.ui?.notify?.(`Privacidad de Discord actualizada a: ${mode}`, "info");
					return;
				}

				if (sub === "idle") {
					const mins = Number(argVal);
					if (!Number.isFinite(mins) || mins < 0) {
						ctx.ui?.notify?.(
							"Uso: /discord idle <minutos> (0 para no ocultar nunca)",
							"warning",
						);
						return;
					}
					config = saveConfig(
						{ idleTimeoutMinutes: mins },
						{ configPath: deps?.configPath },
					);
					await syncActivity(ctx);
					ctx.ui?.notify?.(
						`Timeout de inactividad de Discord: ${mins} min`,
						"info",
					);
					return;
				}

				if (sub === "client-id") {
					if (!argVal || !/^\d{15,22}$/.test(argVal.trim())) {
						ctx.ui?.notify?.(
							"Uso: /discord client-id <Discord Application ID numérico>",
							"warning",
						);
						return;
					}
					const newId = argVal.trim();
					config = saveConfig({ clientId: newId }, { configPath: deps?.configPath });
					await client.setClientId(newId);
					await syncActivity(ctx);
					ctx.ui?.notify?.(
						`Discord Client ID actualizado a ${newId}`,
						"info",
					);
					return;
				}

				const connLabel = client.isConnected() ? "conectado" : "desconectado";
				ctx.ui?.notify?.(
					`Discord RPC: ${connLabel} | activo=${config.enabled} | privacidad=${config.privacy} | idle=${config.idleTimeoutMinutes}m | clientId=${config.clientId}`,
					"info",
				);
			},
		});
	};
}

export default createDiscordExtension();
