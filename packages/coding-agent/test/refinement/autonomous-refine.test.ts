import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AgentMessage } from "@cyberxninja-omp/pi-agent-core";
import type { Model } from "@cyberxninja-omp/pi-ai";
import { getLocalHarnessDir, loadHarnessState } from "../../src/refinement";
import { runAutonomousRefine } from "../../src/slash-commands/builtin-refine";

const fakeModel = { maxTokens: 64_000 } as unknown as Model;
type JsonCompleterShape = (options: {
	model: Model;
	systemPrompt: string;
	userPrompt: string;
	apiKey: string;
	maxTokens: number;
	signal?: AbortSignal;
}) => Promise<string>;

/** Completer that answers the auto-review gate and the planning pass separately. */
function autoRefineCompleter(shouldRefine: boolean, proposalJson: string): JsonCompleterShape {
	return async ({ systemPrompt }) => {
		if (systemPrompt.includes("review gate")) {
			return JSON.stringify({
				shouldRefine,
				rationale: shouldRefine ? "useful evidence" : "nothing useful",
				instructions: shouldRefine ? "capture the lesson" : undefined,
			});
		}
		// planning pass
		return proposalJson;
	};
}

function makeSession(): {
	session: unknown;
	agentDir: string;
	cleanup: () => void;
} {
	const agentDir = fs.mkdtempSync(`${os.tmpdir()}/omp-auto-refine-`);
	const session = {
		model: fakeModel,
		sessionId: "test-session",
		modelRegistry: {
			getAll: () => [fakeModel],
			getApiKey: async () => "test-key",
		},
		messages: [] as AgentMessage[],
		sessionManager: {
			getSessionId: () => "test-session",
			getCwd: () => agentDir,
		},
	};
	return {
		session,
		agentDir,
		cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }),
	};
}

const promptProposal = JSON.stringify({
	summary: "Record the build command",
	rationale: "Trajectory evidence",
	expectedOutcome: "Faster rebuilds",
	edits: [
		{
			action: "create",
			kind: "prompt",
			title: "build command",
			content: "Use `bun run build` for this repo.",
		},
	],
});

describe("runAutonomousRefine", () => {
	it("returns undefined and writes nothing when the gate declines", async () => {
		const { session, agentDir, cleanup } = makeSession();
		const result = await runAutonomousRefine(session as never, { getAgentDir: () => agentDir } as never, {
			reason: "turn_interval",
			turnsSinceLastReview: 3,
			complete: autoRefineCompleter(false, promptProposal) as never,
		});
		expect(result).toBeUndefined();
		const localDir = getLocalHarnessDir(agentDir, "test-session");
		const state = loadHarnessState(localDir, "local");
		expect(Object.keys(state.entries.prompt)).toHaveLength(0);
		cleanup();
	});

	it("applies and persists a refinement when the gate approves", async () => {
		const { session, agentDir, cleanup } = makeSession();
		const result = await runAutonomousRefine(session as never, { getAgentDir: () => agentDir } as never, {
			reason: "turn_interval",
			turnsSinceLastReview: 1,
			complete: autoRefineCompleter(true, promptProposal) as never,
		});
		expect(result).toBeDefined();
		expect(result!.appliedEdits).toHaveLength(1);
		// Persisted to the local harness store on disk.
		const localDir = getLocalHarnessDir(agentDir, "test-session");
		const state = loadHarnessState(localDir, "local");
		expect(Object.keys(state.entries.prompt)).toHaveLength(1);
		cleanup();
	});
});
