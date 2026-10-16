import { describe, expect, test } from "bun:test";
import {
	buildDiscordActivity,
	extractProjectName,
	extractTargetBasename,
	type SessionActivityState,
} from "../src/activity";
import { DEFAULT_CONFIG, type DiscordPresenceConfig } from "../src/config";

describe("activity", () => {
	const baseState: SessionActivityState = {
		sessionStartMs: 1_700_000_000_000,
		projectName: "omp-discord",
		modelName: "gemini-4-argon",
		phase: { kind: "thinking" },
		nowMs: 1_700_000_060_000,
	};

	test("extractTargetBasename strips line ranges, :raw selectors, and normalizes path separators", () => {
		expect(extractTargetBasename("C:\\Users\\app\\src\\main.ts:45-90")).toBe("main.ts");
		expect(extractTargetBasename("src/bar/notes.md:raw:1-5")).toBe("notes.md");
		expect(extractTargetBasename("src/foo.ts:120")).toBe("foo.ts");
		expect(extractTargetBasename("src/foo.ts:19,59")).toBe("foo.ts");
		expect(extractTargetBasename("")).toBeUndefined();
		expect(extractTargetBasename(undefined)).toBeUndefined();
	});

	test("extractProjectName extracts folder basename across platforms", () => {
		expect(extractProjectName("C:\\Users\\luisH\\Proyectos\\omp-discord")).toBe("omp-discord");
		expect(extractProjectName("/home/user/workspace/my-app/")).toBe("my-app");
	});

	test("buildDiscordActivity returns null when disabled", () => {
		const cfg: DiscordPresenceConfig = { ...DEFAULT_CONFIG, enabled: false };
		expect(buildDiscordActivity(baseState, cfg)).toBeNull();
	});

	test("buildDiscordActivity handles idle state before and after idleTimeoutMinutes", () => {
		const idleState: SessionActivityState = {
			...baseState,
			phase: { kind: "idle", sinceMs: 1_700_000_000_000 },
			nowMs: 1_700_000_000_000 + 5 * 60_000, // 5 min (< 10 min)
		};
		const activeIdle = buildDiscordActivity(idleState, DEFAULT_CONFIG);
		expect(activeIdle).not.toBeNull();
		expect(activeIdle?.state).toBe("En espera");
		expect(activeIdle?.details).toBe("Proyecto: omp-discord");

		const expiredIdle: SessionActivityState = {
			...idleState,
			nowMs: 1_700_000_000_000 + 10 * 60_000, // 10 min (>= 10 min)
		};
		expect(buildDiscordActivity(expiredIdle, DEFAULT_CONFIG)).toBeNull();

		// idleTimeoutMinutes === 0 never hides idle presence
		const neverExpireCfg: DiscordPresenceConfig = { ...DEFAULT_CONFIG, idleTimeoutMinutes: 0 };
		expect(buildDiscordActivity(expiredIdle, neverExpireCfg)?.state).toBe("En espera");
	});

	test("buildDiscordActivity maps tools accurately in full privacy mode", () => {
		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "edit", target: "index.ts" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Editando index.ts");

		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "read", target: "README.md" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Leyendo README.md");

		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "bash" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Ejecutando comando");

		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "grep" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Explorando el código");

		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "task" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Coordinando subagentes");

		expect(
			buildDiscordActivity(
				{ ...baseState, phase: { kind: "tool", toolName: "web_search" } },
				DEFAULT_CONFIG,
			)?.state,
		).toBe("Buscando en la web");
	});

	test("buildDiscordActivity respects moderate and private privacy modes", () => {
		const toolState: SessionActivityState = {
			...baseState,
			phase: { kind: "tool", toolName: "edit", target: "secret.ts" },
		};

		const moderateCfg: DiscordPresenceConfig = { ...DEFAULT_CONFIG, privacy: "moderate" };
		const moderateAct = buildDiscordActivity(toolState, moderateCfg);
		expect(moderateAct?.details).toBe("Proyecto: omp-discord");
		expect(moderateAct?.state).toBe("Agente trabajando");
		expect(moderateAct?.name).toBe("VibeCoding");
		expect(moderateAct?.assets.small_text).toBe("Modelo: gemini-4-argon");
		expect(moderateAct?.assets.large_image).toBe("https://omp.sh/favicon-512x512.png");

		const privateCfg: DiscordPresenceConfig = { ...DEFAULT_CONFIG, privacy: "private" };
		const privateAct = buildDiscordActivity(toolState, privateCfg);
		expect(privateAct?.details).toBe("Programando con omp");
		expect(privateAct?.state).toBe("En sesión activa");
		expect(privateAct?.assets.small_text).toBeUndefined();
	});
});
