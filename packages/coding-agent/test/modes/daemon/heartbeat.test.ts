import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RlmSubagentRegistryEntry, resetRlmFamilies } from "@cxn/pi-coding-agent/eval/py/family-store";
import { HeartbeatCatalog } from "@cxn/pi-coding-agent/modes/daemon/heartbeat-catalog";
import {
	handleDaemonRequest,
	reapStaleAgents,
	resetDaemonState,
	setupDaemonState,
	startDaemonHeartbeat,
	stopDaemonHeartbeat,
} from "@cxn/pi-coding-agent/modes/daemon/index";

function childEntry(id: string, name: string): RlmSubagentRegistryEntry {
	return {
		rlm_child_id: id,
		active_session_id: null,
		session_id: null,
		session_name: name,
		session_dir: `/tmp/${id}`,
		status: "running",
	};
}

describe("HeartbeatCatalog", () => {
	it("reports ids older than the ttl relative to a given now", () => {
		const h = new HeartbeatCatalog();
		h.touch("a", 1000);
		h.touch("b", 5000);
		// a is 4500ms old, b is 500ms old at now=5500 → only a is stale.
		expect(h.staleIds(1000, 5500)).toEqual(["a"]);
		// Both are stale once the window passes b's last-seen.
		expect(h.staleIds(1000, 6001)).toEqual(["a", "b"]);
		h.remove("a");
		expect(h.staleIds(1000, 6001)).toEqual(["b"]);
		h.reset();
		expect(h.staleIds(1000, 6001)).toEqual([]);
	});
});

describe("daemon reaper", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-reap-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(() => {
		resetDaemonState();
		resetRlmFamilies();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("reaps a registered child past its ttl and marks its ledger edge completed", async () => {
		await handleDaemonRequest({
			id: "1",
			familyId: "fam",
			from: { role: "parent" },
			command: "rlm.register_child",
			payload: { entry: childEntry("c1", "Kid") },
		});
		// Freshly touched → not stale under a real ttl.
		expect(reapStaleAgents(60_000)).toEqual([]);
		// ttl 0 → everything stale → the child is reaped.
		expect(reapStaleAgents(0)).toEqual(["c1"]);

		const list = await handleDaemonRequest({
			id: "2",
			familyId: "fam",
			from: { role: "parent" },
			command: "rlm.list_subagents",
			payload: {},
		});
		const subagents = (list.result as { subagents: Array<{ rlm_child_id: string; status: string }> }).subagents;
		expect(subagents.find(s => s.rlm_child_id === "c1")?.status).toBe("completed");
	});

	it("releases the reaped child's session lease", async () => {
		await handleDaemonRequest({
			id: "1",
			familyId: "fam",
			from: { role: "parent" },
			command: "rlm.register_child",
			payload: { entry: childEntry("c2", "Kid2") },
		});
		await handleDaemonRequest({
			id: "2",
			familyId: "fam",
			from: { role: "parent" },
			command: "session.attach",
			payload: { session_dir: "/tmp/c2" },
		});
		expect(reapStaleAgents(0)).toContain("c2");
		// The lease for /tmp/c2 is now free to be acquired again.
		const reattach = await handleDaemonRequest({
			id: "3",
			familyId: "fam",
			from: { role: "parent" },
			command: "session.attach",
			payload: { session_dir: "/tmp/c2" },
		});
		expect((reattach.result as { attached: boolean }).attached).toBe(true);
	});
});

describe("daemon heartbeat loop", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-hb-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(() => {
		stopDaemonHeartbeat();
		resetDaemonState();
		resetRlmFamilies();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("automatically reaps stale agents on the interval", async () => {
		await handleDaemonRequest({
			id: "1",
			familyId: "fam",
			from: { role: "parent" },
			command: "rlm.register_child",
			payload: { entry: childEntry("c3", "Kid3") },
		});
		// ttl 0 reaps everything on every tick.
		startDaemonHeartbeat({ intervalMs: 20, ttlMs: 0 });
		await Bun.sleep(100);
		stopDaemonHeartbeat();

		const list = await handleDaemonRequest({
			id: "2",
			familyId: "fam",
			from: { role: "parent" },
			command: "rlm.list_subagents",
			payload: {},
		});
		const subagents = (list.result as { subagents: Array<{ rlm_child_id: string; status: string }> }).subagents;
		expect(subagents.find(s => s.rlm_child_id === "c3")?.status).toBe("completed");
	});

	it("start is idempotent and stop is safe to call repeatedly", () => {
		startDaemonHeartbeat({ intervalMs: 10, ttlMs: 0 });
		startDaemonHeartbeat({ intervalMs: 10, ttlMs: 0 });
		stopDaemonHeartbeat();
		expect(() => stopDaemonHeartbeat()).not.toThrow();
	});
});
