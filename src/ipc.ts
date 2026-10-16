import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscordActivity } from "./activity";

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

export function encodeFrame(opcode: IpcOpcode, payload: unknown): Buffer {
	const json = JSON.stringify(payload);
	const body = Buffer.from(json, "utf8");
	const header = Buffer.alloc(8);
	header.writeUInt32LE(opcode, 0);
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

export function decodeFrames(buffer: Buffer): { frames: IpcFrame[]; remainder: Buffer } {
	const frames: IpcFrame[] = [];
	let offset = 0;

	while (offset + 8 <= buffer.length) {
		const opcode = buffer.readUInt32LE(offset) as IpcOpcode;
		const length = buffer.readUInt32LE(offset + 4);
		if (offset + 8 + length > buffer.length) {
			break;
		}
		const rawJson = buffer.subarray(offset + 8, offset + 8 + length).toString("utf8");
		offset += 8 + length;

		try {
			const parsed = JSON.parse(rawJson) as unknown;
			if (parsed && typeof parsed === "object") {
				frames.push({ opcode, payload: parsed as Record<string, unknown> });
			}
		} catch {
			// Skip malformed frame payload without crashing stream
		}
	}

	return {
		frames,
		remainder: buffer.subarray(offset),
	};
}

export function getCandidateIpcPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (platform === "win32") {
		const pipes: string[] = [];
		for (let i = 0; i < 10; i++) {
			pipes.push(`\\\\?\\pipe\\discord-ipc-${i}`);
		}
		return pipes;
	}

	const baseDirs: string[] = [];
	const seenDirs: Record<string, true> = {};
	for (const key of ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]) {
		const val = env[key]?.trim();
		if (val && !seenDirs[val]) {
			seenDirs[val] = true;
			baseDirs.push(val);
		}
	}
	if (!seenDirs["/tmp"]) {
		baseDirs.push("/tmp");
	}
	const candidates: string[] = [];
	for (const dir of baseDirs) {
		for (let i = 0; i < 10; i++) {
			candidates.push(path.posix.join(dir, `discord-ipc-${i}`));
			candidates.push(path.posix.join(dir, "app/com.discordapp.Discord", `discord-ipc-${i}`));
			candidates.push(path.posix.join(dir, "snap.discord", `discord-ipc-${i}`));
		}
	}
	return candidates;
}

export interface DiscordIpcClientOptions {
	clientId: string;
	candidatePaths?: string[];
	minUpdateIntervalMs?: number;
	pid?: number;
	now?: () => number;
	logger?: { debug?: (msg: string, meta?: unknown) => void };
	scheduleTimeout?: (fn: () => void, ms: number) => unknown;
	clearScheduledTimeout?: (handle: unknown) => void;
}

export interface IpcClientLike {
	isConnected(): boolean;
	connect(): Promise<boolean>;
	setClientId(clientId: string): Promise<boolean>;
	setActivity(activity: DiscordActivity | null): Promise<void>;
	clearActivity(): Promise<void>;
	close(): Promise<void>;
}

export class DiscordIpcClient implements IpcClientLike {
	#clientId: string;
	#candidatePaths?: string[];
	#minUpdateIntervalMs: number;
	#pid: number;
	#now: () => number;
	#logger?: { debug?: (msg: string, meta?: unknown) => void };
	#scheduleTimeout: (fn: () => void, ms: number) => unknown;
	#clearScheduledTimeout: (handle: unknown) => void;

	#socket: net.Socket | null = null;
	#ready = false;
	#connecting: Promise<boolean> | null = null;
	#readBuffer: Buffer = Buffer.alloc(0);
	#nonceCounter = 0;

	#lastSentMs = 0;
	#pendingActivity: DiscordActivity | null | undefined = undefined;
	#throttleTimer: unknown = undefined;

	constructor(options: DiscordIpcClientOptions) {
		this.#clientId = options.clientId;
		this.#candidatePaths = options.candidatePaths;
		this.#minUpdateIntervalMs = options.minUpdateIntervalMs ?? 2_000;
		this.#pid = options.pid ?? process.pid;
		this.#now = options.now ?? (() => Date.now());
		this.#logger = options.logger;
		this.#scheduleTimeout =
			options.scheduleTimeout ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return timer;
			});
		this.#clearScheduledTimeout =
			options.clearScheduledTimeout ??
			(handle => {
				clearTimeout(handle as NodeJS.Timeout);
			});
	}

	isConnected(): boolean {
		return this.#ready && this.#socket !== null && !this.#socket.destroyed;
	}

	async connect(): Promise<boolean> {
		if (this.isConnected()) return true;
		if (this.#connecting) return this.#connecting;

		this.#connecting = this.#connectAny();
		try {
			return await this.#connecting;
		} finally {
			this.#connecting = null;
		}
	}

	async setClientId(clientId: string): Promise<boolean> {
		const trimmed = clientId.trim();
		if (!trimmed) return false;
		if (this.#clientId === trimmed && this.isConnected()) {
			return true;
		}
		this.#clientId = trimmed;
		await this.close();
		return this.connect();
	}

	async setActivity(activity: DiscordActivity | null): Promise<void> {
		this.#pendingActivity = activity;

		if (!this.isConnected()) {
			const connected = await this.connect();
			if (!connected) return;
		}

		const now = this.#now();
		const elapsed = now - this.#lastSentMs;

		if (this.#lastSentMs === 0 || elapsed >= this.#minUpdateIntervalMs) {
			if (this.#throttleTimer !== undefined) {
				this.#clearScheduledTimeout(this.#throttleTimer);
				this.#throttleTimer = undefined;
			}
			const nextActivity = this.#pendingActivity;
			this.#pendingActivity = undefined;
			this.#lastSentMs = now;
			await this.#sendActivityFrame(nextActivity ?? null);
			return;
		}

		if (this.#throttleTimer === undefined) {
			const remainingMs = Math.max(1, this.#minUpdateIntervalMs - elapsed);
			this.#throttleTimer = this.#scheduleTimeout(() => {
				this.#throttleTimer = undefined;
				if (this.#pendingActivity === undefined || !this.isConnected()) return;
				const nextActivity = this.#pendingActivity;
				this.#pendingActivity = undefined;
				this.#lastSentMs = this.#now();
				void this.#sendActivityFrame(nextActivity);
			}, remainingMs);
		}
	}

	async clearActivity(): Promise<void> {
		if (this.#throttleTimer !== undefined) {
			this.#clearScheduledTimeout(this.#throttleTimer);
			this.#throttleTimer = undefined;
		}
		this.#pendingActivity = undefined;
		if (!this.isConnected()) return;
		this.#lastSentMs = this.#now();
		await this.#sendActivityFrame(null);
	}

	async close(): Promise<void> {
		if (this.#throttleTimer !== undefined) {
			this.#clearScheduledTimeout(this.#throttleTimer);
			this.#throttleTimer = undefined;
		}
		this.#pendingActivity = undefined;
		this.#ready = false;
		this.#readBuffer = Buffer.alloc(0);

		const socket = this.#socket;
		this.#socket = null;
		if (!socket || socket.destroyed) return;

		const { promise, resolve } = Promise.withResolvers<void>();
		socket.once("close", () => resolve());
		try {
			socket.end();
			socket.destroy();
		} catch {
			resolve();
		}
		await promise;
	}

	async #connectAny(): Promise<boolean> {
		const paths = this.#candidatePaths ?? getCandidateIpcPaths();
		for (const socketPath of paths) {
			const ok = await this.#tryConnectPath(socketPath);
			if (ok) return true;
		}
		return false;
	}

	async #tryConnectPath(socketPath: string): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let settled = false;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let socket: net.Socket;
		try {
			socket = net.createConnection(socketPath);
		} catch {
			return false;
		}

		let localBuffer: Buffer = Buffer.alloc(0);

		const onError = (err: Error) => {
			this.#logger?.debug?.("Discord IPC socket error", { socketPath, error: err.message });
			if (this.#socket === socket) {
				this.#ready = false;
				this.#socket = null;
			}
			try {
				socket.destroy();
			} catch {
				// Ignore destroy errors
			}
			finish(false);
		};

		const onClose = () => {
			if (this.#socket === socket) {
				this.#ready = false;
				this.#socket = null;
			}
			finish(false);
		};

		const onData = (chunk: Buffer | string) => {
			try {
				const bufChunk = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
				if (!this.#ready) {
					localBuffer = Buffer.concat([localBuffer, bufChunk]);
					const { frames, remainder } = decodeFrames(localBuffer);
					localBuffer = remainder;

					for (const frame of frames) {
						if (frame.opcode === IpcOpcode.CLOSE) {
							onError(new Error("Discord IPC closed handshake"));
							return;
						}
						if (
							frame.opcode === IpcOpcode.FRAME &&
							frame.payload.cmd === "DISPATCH" &&
							frame.payload.evt === "READY"
						) {
							this.#socket = socket;
							this.#ready = true;
							this.#readBuffer = localBuffer;
							finish(true);
						} else if (frame.opcode === IpcOpcode.PING) {
							this.#writeSafe(socket, encodeFrame(IpcOpcode.PONG, frame.payload));
						}
					}
					return;
				}

				this.#readBuffer = Buffer.concat([this.#readBuffer, bufChunk]);
				const { frames, remainder } = decodeFrames(this.#readBuffer);
				this.#readBuffer = remainder;

				for (const frame of frames) {
					if (frame.opcode === IpcOpcode.PING) {
						this.#writeSafe(socket, encodeFrame(IpcOpcode.PONG, frame.payload));
					} else if (frame.opcode === IpcOpcode.CLOSE) {
						this.#ready = false;
						this.#socket = null;
						try {
							socket.destroy();
						} catch {
							// Ignore destroy error
						}
					}
				}
			} catch (err) {
				this.#logger?.debug?.("Discord IPC data parse error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		socket.on("error", onError);
		socket.on("close", onClose);
		socket.on("data", onData);

		socket.once("connect", () => {
			const handshakeFrame = encodeFrame(IpcOpcode.HANDSHAKE, {
				v: 1,
				client_id: this.#clientId,
			});
			this.#writeSafe(socket, handshakeFrame);
		});

		return promise;
	}

	async #sendActivityFrame(activity: DiscordActivity | null): Promise<void> {
		if (!this.isConnected() || !this.#socket) return;
		this.#nonceCounter += 1;
		const frame = encodeFrame(IpcOpcode.FRAME, {
			cmd: "SET_ACTIVITY",
			args: {
				pid: this.#pid,
				activity,
			},
			nonce: `omp-discord-${this.#pid}-${this.#nonceCounter}`,
		});
		await this.#writeSafeAsync(this.#socket, frame);
	}

	#writeSafe(socket: net.Socket, data: Buffer): void {
		try {
			if (!socket.destroyed && socket.writable) {
				socket.write(data);
			}
		} catch (err) {
			this.#logger?.debug?.("Discord IPC write error", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #writeSafeAsync(socket: net.Socket, data: Buffer): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			if (!socket.destroyed && socket.writable) {
				socket.write(data, () => resolve());
			} else {
				resolve();
			}
		} catch {
			resolve();
		}
		await promise;
	}
}
