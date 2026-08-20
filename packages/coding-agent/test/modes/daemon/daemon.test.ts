import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RlmSubagentRegistryEntry, resetRlmFamilies } from "@cyberxninja-omp/pi-coding-agent/eval/py/family-store";
import {
	DaemonClient,
	ensureDaemonRunning,
	handleDaemonRequest,
	inMemoryPair,
	resetDaemonState,
	serveConnection,
	setupDaemonState,
	udsConnect,
	udsServer,
} from "@cyberxninja-omp/pi-coding-agent/modes/daemon/index";

const FAMILY = "fam-test";

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

describe("daemon protocol + shared store", () => {
	beforeEach(() => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-daemon-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(() => {
		resetDaemonState();
		resetRlmFamilies();
	});

	it("delivers a parent->child message the child drains via the daemon", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);

		await conn.request("rlm.register_child", { entry: childEntry("rlm-c1", "kid") }, { role: "parent" }, FAMILY);
		const sent = (await conn.request(
			"agent_message.send",
			{ message: "hi kid", receiver_role: "child", receiver_name: "rlm-c1" },
			{ role: "parent" },
			FAMILY,
		)) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		const got = (await conn.request("agent_message.recv", {}, { role: "child", childId: "rlm-c1" }, FAMILY)) as {
			messages: Array<{ message: string; from: string }>;
		};
		expect(got.messages).toHaveLength(1);
		expect(got.messages[0]?.message).toBe("hi kid");
		expect(got.messages[0]?.from).toBe("parent");

		await conn.close();
	});

	it("reflects registered children in list_subagents and session.list", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);

		await conn.request("rlm.register_child", { entry: childEntry("rlm-a", "a") }, { role: "parent" }, FAMILY);
		await conn.request("rlm.register_child", { entry: childEntry("rlm-b", "b") }, { role: "parent" }, FAMILY);

		const subs = (await conn.request("rlm.list_subagents", {}, { role: "parent" }, FAMILY)) as {
			subagents: Array<{ rlm_child_id: string; session_name: string }>;
		};
		expect(subs.subagents.map(s => s.rlm_child_id).sort()).toEqual(["rlm-a", "rlm-b"]);

		const roster = (await conn.request("session.list", {}, { role: "parent" }, FAMILY)) as {
			agents: Array<{ id: string; role: string }>;
		};
		expect(roster.agents.map(a => a.id)).toContain("rlm-a");

		await conn.close();
	});

	it("refuses sibling reach and unknown children with clear errors", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);

		await conn.request("rlm.register_child", { entry: childEntry("rlm-c1", "kid") }, { role: "parent" }, FAMILY);

		await expect(
			conn.request("agent_message.send", { message: "x", receiver_role: "sibling" }, { role: "parent" }, FAMILY),
		).rejects.toThrow();

		await expect(
			conn.request(
				"agent_message.send",
				{ message: "x", receiver_role: "child", receiver_name: "nope" },
				{ role: "parent" },
				FAMILY,
			),
		).rejects.toThrow();

		await conn.close();
	});

	it("answers find_models against the bundled catalog", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);
		const res = (await conn.request("find_models", { query: "gpt" }, { role: "parent" }, FAMILY)) as {
			models: unknown[];
		};
		expect(Array.isArray(res.models)).toBe(true);
		await conn.close();
	});

	it("delivers a sibling message (child -> sibling) through the nuclear-family reach", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);

		await conn.request("rlm.register_child", { entry: childEntry("rlm-a", "a") }, { role: "parent" }, FAMILY);
		await conn.request("rlm.register_child", { entry: childEntry("rlm-b", "b") }, { role: "parent" }, FAMILY);

		const sent = (await conn.request(
			"agent_message.send",
			{ message: "hi sibling", receiver_role: "sibling", receiver_name: "rlm-b" },
			{ role: "child", childId: "rlm-a" },
			FAMILY,
		)) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		const got = (await conn.request("agent_message.recv", {}, { role: "child", childId: "rlm-b" }, FAMILY)) as {
			messages: Array<{ message: string; from: string }>;
		};
		expect(got.messages).toHaveLength(1);
		expect(got.messages[0]?.message).toBe("hi sibling");
		expect(got.messages[0]?.from).toBe("child");

		await conn.close();
	});
});

describe("daemon session leases (attach/stop)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-daemon-lease-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(() => {
		resetDaemonState();
		resetRlmFamilies();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("attaches a session (acquires a lease) and stop releases it for re-attach", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);
		const sessionDir = path.join(tmp, "sess-1");

		const attached = (await conn.request(
			"session.attach",
			{ session_dir: sessionDir },
			{ role: "parent" },
			FAMILY,
		)) as { attached: boolean; token: string };
		expect(attached.attached).toBe(true);
		expect(attached.token).toBeDefined();

		const stopped = (await conn.request("session.stop", { session_dir: sessionDir }, { role: "parent" }, FAMILY)) as {
			released: boolean;
		};
		expect(stopped.released).toBe(true);

		// Re-attach succeeds once the lease is released.
		const reattached = (await conn.request(
			"session.attach",
			{ session_dir: sessionDir },
			{ role: "parent" },
			FAMILY,
		)) as { attached: boolean };
		expect(reattached.attached).toBe(true);

		await conn.close();
	});

	it("refuses a second attach by a different owner while the lease is held", async () => {
		const { server, client } = inMemoryPair();
		void serveConnection(server, handleDaemonRequest);
		const conn = new DaemonClient(client);
		const sessionDir = path.join(tmp, "sess-2");

		const first = (await conn.request("session.attach", { session_dir: sessionDir }, { role: "parent" }, FAMILY)) as {
			attached: boolean;
		};
		expect(first.attached).toBe(true);

		expect(
			conn.request(
				"session.attach",
				{ session_dir: sessionDir },
				{ role: "child", childId: "rlm-intruder" },
				FAMILY,
			),
		).rejects.toThrow(/already active/i);

		await conn.close();
	});
});

describe("daemon over a real Unix-domain socket", () => {
	let tmp: string;
	afterEach(() => {
		resetDaemonState();
		resetRlmFamilies();
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("delivers a message across two real connections and cleans the socket on stop", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-daemon-"));
		setupDaemonState({ agentDir: tmp });
		const sock = path.join(tmp, "daemon.sock");
		const srv = await udsServer(sock, handleDaemonRequest);

		const parent = await udsConnect(sock);
		const child = await udsConnect(sock);

		await parent.request("rlm.register_child", { entry: childEntry("rlm-c1", "kid") }, { role: "parent" }, FAMILY);
		await parent.request(
			"agent_message.send",
			{ message: "over the wire", receiver_role: "child", receiver_name: "rlm-c1" },
			{ role: "parent" },
			FAMILY,
		);

		const got = (await child.request("agent_message.recv", {}, { role: "child", childId: "rlm-c1" }, FAMILY)) as {
			messages: Array<{ message: string }>;
		};
		expect(got.messages).toHaveLength(1);
		expect(got.messages[0]?.message).toBe("over the wire");

		await parent.close();
		await child.close();
		await srv.stop();

		expect(fs.existsSync(sock)).toBe(false);
	});
});

describe("daemon supervisor", () => {
	let tmp: string;
	let handles: Array<{ stop: () => Promise<void> }> = [];
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-sup-"));
		setupDaemonState({ agentDir: tmp });
	});
	afterEach(async () => {
		resetDaemonState();
		resetRlmFamilies();
		for (const h of handles) {
			await h.stop().catch(() => {});
		}
		handles = [];
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("boots an in-process daemon, connects a client, and tears it down cleanly", async () => {
		const sock = path.join(tmp, "daemon.sock");
		const handle = await ensureDaemonRunning({
			socketPath: sock,
			spawn: p => udsServer(p, handleDaemonRequest),
		});
		handles.push(handle);

		expect(handle.socketPath).toBe(sock);
		await handle.client.request(
			"rlm.register_child",
			{ entry: childEntry("rlm-c1", "kid") },
			{ role: "parent" },
			FAMILY,
		);
		const sent = (await handle.client.request(
			"agent_message.send",
			{ message: "via supervisor", receiver_role: "child", receiver_name: "rlm-c1" },
			{ role: "parent" },
			FAMILY,
		)) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		await handle.stop();
		expect(fs.existsSync(sock)).toBe(false);
	});
});
