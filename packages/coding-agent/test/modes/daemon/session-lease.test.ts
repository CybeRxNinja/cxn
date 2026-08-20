import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalSessionPath,
	SessionAlreadyActiveError,
	SessionLeaseRegistry,
} from "@cyberxninja-omp/pi-coding-agent/modes/daemon/session-lease";

let tmp: string;
afterEach(() => {
	if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function leaseDirFor(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(canonicalSessionPath(sessionPath)).digest("hex");
	return path.join(agentDir, "session-leases", `${key}.lock`);
}

describe("SessionLeaseRegistry", () => {
	afterEach(() => {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("acquires a lease (writes owner.json) and re-acquires for the same owner", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-lease-"));
		const reg = new SessionLeaseRegistry(tmp);
		const dir = path.join(tmp, "sess-1");

		const lease = await reg.acquire(dir, "owner1");
		expect(lease.sessionPath).toBe(canonicalSessionPath(dir));
		expect(fs.existsSync(path.join(leaseDirFor(tmp, dir), "owner.json"))).toBe(true);

		// Same owner re-acquiring returns a live lease (no throw).
		const again = await reg.acquire(dir, "owner1");
		expect(again.token).toBe(lease.token);

		await lease.release();
		expect(reg.isHeld(dir)).toBe(false);
	});

	it("refuses a second attach by a different owner while held", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-lease-"));
		const reg = new SessionLeaseRegistry(tmp);
		const dir = path.join(tmp, "sess-2");

		await reg.acquire(dir, "owner1");
		await expect(reg.acquire(dir, "owner2")).rejects.toBeInstanceOf(SessionAlreadyActiveError);
	});

	it("reclaims a stale lease whose owner process is dead", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-lease-"));
		const reg = new SessionLeaseRegistry(tmp);
		const dir = path.join(tmp, "sess-3");
		const ldir = leaseDirFor(tmp, dir);
		fs.mkdirSync(ldir, { recursive: true });
		// A pid that cannot be alive.
		fs.writeFileSync(
			path.join(ldir, "owner.json"),
			`${JSON.stringify({ version: 1, token: "t", pid: 999999, ownerId: "ghost", sessionPath: dir, createdAt: new Date().toISOString() })}\n`,
		);
		expect(reg.isHeld(dir)).toBe(false);
		// Acquiring reclaims the dead lease for the new owner.
		const lease = await reg.acquire(dir, "owner2");
		expect(lease.token).toBeDefined();
		await lease.release();
	});
});
