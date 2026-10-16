import type { DiscordPresenceConfig } from "./config";

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

export function extractTargetBasename(rawPath: unknown): string | undefined {
	if (typeof rawPath !== "string") return undefined;
	const trimmed = rawPath.trim();
	if (!trimmed) return undefined;

	// Normalize Windows and POSIX path separators first and take last path segment
	const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
	const segments = normalized.split("/").filter(Boolean);
	const lastSegment = segments[segments.length - 1];
	if (!lastSegment) return undefined;

	// Strip omp read selectors like :45-90, :raw:1-5, :19,59, :-60
	const colonIndex = lastSegment.indexOf(":");
	const fileName = colonIndex >= 0 ? lastSegment.slice(0, colonIndex).trim() : lastSegment.trim();
	return fileName.length > 0 ? fileName : undefined;
}

export function extractProjectName(cwd: string): string {
	const normalized = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
	const segments = normalized.split("/").filter(Boolean);
	return segments[segments.length - 1] || "workspace";
}

function formatToolState(
	toolName: string,
	target: string | undefined,
	config: DiscordPresenceConfig,
): string {
	if (config.privacy === "private") {
		return "En sesión activa";
	}
	if (config.privacy === "moderate" || !config.showDetails) {
		return "Agente trabajando";
	}

	const normalizedTool = toolName.toLowerCase();
	if (
		normalizedTool === "edit" ||
		normalizedTool === "write" ||
		normalizedTool === "ast_edit" ||
		normalizedTool === "notebook"
	) {
		return target ? `Editando ${target}` : "Editando archivos";
	}
	if (normalizedTool === "read") {
		return target ? `Leyendo ${target}` : "Leyendo archivos";
	}
	if (normalizedTool === "bash" || normalizedTool === "eval") {
		return "Ejecutando comando";
	}
	if (
		normalizedTool === "grep" ||
		normalizedTool === "glob" ||
		normalizedTool === "find" ||
		normalizedTool === "lsp" ||
		normalizedTool === "ast_grep"
	) {
		return "Explorando el código";
	}
	if (normalizedTool === "task") {
		return "Coordinando subagentes";
	}
	if (normalizedTool === "web_search" || normalizedTool === "fetch") {
		return "Buscando en la web";
	}
	if (normalizedTool === "browser") {
		return "Usando el navegador";
	}
	return `Usando ${toolName}`;
}

export function buildDiscordActivity(
	state: SessionActivityState,
	config: DiscordPresenceConfig,
): DiscordActivity | null {
	if (!config.enabled) {
		return null;
	}

	if (
		state.phase.kind === "idle" &&
		config.idleTimeoutMinutes > 0 &&
		state.nowMs - state.phase.sinceMs >= config.idleTimeoutMinutes * 60_000
	) {
		return null;
	}

	const details =
		config.privacy === "private" || !config.showProject
			? "Programando con omp"
			: `Proyecto: ${state.projectName || "workspace"}`;

	let activityState: string;
	switch (state.phase.kind) {
		case "thinking":
			activityState = config.privacy === "private" ? "En sesión activa" : "Pensando...";
			break;
		case "subagents":
			activityState =
				config.privacy === "private"
					? "En sesión activa"
					: state.phase.count && state.phase.count > 1
						? `Coordinando subagentes (${state.phase.count})`
						: "Coordinando subagentes";
			break;
		case "idle":
			activityState = "En espera";
			break;
		case "tool":
			activityState = formatToolState(state.phase.toolName, state.phase.target, config);
			break;
	}

	const assets: DiscordActivity["assets"] = {
		large_image: config.largeImageKey,
		large_text: config.largeImageText,
	};

	if (config.privacy !== "private" && config.showModel && state.modelName) {
		assets.small_text = `Modelo: ${state.modelName}`;
	}

	return {
		details,
		state: activityState,
		timestamps: {
			start: Math.floor(state.sessionStartMs / 1000),
		},
		assets,
	};
}
