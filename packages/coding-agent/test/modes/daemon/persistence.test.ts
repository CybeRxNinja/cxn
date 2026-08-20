import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RlmSubagentRegistryEntry, resetRlmFamilies } from "@cyberxninja-omp/pi-coding-agent/eval/py/family-store";
import {
	DaemonClient,
	handleDaemonRequest,
	inMemoryPair,
	resetDaemonState,
	serveConnection,
	setupDaemonState,
	startDaemonHeartbeat,
	stopDaemonHeartbeat,
} from "@cyberxninja-omp/pi-coding-agent/modes/daemon/index";

const FAMILY = "fam-persist";

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

/** Simulate a daemon restart: drop in-memory state, then re-bootstrap from disk. */
function restart(tmp: string): void {
	resetDaemonState();
	setupDaemonState({ agentDir: tmp });
}

function connect() {
	const { server, client } = inMemoryPair();
	void serveConnection(server, handleDaemonRequest);
	return new DaemonClient(client);
}

interface LedgerSnapshot {
	edges: Array<{ childId: string; status: string }>;
}

describe("daemon durability (Phase 6)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-daemon-persist-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(() => {
		stopDaemonHeartbeat();
		resetDaemonState();
		resetRlmFamilies();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("persists the spawn ledger across a daemon restart", async () => {
		const conn = connect();
		await conn.request("rlm.register_child", { entry: childEntry("rlm-p1", "kid") }, { role: "parent" }, FAMILY);

		// Durable snapshot written to disk.
		expect(fs.existsSync(path.join(tmp, "rlm-ledger.json"))).toBe(true);

		// Restart: in-memory state is dropped, then reloaded from the snapshot.
		restart(tmp);
		const conn2 = connect();
		const list = (await conn2.request("rlm.list_subagents", {}, { role: "parent" }, FAMILY)) as {
			subagents: Array<{ rlm_child_id: string; status: string }>;
		};
		expect(list.subagents.map(s => s.rlm_child_id)).toContain("rlm-p1");
		expect(list.subagents.find(s => s.rlm_child_id === "rlm-p1")?.status).toBe("running");
	});

	it("persists a session lease across a daemon restart and still rejects a second owner", async () => {
		const conn = connect();
		const attach = (await conn.request(
			"session.attach",
			{ session_dir: "/tmp/lease-sess" },
			{ role: "parent" },
			FAMILY,
		)) as { attached: boolean };
		expect(attach.attached).toBe(true);

		// The lease is durably written next to the session.
		const leaseDir = path.join(tmp, "session-leases");
		expect(fs.readdirSync(leaseDir).filter(n => n.endsWith(".lock"))).toHaveLength(1);

		// Restart: on-disk lease is reloaded into the in-memory registry.
		restart(tmp);
		const conn2 = connect();

		// A different owner must be rejected because the lease is still held by parent.
		// DaemonClient.request throws on a non-ok response, so assert the rejection.
		await expect(
			conn2.request(
				"session.attach",
				{ session_dir: "/tmp/lease-sess" },
				{ role: "child", childId: "intruder" },
				FAMILY,
			),
		).rejects.toThrow(/active|lease/i);
	});

	it("persists undelivered mailboxes across a daemon restart", async () => {
		const conn = connect();
		await conn.request("rlm.register_child", { entry: childEntry("rlm-pm", "kid") }, { role: "parent" }, FAMILY);
		const sent = (await conn.request(
			"agent_message.send",
			{ message: "survive this", receiver_role: "child", receiver_name: "rlm-pm" },
			{ role: "parent" },
			FAMILY,
		)) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		// Mailbox durably written to disk.
		expect(fs.existsSync(path.join(tmp, "mailboxes", `${FAMILY}.json`))).toBe(true);

		// Restart: mailbox reloaded into the in-memory family store.
		restart(tmp);
		const conn2 = connect();
		const got = (await conn2.request("agent_message.recv", {}, { role: "child", childId: "rlm-pm" }, FAMILY)) as {
			messages: Array<{ message: string; from: string }>;
		};
		expect(got.messages).toHaveLength(1);
		expect(got.messages[0]?.message).toBe("survive this");
	});

	it("persists the reaper's completed status across a daemon restart", async () => {
		const conn = connect();
		await conn.request("rlm.register_child", { entry: childEntry("rlm-stale", "kid") }, { role: "parent" }, FAMILY);

		// Run the real daemon heartbeat reaper (ttl 0 -> everything is stale).
		startDaemonHeartbeat({ intervalMs: 5, ttlMs: 0 });
		let completed = false;
		for (let i = 0; i < 50 && !completed; i++) {
			await Bun.sleep(5);
			try {
				const snap = JSON.parse(fs.readFileSync(path.join(tmp, "rlm-ledger.json"), "utf8")) as LedgerSnapshot;
				completed = snap.edges.some(e => e.childId === "rlm-stale" && e.status === "completed");
			} catch {
				/* not flushed yet */
			}
		}
		stopDaemonHeartbeat();
		expect(completed).toBe(true);

		// Restart should reflect the reaped (completed) status, not a fresh running one.
		restart(tmp);
		const conn2 = connect();
		const list = (await conn2.request("rlm.list_subagents", {}, { role: "parent" }, FAMILY)) as {
			subagents: Array<{ rlm_child_id: string; status: string }>;
		};
		expect(list.subagents.find(s => s.rlm_child_id === "rlm-stale")?.status).toBe("completed");
	});
});
