/**
 * Exercises the REAL daemon process boot path: `cxn --mode daemon` launched as a
 * subprocess via the default supervisor spawn (spawnCliDaemon -> cli.ts). This is
 * the production path that `cxn agents` relies on; earlier tests only used the
 * in-process udsServer injection.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetRlmFamilies } from "@cxn/pi-coding-agent/eval/py/family-store";
import { ensureDaemonRunning, resetDaemonState } from "@cxn/pi-coding-agent/modes/daemon/index";

type Handle = Awaited<ReturnType<typeof ensureDaemonRunning>>;

describe("real daemon process boot (cli.ts --mode daemon)", () => {
	let sock: string;
	let handle: Handle | null = null;

	afterEach(async () => {
		await handle?.stop().catch(() => {});
		handle = null;
		resetDaemonState();
		resetRlmFamilies();
		if (sock) fs.rmSync(sock, { force: true });
	});

	it("spawns the cxn CLI in daemon mode and serves catalog + family requests over UDS", async () => {
		sock = path.join(os.tmpdir(), `cxn-boot-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
		// No `spawn` override → default spawnCliDaemon launches the real cli.ts.
		handle = await ensureDaemonRunning({ socketPath: sock, timeoutMs: 15_000 });

		expect(handle.socketPath).toBe(sock);
		expect(fs.existsSync(sock)).toBe(true);

		const models = (await handle.client.request("find_models", { query: "gpt" }, { role: "parent" }, "fam-boot")) as {
			models: unknown[];
		};
		expect(Array.isArray(models.models)).toBe(true);

		await handle.client.request(
			"rlm.register_child",
			{
				entry: {
					rlm_child_id: "boot-c1",
					active_session_id: null,
					session_id: null,
					session_name: "Boot Kid",
					session_dir: "/tmp/boot-c1",
					status: "running",
				},
			},
			{ role: "parent" },
			"fam-boot",
		);

		const list = (await handle.client.request("rlm.list_subagents", {}, { role: "parent" }, "fam-boot")) as {
			subagents: Array<{ rlm_child_id: string }>;
		};
		expect(list.subagents.map(s => s.rlm_child_id)).toContain("boot-c1");

		// A message delivered to the registered child must reach its mailbox.
		const sent = (await handle.client.request(
			"agent_message.send",
			{ message: "hello boot", receiver_role: "child", receiver_name: "boot-c1" },
			{ role: "parent" },
			"fam-boot",
		)) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		await handle.stop();
		// Parent stopper unlinks the socket even if the child is slow to exit.
		expect(fs.existsSync(sock)).toBe(false);
	}, 30_000);
});
