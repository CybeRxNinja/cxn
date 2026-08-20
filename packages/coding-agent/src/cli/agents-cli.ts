/**
 * Agents CLI command handlers.
 *
 * Handles `omp agents unpack` (writing bundled agent definitions to disk) and
 * the daemon-backed subcommands `omp agents list | attach | send | stop`,
 * which talk to the supervisor daemon over its shared `FamilyStore`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@cyberxninja-omp/pi-utils";
import chalk from "@cyberxninja-omp/pi-utils/chalk";
import { YAML } from "bun";
import {
	type DaemonClient,
	daemonSocketPath,
	ensureDaemonRunning,
	handleDaemonRequest,
	udsServer,
} from "../modes/daemon";
import { theme } from "../modes/theme/theme";
import { loadBundledAgents } from "../task/agents";
import type { AgentDefinition } from "../task/types";

export type AgentsAction = "unpack" | "list" | "attach" | "send" | "stop";

/** The daemon family the `omp agents` CLI operates on by default. */
export const DEFAULT_AGENTS_FAMILY_ID = "cxn-agents";

export interface AgentsCommandArgs {
	action: AgentsAction;
	/** Target agent id (for attach/send/stop). */
	id?: string;
	/** Message text (for send). */
	message?: string;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
		/** Override the daemon family id (default `cxn-agents`). */
		family?: string;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

interface DaemonCommandOptions {
	/** Injected client for tests; production lazily connects via ensureDaemonRunning. */
	client?: DaemonClient;
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir && flags.dir.trim().length > 0) {
		return path.resolve(getProjectDir(), flags.dir.trim());
	}

	if (flags.user && flags.project) {
		throw new Error("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".omp", "agents");
	}

	return path.join(getAgentDir(), "agents");
}

function toFrontmatter(agent: AgentDefinition): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
	};

	if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
	if (agent.spawns !== undefined) frontmatter.spawns = agent.spawns;
	if (agent.model && agent.model.length > 0) frontmatter.model = agent.model;
	if (agent.thinkingLevel) frontmatter.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) frontmatter.output = agent.output;
	if (agent.blocking) frontmatter.blocking = true;

	return frontmatter;
}

function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = YAML.stringify(toFrontmatter(agent), null, 2).trimEnd();
	const body = agent.systemPrompt.trim();
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}

		await Bun.write(filePath, serializeAgent(agent));
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

/**
 * Connect to the supervisor daemon (or reuse an injected client for tests) and
 * run `fn` against its `DaemonClient`. In production this lazily boots the
 * daemon if no live socket exists; we never tear down a daemon we only joined.
 */
async function withDaemonClient(
	opts: DaemonCommandOptions,
	fn: (client: DaemonClient) => Promise<void>,
): Promise<void> {
	if (opts.client) {
		await fn(opts.client);
		return;
	}
	const daemon = await ensureDaemonRunning({
		socketPath: daemonSocketPath(),
		spawn: p => udsServer(p, handleDaemonRequest),
	});
	try {
		await fn(daemon.client);
	} finally {
		await daemon.stop();
	}
}

/** Look up an agent's session directory from the roster (needed for attach/stop leases). */
async function resolveSessionDir(client: DaemonClient, familyId: string, id: string): Promise<string> {
	const roster = (await client.request("session.list", {}, { role: "parent" }, familyId)) as {
		agents: Array<{ id: string; sessionDir?: string }>;
	};
	const target = roster.agents.find(a => a.id === id);
	if (!target) throw new Error(`omp agents: unknown agent ${id}`);
	if (!target.sessionDir) throw new Error(`omp agents: agent ${id} has no session directory`);
	return target.sessionDir;
}

async function runAgentsDaemonCommand(cmd: AgentsCommandArgs, opts: DaemonCommandOptions = {}): Promise<void> {
	const familyId = cmd.flags.family ?? DEFAULT_AGENTS_FAMILY_ID;
	const json = cmd.flags.json === true;
	const emit = (payload: unknown): void => {
		writeStdout(json ? JSON.stringify(payload, null, 2) : String(payload));
	};

	await withDaemonClient(opts, async client => {
		switch (cmd.action) {
			case "list": {
				const res = (await client.request("session.list", {}, { role: "parent" }, familyId)) as {
					agents: Array<{ id: string; name: string; role: string; status: string; sessionDir?: string }>;
				};
				if (json) {
					emit(res.agents);
					return;
				}
				writeStdout(chalk.bold(`Agents (family ${familyId}): ${res.agents.length}`));
				for (const a of res.agents) {
					writeStdout(chalk.dim(`  ${a.role.padEnd(7)} ${a.id}  ${a.name}  [${a.status}]`));
				}
				return;
			}
			case "send": {
				if (!cmd.id) throw new Error("omp agents send requires <id>");
				if (!cmd.message) throw new Error("omp agents send requires <message>");
				const roster = (await client.request("session.list", {}, { role: "parent" }, familyId)) as {
					agents: Array<{ id: string; role: string }>;
				};
				const target = roster.agents.find(a => a.id === cmd.id);
				if (!target) throw new Error(`omp agents send: unknown agent ${cmd.id}`);
				const receiverRole = target.role === "parent" ? "parent" : "child";
				const res = (await client.request(
					"agent_message.send",
					{
						message: cmd.message,
						receiver_role: receiverRole,
						receiver_name: receiverRole === "parent" ? undefined : cmd.id,
					},
					{ role: "parent" },
					familyId,
				)) as { deliveryStatus: string };
				emit({ id: cmd.id, delivered: res.deliveryStatus === "delivered" });
				return;
			}
			case "attach": {
				if (!cmd.id) throw new Error("omp agents attach requires <id>");
				const dir = await resolveSessionDir(client, familyId, cmd.id);
				const res = (await client.request(
					"session.attach",
					{ session_dir: dir },
					{ role: "parent" },
					familyId,
				)) as {
					attached: boolean;
					token: string;
				};
				emit({ id: cmd.id, attached: res.attached, token: res.token });
				return;
			}
			case "stop": {
				if (!cmd.id) throw new Error("omp agents stop requires <id>");
				const dir = await resolveSessionDir(client, familyId, cmd.id);
				const res = (await client.request("session.stop", { session_dir: dir }, { role: "parent" }, familyId)) as {
					released: boolean;
				};
				emit({ id: cmd.id, released: res.released });
				return;
			}
		}
	});
}

export async function runAgentsCommand(cmd: AgentsCommandArgs, opts: DaemonCommandOptions = {}): Promise<void> {
	switch (cmd.action) {
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
		case "list":
		case "attach":
		case "send":
		case "stop":
			await runAgentsDaemonCommand(cmd, opts);
			return;
	}
}
