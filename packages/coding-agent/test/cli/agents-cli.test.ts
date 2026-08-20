import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RlmSubagentRegistryEntry, resetRlmFamilies } from "@cyberxninja-omp/pi-coding-agent/eval/py/family-store";
import {
	type DaemonClient,
	ensureDaemonRunning,
	handleDaemonRequest,
	resetDaemonState,
	setupDaemonState,
	udsServer,
} from "@cyberxninja-omp/pi-coding-agent/modes/daemon/index";
import { type AgentsCommandArgs, DEFAULT_AGENTS_FAMILY_ID, runAgentsCommand } from "../../src/cli/agents-cli";

const FAMILY = DEFAULT_AGENTS_FAMILY_ID;

function childEntry(id: string, name: string, dir: string): RlmSubagentRegistryEntry {
	return {
		rlm_child_id: id,
		active_session_id: null,
		session_id: null,
		session_name: name,
		session_dir: dir,
		status: "running",
	};
}

describe("omp agents daemon subcommands", () => {
	let tmp: string;
	let daemon: { socketPath: string; client: DaemonClient; stop: () => Promise<void> };
	let out: string[];
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cxn-agents-cli-"));
		setupDaemonState({ agentDir: tmp });
		daemon = await ensureDaemonRunning({
			socketPath: path.join(tmp, "daemon.sock"),
			spawn: p => udsServer(p, handleDaemonRequest),
		});
		// Seed two children into the daemon's family.
		await daemon.client.request(
			"rlm.register_child",
			{ entry: childEntry("rlm-a", "alpha", path.join(tmp, "a")) },
			{ role: "parent" },
			FAMILY,
		);
		await daemon.client.request(
			"rlm.register_child",
			{ entry: childEntry("rlm-b", "beta", path.join(tmp, "b")) },
			{ role: "parent" },
			FAMILY,
		);
		out = [];
		spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			out.push(String(chunk));
			return true;
		});
	});

	afterEach(async () => {
		spy.mockRestore();
		await daemon.stop().catch(() => {});
		resetDaemonState();
		resetRlmFamilies();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	async function run(cmd: AgentsCommandArgs): Promise<unknown> {
		await runAgentsCommand(cmd, { client: daemon.client });
		const text = out.join("");
		out.length = 0;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	it("lists registered agents as JSON", async () => {
		const result = (await run({ action: "list", flags: { json: true } })) as Array<{
			id: string;
			role: string;
		}>;
		const ids = result.map(a => a.id);
		expect(ids).toContain("rlm-a");
		expect(ids).toContain("rlm-b");
		expect(ids).toContain(FAMILY); // parent row
	});

	it("sends a message to a child agent", async () => {
		const res = (await run({
			action: "send",
			id: "rlm-a",
			message: "status?",
			flags: { json: true },
		})) as { id: string; delivered: boolean };
		expect(res.id).toBe("rlm-a");
		expect(res.delivered).toBe(true);
	});

	it("attaches to (leases) and stops an agent session", async () => {
		const attached = (await run({ action: "attach", id: "rlm-a", flags: { json: true } })) as {
			id: string;
			attached: boolean;
			token: string;
		};
		expect(attached.attached).toBe(true);
		expect(attached.token).toBeDefined();

		const stopped = (await run({ action: "stop", id: "rlm-a", flags: { json: true } })) as {
			id: string;
			released: boolean;
		};
		expect(stopped.released).toBe(true);
	});
});
