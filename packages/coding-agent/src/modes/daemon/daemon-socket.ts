/**
 * Daemon socket + lockfile location and helpers.
 *
 * The daemon listens on a per-user Unix-domain socket under
 * `$XDG_RUNTIME_DIR/cxn` (falling back to `$TMPDIR`). A companion `.lock`
 * file records the owning pid + socket path so a client can discover a
 * running daemon and a relaunched supervisor can tell a stale socket from a
 * live one.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface DaemonLock {
	pid: number;
	socketPath: string;
	startedAt: string;
}

/** Default per-user daemon socket path. */
export function daemonSocketPath(): string {
	const runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const uid = process.getuid?.() ?? 0;
	return path.join(runtime, "cxn", `daemon-${uid}.sock`);
}

export function daemonLockPath(socketPath: string = daemonSocketPath()): string {
	return `${socketPath}.lock`;
}

export async function writeDaemonLock(lock: DaemonLock): Promise<void> {
	const p = daemonLockPath(lock.socketPath);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, JSON.stringify(lock), { mode: 0o600 });
}

export async function readDaemonLock(socketPath: string = daemonSocketPath()): Promise<DaemonLock | null> {
	try {
		return JSON.parse(await fs.readFile(daemonLockPath(socketPath), "utf8")) as DaemonLock;
	} catch {
		return null;
	}
}

export async function removeDaemonLock(socketPath: string = daemonSocketPath()): Promise<void> {
	try {
		await fs.unlink(daemonLockPath(socketPath));
	} catch {
		/* not present */
	}
}
