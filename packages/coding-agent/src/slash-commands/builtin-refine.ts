/**
 * /refine slash command — the continual-harness surface.
 *
 *   /refine [instructions]      run a local refinement from the trajectory
 *   /refine --global [instr]    run a global (cross-session) refinement
 *   /refine --rollback <id>     roll back a previous refinement (snapshot restore)
 *   /refine history             list prior refinements
 *
 * Every applied refinement records before/after snapshots, so any refinement
 * can be rolled back. Applied memory entries are additionally synced into the
 * active memory backend (see ../refinement/memory-backend.ts).
 */
import {
	appendRefinement,
	applyRefinementProposal,
	buildMemoryRollbackNote,
	createRefinementMemoryContext,
	formatMemorySyncSummary,
	formatRefinementResult,
	getGlobalHarnessDir,
	getLocalHarnessDir,
	type HarnessScope,
	loadHarnessState,
	loadRefinementHistory,
	mergeHarnessStates,
	mergeRefinementHistory,
	planRefinement,
	type RefinementResult,
	type RefineOptions,
	saveHarnessState,
	syncAppliedMemoriesToBackend,
} from "../refinement";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

async function requireModel(
	runtime: SlashCommandRuntime,
): Promise<{ model: NonNullable<SlashCommandRuntime["session"]["model"]>; apiKey: string } | undefined> {
	const { session } = runtime;
	const model = session.model ?? session.modelRegistry.getAll()[0];
	if (!model) {
		await runtime.output("No model available to run /refine; configure a model first.");
		return undefined;
	}
	const apiKey = await session.modelRegistry.getApiKey(model, session.sessionId);
	if (!apiKey) {
		await runtime.output(
			`No API key configured for ${model.provider}/${model.id}; run /login or set an API key before refining.`,
		);
		return undefined;
	}
	return { model, apiKey };
}

interface RefineTarget {
	scope: HarnessScope;
	dir: string;
}

function resolveTargets(agentDir: string, sessionId: string): { globalDir: string; localDir: string } {
	return {
		globalDir: getGlobalHarnessDir(agentDir),
		localDir: getLocalHarnessDir(agentDir, sessionId),
	};
}

async function runRefine(runtime: SlashCommandRuntime, target: RefineTarget, options: RefineOptions): Promise<void> {
	const { session, cwd } = runtime;
	const agentDir = runtime.settings.getAgentDir();
	const sessionId = session.sessionManager.getSessionId() ?? "unsaved";
	const { globalDir, localDir } = resolveTargets(agentDir, sessionId);

	const state = loadHarnessState(target.dir, target.scope);
	const mergedForPrompt = mergeHarnessStates(
		target.scope === "global" ? state : loadHarnessState(globalDir, "global"),
		target.scope === "local" ? state : loadHarnessState(localDir, "local"),
	);
	const history = mergeRefinementHistory(loadRefinementHistory(globalDir), loadRefinementHistory(localDir));

	const modelContext = await requireModel(runtime);
	if (!modelContext) return;
	const { model, apiKey } = modelContext;

	// Plan against the merged view, then re-read the target store before
	// applying: the LLM pass can take seconds, during which another session may
	// write the shared global store. `baselineState` rejects conflicting edits.
	const plan = await planRefinement(
		session.messages,
		mergedForPrompt,
		history,
		model,
		apiKey,
		options,
		undefined,
		undefined,
	);
	const freshState = loadHarnessState(target.dir, target.scope);
	const result = applyRefinementProposal(freshState, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? target.scope,
		baselineState: state,
	});
	saveHarnessState(target.dir, freshState);
	appendRefinement(target.dir, result);

	const memoryContext = createRefinementMemoryContext(session, agentDir, cwd);
	const synced = await syncAppliedMemoriesToBackend(memoryContext, result);
	const memorySummary = formatMemorySyncSummary(synced);

	const lines = [formatRefinementResult(result)];
	if (memorySummary) lines.push("", memorySummary);
	const rollbackNote = buildMemoryRollbackNote(result);
	if (rollbackNote) lines.push("", rollbackNote);
	await runtime.output(lines.join("\n"));
}

function parseRefineArgs(raw: string): {
	verb: "run" | "rollback" | "history";
	options: RefineOptions;
	instructions: string;
} {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const options: RefineOptions = {};
	const instructions: string[] = [];
	let verb: "run" | "rollback" | "history" = "run";

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "--global" || token === "-g") {
			options.global = true;
			i++;
		} else if (token === "--rollback") {
			const id = tokens[i + 1];
			if (!id || id.startsWith("--")) {
				instructions.push("--rollback");
				i++;
			} else {
				options.rollbackId = id;
				verb = "rollback";
				i += 2;
			}
		} else if (token === "history" || token === "--history") {
			verb = "history";
			i++;
		} else if (token === "run") {
			verb = "run";
			i++;
		} else {
			instructions.push(token);
			i++;
		}
	}
	return { verb, options, instructions: instructions.join(" ") };
}

export const BUILTIN_REFINE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "refine",
		description:
			"Refine the continual harness: review the trajectory and apply small evidence-backed edits to supplemental state (prompts, memories, skills, subagent specs); every refinement is snapshotted and can be rolled back",
		allowArgs: true,
		subcommands: [
			{ name: "run", description: "Refine the local harness from the current trajectory" },
			{ name: "global", description: "Refine the global harness (cross-session lessons)" },
			{ name: "rollback", description: "Roll back a previous refinement", usage: "<id>" },
			{ name: "history", description: "List prior refinements" },
		],
		inlineHint: "[--global] [instructions] | --rollback <id> | history",
		handle: async (command, runtime) => {
			const { verb, options, instructions } = parseRefineArgs(command.args);
			const agentDir = runtime.settings.getAgentDir();
			const sessionId = runtime.session.sessionManager.getSessionId() ?? "unsaved";
			const { globalDir, localDir } = resolveTargets(agentDir, sessionId);

			try {
				if (verb === "history") {
					const history = mergeRefinementHistory(
						loadRefinementHistory(globalDir),
						loadRefinementHistory(localDir),
					);
					if (history.length === 0) {
						await runtime.output(
							"No refinements yet. Run /refine after a substantive turn to create the first one.",
						);
						return commandConsumed();
					}
					const lines = ["Continual harness refinements:"];
					for (const item of history) {
						const scope = item.scope ?? "local";
						const edits = item.appliedEdits
							.filter(e => e.applied)
							.map(e => `${e.action} ${e.kind}:${e.id}`)
							.join(", ");
						const rollback = item.rollbackOf ? ` (rollback of ${item.rollbackOf})` : "";
						lines.push(`  [${scope}] ${item.id}${rollback} — ${item.summary}${edits ? ` [${edits}]` : ""}`);
					}
					lines.push("", "Roll back with /refine --rollback <id>");
					await runtime.output(lines.join("\n"));
					return commandConsumed();
				}

				const target: RefineTarget = options.global
					? { scope: "global", dir: globalDir }
					: { scope: "local", dir: localDir };
				await runRefine(runtime, target, { ...options, instructions: instructions || undefined });
			} catch (error) {
				await usage(`/refine failed: ${errorMessage(error)}`, runtime);
			}
			return commandConsumed();
		},
	},
];

export type { RefinementResult };
