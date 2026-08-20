/**
 * Manage bundled task agents.
 */

import { Args, Command, Flags, renderCommandHelp } from "@cyberxninja-omp/pi-utils/cli";
import { type AgentsAction, type AgentsCommandArgs, runAgentsCommand } from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: AgentsAction[] = ["unpack", "list", "attach", "send", "stop"];

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Agents action",
			required: false,
			options: ACTIONS,
		}),
		id: Args.string({ description: "Target agent id (attach/send/stop)", required: false }),
		message: Args.string({ description: "Message text (send)", required: false }),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing agent files" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dir: Flags.string({ description: "Output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Write to ~/.omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Write to ./.omp/agents" }),
		family: Flags.string({ description: "Daemon family id (default cxn-agents)" }),
	};

	static examples = [
		"# Export bundled agents into user config (default)\n  omp agents unpack",
		"# Export bundled agents into project config\n  omp agents unpack --project",
		"# Overwrite existing local agent files\n  omp agents unpack --project --force",
		"# Export into a custom directory\n  omp agents unpack --dir ./tmp/agents --json",
		"# List running agents via the daemon\n  omp agents list",
		"# Send a message to an agent\n  omp agents send <id> 'status?'",
		"# Attach to / stop an agent's session (lease)\n  omp agents attach <id> / omp agents stop <id>",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp", "agents", Agents);
			return;
		}

		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			id: args.id,
			message: args.message,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
				family: flags.family,
			},
		};

		await initTheme();
		await runAgentsCommand(cmd);
	}
}
