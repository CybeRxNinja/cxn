/**
 * Session leases — the daemon's ownership record for attachable sessions.
 *
 * A `cxn agents attach` acquires a lease (an `owner.json` written atomically
 * next to the session) so two clients cannot drive the same session at once.
 * The in-memory `openingSessions` set de-dupes concurrent opens and
 * `client_owned_sessions` tracks which sessions a client currently owns.
 *
 * This is a proportionate port of the upstream `session-lease.ts`: the same
 * on-disk `owner.json` + pid-liveness + no-clobber semantics, without the
 * `proper-lockfile` dependency or Windows-specific process-start-id RPC (those
 * are defense-in-depth for a cross-platform shipped product; cxn's daemon runs
 * where Bun runs). Aliveness is checked via `process.kill(pid, 0)`.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;
	constructor(
		readonly sessionPath: string,
		readonly activeOwnerId?: string,
	) {
		super(
			activeOwnerId
				? `Session is already active in ${activeOwnerId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	ownerId: string;
	sessionPath: string;
	createdAt: string;
}

/** Best-effort canonical session path (realpath when it exists). */
export function canonicalSessionPath(sessionPath: string): string {
	const resolved = path.resolve(sessionPath);
	try {
		return realpathSync(resolved);
	} catch {
		try {
			return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
		} catch {
			return resolved;
		}
	}
}

function leaseDirFor(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return path.join(agentDir, "session-leases", `${key}.lock`);
}

function readLeaseOwner(dir: string): SessionLeaseOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8")) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.ownerId !== "string" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return undefined;
		}
		return parsed as SessionLeaseOwner;
	} catch {
		return undefined;
	}
}

function isLeaseAlive(owner: SessionLeaseOwner): boolean {
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class SessionLease {
	#released = false;
	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		readonly token: string,
		private readonly registry: SessionLeaseRegistry,
	) {}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.registry.releaseLease(this.sessionPath, this.directory, this.token);
	}
}

export class SessionLeaseRegistry {
	/** De-dupes in-flight opens so the same session is never opened twice concurrently. */
	readonly openingSessions = new Set<string>();
	/** sessionPath -> ownerId for sessions currently owned by a client. */
	readonly client_owned_sessions = new Map<string, string>();

	constructor(private readonly agentDir: string) {
		mkdirSync(path.join(agentDir, "session-leases"), { recursive: true, mode: 0o700 });
	}

	/** Acquire (or re-acquire if already owned by `ownerId`) a lease for `sessionPath`. */
	async acquire(sessionPath: string, ownerId: string): Promise<SessionLease> {
		const canonical = canonicalSessionPath(sessionPath);
		if (this.openingSessions.has(canonical)) {
			throw new SessionAlreadyActiveError(canonical, this.client_owned_sessions.get(canonical));
		}
		this.openingSessions.add(canonical);
		try {
			const dir = leaseDirFor(this.agentDir, canonical);
			const existing = readLeaseOwner(dir);
			if (existing && isLeaseAlive(existing)) {
				if (existing.ownerId === ownerId) {
					return new SessionLease(canonical, dir, existing.token, this);
				}
				throw new SessionAlreadyActiveError(canonical, existing.ownerId);
			}
			if (existing) {
				await fs.rm(dir, { recursive: true, force: true });
			}
			const token = randomUUID();
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				ownerId,
				sessionPath: canonical,
				createdAt: new Date().toISOString(),
			};
			await this.#writeOwnerAtomic(dir, owner);
			this.client_owned_sessions.set(canonical, ownerId);
			return new SessionLease(canonical, dir, token, this);
		} finally {
			this.openingSessions.delete(canonical);
		}
	}

	/** True if a live lease currently exists for `sessionPath`. */
	isHeld(sessionPath: string): boolean {
		const canonical = canonicalSessionPath(sessionPath);
		const owner = readLeaseOwner(leaseDirFor(this.agentDir, canonical));
		return owner !== undefined && isLeaseAlive(owner);
	}

	/** Release a session's lease if it is owned by `ownerId`. Returns true if released. */
	async release(sessionPath: string, ownerId: string): Promise<boolean> {
		const canonical = canonicalSessionPath(sessionPath);
		const dir = leaseDirFor(this.agentDir, canonical);
		const owner = readLeaseOwner(dir);
		if (owner && owner.ownerId === ownerId) {
			await fs.rm(dir, { recursive: true, force: true });
			this.client_owned_sessions.delete(canonical);
			return true;
		}
		return false;
	}

	/** Forcibly drop a lease regardless of owner (used when reaping a dead agent). */
	async forceRelease(sessionPath: string): Promise<boolean> {
		const canonical = canonicalSessionPath(sessionPath);
		const dir = leaseDirFor(this.agentDir, canonical);
		await fs.rm(dir, { recursive: true, force: true });
		this.client_owned_sessions.delete(canonical);
		return true;
	}

	/** Release a lease if `token` matches the current owner. */
	releaseLease(sessionPath: string, directory: string, token: string): void {
		try {
			const owner = readLeaseOwner(directory);
			if (owner?.token === token) {
				fs.rm(directory, { recursive: true, force: true }).catch(() => {});
			}
		} catch {
			/* best-effort cleanup */
		}
		this.client_owned_sessions.delete(sessionPath);
	}

	reset(): void {
		this.openingSessions.clear();
		this.client_owned_sessions.clear();
	}

	/** Rebuild in-memory ownership from on-disk leases (called on daemon boot). */
	reload(): void {
		this.client_owned_sessions.clear();
		const base = path.join(this.agentDir, "session-leases");
		let entries: string[];
		try {
			entries = readdirSync(base);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!name.endsWith(".lock")) continue;
			const owner = readLeaseOwner(path.join(base, name));
			if (owner && isLeaseAlive(owner)) {
				const canonical = canonicalSessionPath(owner.sessionPath);
				this.client_owned_sessions.set(canonical, owner.ownerId);
			}
		}
	}

	async #writeOwnerAtomic(dir: string, owner: SessionLeaseOwner): Promise<void> {
		const temp = `${dir}.candidate-${process.pid}-${randomUUID()}`;
		await fs.mkdir(temp, { recursive: true, mode: 0o700 });
		try {
			await Bun.write(path.join(temp, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(temp, dir);
		} catch (error) {
			await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				// Another process won the rename; let the caller's read see it.
				return;
			}
			throw error;
		}
	}
}
