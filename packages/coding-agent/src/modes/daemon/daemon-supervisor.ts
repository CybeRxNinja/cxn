/**
 * Daemon supervisor — ensures exactly one daemon is running per user and hands
 * back a connected DaemonClient.
 *
 * ensureDaemonRunning is idempotent: if a live lock + socket exist it just
 * connects; otherwise it spawns the daemon (default: the cxn CLI in
 * --mode daemon) and waits for the socket. The spawn is injectable so tests
 * can boot an in-process server instead of a real subprocess.
 */

import * as fs from "node:fs/promises";
import { handleDaemonRequest } from "./daemon-family-store";
import { daemonSocketPath, readDaemonLock, removeDaemonLock, writeDaemonLock } from "./daemon-socket";
import { type DaemonClient, udsConnect } from "./daemon-transport";

export interface DaemonHandle {
	socketPath: string;
	client: DaemonClient;
	stop: () => Promise<void>;
}

/** Boots a daemon process on socketPath and returns a stopper. */
export type SpawnDaemonFn = (socketPath: string) => Promise<{ stop: () => Promise<void> }>;

const cliUrl = new URL("../../cli.ts", import.meta.url);

/** Default spawn: launch the cxn CLI in daemon mode over the given UDS socket. */
export async function spawnCliDaemon(socketPath: string): Promise<{ stop: () => Promise<void> }> {
	const proc = Bun.spawn([process.execPath, cliUrl.pathname, "--mode", "daemon", "--daemon-socket", socketPath], {
		stdout: "ignore",
		stderr: "ignore",
		env: { ...process.env },
	});
	return {
		stop: async () => {
			proc.kill();
			try {
				await fs.unlink(socketPath);
			} catch {
				/* already gone */
			}
		},
	};
}

export interface EnsureDaemonOptions {
	socketPath?: string;
	spawn?: SpawnDaemonFn;
	/** How long to wait for the socket to come up after spawn (ms). */
	timeoutMs?: number;
}

export async function ensureDaemonRunning(opts: EnsureDaemonOptions = {}): Promise<DaemonHandle> {
	const socketPath = opts.socketPath ?? daemonSocketPath();
	const spawn = opts.spawn ?? spawnCliDaemon;
	const timeoutMs = opts.timeoutMs ?? 5000;

	const lock = await readDaemonLock(socketPath);
	if (lock) {
		try {
			const client = await udsConnect(socketPath);
			// We joined an already-running daemon: closing our connection is enough;
			// leave its socket + lockfile + process untouched.
			return {
				socketPath,
				client,
				stop: async () => {
					await client.close();
				},
			};
		} catch {
			// stale lock / dead socket -- clean up and respawn
			await removeDaemonLock(socketPath);
		}
	}

	const srv = await spawn(socketPath);
	await writeDaemonLock({ pid: process.pid, socketPath, startedAt: new Date().toISOString() });
	const client = await waitForConnect(socketPath, timeoutMs);
	return {
		socketPath,
		client,
		stop: async () => {
			await srv.stop();
			await removeDaemonLock(socketPath);
		},
	};
}

async function waitForConnect(socketPath: string, timeoutMs: number): Promise<DaemonClient> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await udsConnect(socketPath);
		} catch (e) {
			lastErr = e;
			await Bun.sleep(50);
		}
	}
	throw new Error(
		`daemon did not come up at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
	);
}

export async function stopDaemon(socketPath: string = daemonSocketPath()): Promise<void> {
	await removeDaemonLock(socketPath);
	try {
		await fs.unlink(socketPath);
	} catch {
		/* not present */
	}
}

export { handleDaemonRequest };
