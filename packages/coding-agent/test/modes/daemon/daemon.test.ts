import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RlmSubagentRegistryEntry } from "@cxn/pi-coding-agent/eval/py/family-store";
import { resetRlmFamilies } from "@cxn/pi-coding-agent/eval/py/rlm";
import {
	DaemonClient,
	ensureDaemonRunning,
	handleDaemonRequest,
	inMemoryPair,
	serveConnection,
	udsConnect,
	udsServer,
} from "@cxn/pi-coding-agent/modes/daemon/index";

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
	afterEach(() => resetRlmFamilies());

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

		// The child speaks for rlm-c1 and reads its own mailbox.
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
});

describe("daemon over a real Unix-domain socket", () => {
	let tmp: string;
	afterEach(() => {
		resetRlmFamilies();
		if (tmp) {
			try {
				fs.rmSync(tmp, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("delivers a message across two real connections and cleans the socket on stop", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-daemon-"));
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
	afterEach(async () => {
		resetRlmFamilies();
		for (const h of handles) {
			await h.stop().catch(() => {});
		}
		handles = [];
		if (tmp) {
			try {
				fs.rmSync(tmp, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("boots an in-process daemon, connects a client, and tears it down cleanly", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-sup-"));
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
