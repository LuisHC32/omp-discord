import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PrivacyLevel = "full" | "moderate" | "private";

export interface DiscordPresenceConfig {
	enabled: boolean;
	clientId: string;
	appName: string;
	privacy: PrivacyLevel;
	showProject: boolean;
	showDetails: boolean;
	showModel: boolean;
	idleTimeoutMinutes: number;
	largeImageKey: string;
	largeImageText: string;
}

export const DEFAULT_DISCORD_CLIENT_ID = "782685898163617802";
export const DEFAULT_OMP_ICON_URL = "https://omp.sh/favicon-512x512.png";

export const DEFAULT_CONFIG: DiscordPresenceConfig = {
	enabled: true,
	clientId: DEFAULT_DISCORD_CLIENT_ID,
	appName: "VibeCoding",
	privacy: "full",
	showProject: true,
	showDetails: true,
	showModel: true,
	idleTimeoutMinutes: 10,
	largeImageKey: DEFAULT_OMP_ICON_URL,
	largeImageText: "Oh My Pi (omp.sh)",
};

export function resolveConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = os.homedir(),
): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim();
	if (agentDir) {
		return path.join(agentDir, "discord-presence.json");
	}
	return path.join(homeDir, ".omp", "agent", "discord-presence.json");
}

function isPrivacyLevel(value: unknown): value is PrivacyLevel {
	return value === "full" || value === "moderate" || value === "private";
}

function sanitizeConfig(raw: Record<string, unknown>): DiscordPresenceConfig {
	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled;
	const clientId =
		typeof raw.clientId === "string" && raw.clientId.trim().length > 0
			? raw.clientId.trim()
			: DEFAULT_CONFIG.clientId;
	const appName =
		typeof raw.appName === "string" && raw.appName.trim().length > 0
			? raw.appName.trim()
			: DEFAULT_CONFIG.appName;
	const privacy = isPrivacyLevel(raw.privacy) ? raw.privacy : DEFAULT_CONFIG.privacy;
	const showProject =
		typeof raw.showProject === "boolean" ? raw.showProject : DEFAULT_CONFIG.showProject;
	const showDetails =
		typeof raw.showDetails === "boolean" ? raw.showDetails : DEFAULT_CONFIG.showDetails;
	const showModel =
		typeof raw.showModel === "boolean" ? raw.showModel : DEFAULT_CONFIG.showModel;
	const idleTimeoutMinutes =
		typeof raw.idleTimeoutMinutes === "number" &&
		Number.isFinite(raw.idleTimeoutMinutes) &&
		raw.idleTimeoutMinutes >= 0
			? raw.idleTimeoutMinutes
			: DEFAULT_CONFIG.idleTimeoutMinutes;
	const largeImageKey =
		typeof raw.largeImageKey === "string" &&
		raw.largeImageKey.trim().length > 0 &&
		raw.largeImageKey.trim() !== "code"
			? raw.largeImageKey.trim()
			: DEFAULT_CONFIG.largeImageKey;
	const largeImageText =
		typeof raw.largeImageText === "string" && raw.largeImageText.trim().length > 0
			? raw.largeImageText.trim()
			: DEFAULT_CONFIG.largeImageText;

	return {
		enabled,
		clientId,
		appName,
		privacy,
		showProject,
		showDetails,
		showModel,
		idleTimeoutMinutes,
		largeImageKey,
		largeImageText,
	};
}

function readDiskConfig(configPath: string): DiscordPresenceConfig {
	try {
		if (!fs.existsSync(configPath)) {
			return { ...DEFAULT_CONFIG };
		}
		const content = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return { ...DEFAULT_CONFIG };
		}
		return sanitizeConfig(parsed as Record<string, unknown>);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function loadConfig(options?: {
	configPath?: string;
	env?: NodeJS.ProcessEnv;
}): DiscordPresenceConfig {
	const env = options?.env ?? process.env;
	const configPath = options?.configPath ?? resolveConfigPath(env);
	const config = readDiskConfig(configPath);

	const envClientId = env.OMP_DISCORD_CLIENT_ID?.trim();
	if (envClientId) {
		config.clientId = envClientId;
	}

	const envEnabled = env.OMP_DISCORD_ENABLED?.trim().toLowerCase();
	if (envEnabled === "0" || envEnabled === "false") {
		config.enabled = false;
	} else if (envEnabled === "1" || envEnabled === "true") {
		config.enabled = true;
	}

	const envPrivacy = env.OMP_DISCORD_PRIVACY?.trim().toLowerCase();
	if (isPrivacyLevel(envPrivacy)) {
		config.privacy = envPrivacy;
	}

	return config;
}

export function saveConfig(
	updates: Partial<DiscordPresenceConfig>,
	options?: { configPath?: string },
): DiscordPresenceConfig {
	const configPath = options?.configPath ?? resolveConfigPath();
	const current = readDiskConfig(configPath);
	const merged = sanitizeConfig({ ...current, ...updates });

	try {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	} catch {
		// Ignore write errors in restricted environments
	}

	return merged;
}
