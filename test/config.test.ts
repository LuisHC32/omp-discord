import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	DEFAULT_DISCORD_CLIENT_ID,
	loadConfig,
	resolveConfigPath,
	saveConfig,
} from "../src/config";

describe("config", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-discord-config-"));
		configPath = path.join(tempDir, "discord-presence.json");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("resolveConfigPath uses PI_CODING_AGENT_DIR when set, otherwise ~/.omp/agent/discord-presence.json", () => {
		const withPiDir = resolveConfigPath({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/user");
		expect(withPiDir).toBe(path.join("/custom/agent", "discord-presence.json"));

		const withDefault = resolveConfigPath({}, "/home/user");
		expect(withDefault).toBe(path.join("/home/user", ".omp", "agent", "discord-presence.json"));
	});

	test("loadConfig returns DEFAULT_CONFIG when file does not exist", () => {
		const cfg = loadConfig({ configPath, env: {} });
		expect(cfg).toEqual(DEFAULT_CONFIG);
		expect(cfg.clientId).toBe(DEFAULT_DISCORD_CLIENT_ID);
		expect(cfg.enabled).toBe(true);
		expect(cfg.privacy).toBe("full");
		expect(cfg.idleTimeoutMinutes).toBe(10);
		expect(cfg.appName).toBe("VibeCoding");
		expect(cfg.largeImageKey).toBe("https://omp.sh/favicon-512x512.png");
	});

	test("loadConfig falls back to defaults on corrupted JSON or negative idleTimeoutMinutes", () => {
		fs.writeFileSync(configPath, "{ invalid json", "utf8");
		expect(loadConfig({ configPath, env: {} })).toEqual(DEFAULT_CONFIG);

		fs.writeFileSync(
			configPath,
			JSON.stringify({ idleTimeoutMinutes: -5, privacy: "invalid-mode", enabled: "not-bool" }),
			"utf8",
		);
		const sanitized = loadConfig({ configPath, env: {} });
		expect(sanitized.idleTimeoutMinutes).toBe(10);
		expect(sanitized.privacy).toBe("full");
		expect(sanitized.enabled).toBe(true);
	});

	test("saveConfig persists merged configuration and loadConfig reads it back", () => {
		const saved = saveConfig(
			{
				enabled: false,
				privacy: "moderate",
				idleTimeoutMinutes: 15,
				clientId: "111222333444555666",
			},
			{ configPath },
		);
		expect(saved.enabled).toBe(false);
		expect(saved.privacy).toBe("moderate");
		expect(saved.idleTimeoutMinutes).toBe(15);
		expect(saved.clientId).toBe("111222333444555666");

		const loaded = loadConfig({ configPath, env: {} });
		expect(loaded).toEqual(saved);
	});

	test("environment variables override persisted config values", () => {
		saveConfig({ enabled: true, privacy: "full", clientId: "111" }, { configPath });

		const overridden = loadConfig({
			configPath,
			env: {
				OMP_DISCORD_CLIENT_ID: "999888777666555444",
				OMP_DISCORD_ENABLED: "false",
				OMP_DISCORD_PRIVACY: "private",
			},
		});

		expect(overridden.clientId).toBe("999888777666555444");
		expect(overridden.enabled).toBe(false);
		expect(overridden.privacy).toBe("private");
	});
});
