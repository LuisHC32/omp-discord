import { afterEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscordActivity } from "../src/activity";
import {
	DiscordIpcClient,
	decodeFrames,
	encodeFrame,
	getCandidateIpcPaths,
	type IpcFrame,
	IpcOpcode,
} from "../src/ipc";

function makeTestSocketPath(): string {
	const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	if (process.platform === "win32") {
		return `\\\\?\\pipe\\omp-discord-test-${id}`;
	}
	return path.join(os.tmpdir(), `omp-discord-test-${id}.sock`);
}

const sampleActivity: DiscordActivity = {
	details: "Proyecto: omp-discord",
	state: "Editando index.ts",
	timestamps: { start: 1_700_000_000 },
	assets: {
		large_image: "code",
		large_text: "Oh My Pi (omp)",
		small_text: "Modelo: gemini-4-argon",
	},
};

interface SetActivityArgs {
	pid: number;
	activity: DiscordActivity | null;
}

describe("ipc", () => {
	const servers: net.Server[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			const server = servers.pop()!;
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			await promise;
		}
	});

	test("encodeFrame and decodeFrames handle single, concatenated, and partial frames", () => {
		const f1 = encodeFrame(IpcOpcode.HANDSHAKE, { v: 1, client_id: "123" });
		const f2 = encodeFrame(IpcOpcode.FRAME, { cmd: "SET_ACTIVITY", nonce: "n1" });

		const single = decodeFrames(f1);
		expect(single.frames).toHaveLength(1);
		expect(single.frames[0]).toEqual({
			opcode: IpcOpcode.HANDSHAKE,
			payload: { v: 1, client_id: "123" },
		});
		expect(single.remainder.length).toBe(0);

		const partialTail = f2.subarray(0, 5);
		const combined = Buffer.concat([f1, f2, partialTail]);
		const decoded = decodeFrames(combined);
		expect(decoded.frames).toHaveLength(2);
		expect(decoded.frames[1].opcode).toBe(IpcOpcode.FRAME);
		expect(decoded.frames[1].payload.cmd).toBe("SET_ACTIVITY");
		expect(decoded.remainder).toEqual(partialTail);
	});

	test("getCandidateIpcPaths generates pipes on win32 and socket paths on unix", () => {
		const winPaths = getCandidateIpcPaths("win32", {});
		expect(winPaths[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
		expect(winPaths[9]).toBe("\\\\?\\pipe\\discord-ipc-9");

		const unixPaths = getCandidateIpcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });
		expect(unixPaths).toContain("/run/user/1000/discord-ipc-0");
	});

	test("DiscordIpcClient performs handshake, sends SET_ACTIVITY, throttles deterministically, replies PONG to PING, and clears on shutdown", async () => {
		const sockPath = makeTestSocketPath();
		const receivedFrames: IpcFrame[] = [];
		const frameWaiters: Array<() => void> = [];
		let serverSocket: net.Socket | undefined;

		function waitForFrameCount(targetCount: number): Promise<void> {
			if (receivedFrames.length >= targetCount) {
				return Promise.resolve();
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			const check = () => {
				if (receivedFrames.length >= targetCount) {
					resolve();
				} else {
					frameWaiters.push(check);
				}
			};
			frameWaiters.push(check);
			return promise;
		}

		const server = net.createServer(socket => {
			serverSocket = socket;
			let buf: Buffer = Buffer.alloc(0);
			socket.on("data", chunk => {
				buf = Buffer.concat([buf, Buffer.from(chunk)]);
				const { frames, remainder } = decodeFrames(buf);
				buf = remainder;
				for (const frame of frames) {
					receivedFrames.push(frame);
					if (frame.opcode === IpcOpcode.HANDSHAKE) {
						socket.write(
							encodeFrame(IpcOpcode.FRAME, {
								cmd: "DISPATCH",
								evt: "READY",
								data: { v: 1 },
							}),
						);
					} else if (frame.opcode === IpcOpcode.FRAME && frame.payload.cmd === "SET_ACTIVITY") {
						socket.write(
							encodeFrame(IpcOpcode.FRAME, {
								cmd: "SET_ACTIVITY",
								evt: null,
								nonce: frame.payload.nonce,
								data: {},
							}),
						);
					}
					const waiters = frameWaiters.splice(0, frameWaiters.length);
					for (const notify of waiters) notify();
				}
			});
		});
		servers.push(server);

		const listenReady = Promise.withResolvers<void>();
		server.listen(sockPath, () => listenReady.resolve());
		await listenReady.promise;

		let fakeNow = 10_000;
		let scheduledCallback: (() => void) | undefined;

		const client = new DiscordIpcClient({
			clientId: "782685898163617802",
			candidatePaths: [sockPath],
			minUpdateIntervalMs: 2_000,
			pid: 4242,
			now: () => fakeNow,
			scheduleTimeout: fn => {
				scheduledCallback = fn;
				return "timer-1";
			},
			clearScheduledTimeout: () => {
				scheduledCallback = undefined;
			},
		});

		const connected = await client.connect();
		expect(connected).toBe(true);
		expect(client.isConnected()).toBe(true);
		expect(receivedFrames[0]).toEqual({
			opcode: IpcOpcode.HANDSHAKE,
			payload: { v: 1, client_id: "782685898163617802" },
		});

		// First activity is sent immediately
		await client.setActivity(sampleActivity);
		await waitForFrameCount(2);
		const firstArgs = receivedFrames[1].payload.args as SetActivityArgs;
		expect(firstArgs.pid).toBe(4242);
		expect(firstArgs.activity).toEqual(sampleActivity);

		// Two rapid updates within 2000ms window are coalesced into scheduled timer
		fakeNow = 10_500;
		await client.setActivity({ ...sampleActivity, state: "Paso intermedio" });
		await client.setActivity({ ...sampleActivity, state: "Estado final" });
		expect(receivedFrames).toHaveLength(2);
		expect(scheduledCallback).toBeDefined();

		// Advance clock and fire scheduled callback -> sends only "Estado final"
		fakeNow = 12_000;
		const cb = scheduledCallback!;
		scheduledCallback = undefined;
		cb();
		await waitForFrameCount(3);

		const secondArgs = receivedFrames[2].payload.args as SetActivityArgs;
		expect(secondArgs.activity?.state).toBe("Estado final");

		// Server sends PING -> client responds with PONG
		serverSocket!.write(encodeFrame(IpcOpcode.PING, { ping: 1 }));
		await waitForFrameCount(4);
		const pongFrame = receivedFrames.find(f => f.opcode === IpcOpcode.PONG);
		expect(pongFrame).toBeDefined();
		expect(pongFrame?.payload).toEqual({ ping: 1 });

		// clearActivity bypasses throttle and sends null immediately
		await client.clearActivity();
		await waitForFrameCount(5);
		const clearArgs = receivedFrames[4].payload.args as SetActivityArgs;
		expect(clearArgs.activity).toBeNull();

		await client.close();
		expect(client.isConnected()).toBe(false);
	});

	test("DiscordIpcClient returns false cleanly when no IPC socket is available", async () => {
		const client = new DiscordIpcClient({
			clientId: "782685898163617802",
			candidatePaths: [makeTestSocketPath()],
		});
		const connected = await client.connect();
		expect(connected).toBe(false);
		expect(client.isConnected()).toBe(false);
	});
});
