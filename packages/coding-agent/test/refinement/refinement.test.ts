import { describe, expect, it } from "bun:test";
import type { Model } from "@cxn/pi-ai";
import {
	applyRefinementProposal,
	emptyHarnessState,
	extractJsonObject,
	type HarnessState,
	isIncompleteJson,
	parseProposal,
	planRefinement,
	type RefinementEdit,
	type RefinementProposal,
	refineHarness,
} from "../../src/refinement";

const fakeModel = { maxTokens: 64_000 } as unknown as Model;

function makeProposal(overrides: Partial<RefinementProposal> = {}): RefinementProposal {
	return {
		summary: "Add cache memory",
		rationale: "Trajectory evidence",
		expectedOutcome: "Recall improves",
		edits: [
			{
				action: "create",
				kind: "memory",
				title: "Build cache",
				content: "Clean checkout means a cold cache.",
			},
		],
		...overrides,
	};
}

function proposalText(proposal: RefinementProposal): string {
	return JSON.stringify(proposal);
}

/** Completer that echoes a canned JSON proposal. */
function cannedCompleter(proposal: RefinementProposal) {
	return async () => proposalText(proposal);
}

describe("json parsing", () => {
	it("distinguishes truncated JSON from complete-but-malformed JSON", () => {
		expect(isIncompleteJson('{"a": "unterminated')).toBe(true);
		expect(isIncompleteJson('{"a": {"b": 1}')).toBe(true);
		expect(isIncompleteJson('{"a": 1}')).toBe(false);
		expect(isIncompleteJson("just prose")).toBe(false);
	});

	it("extracts a fenced JSON object from model output", () => {
		const text = 'Here you go:\n```json\n{"summary": "x", "edits": []}\n```\n';
		const value = extractJsonObject(text) as Record<string, unknown>;
		expect(value.summary).toBe("x");
	});

	it("slices JSON wrapped in prose", () => {
		const value = extractJsonObject(`Sure! ${JSON.stringify(makeProposal())}`) as Record<string, unknown>;
		expect((value as { summary?: unknown }).summary).toBe("Add cache memory");
	});

	it("throws the truncation message when the reply ends mid-value", () => {
		expect(() => extractJsonObject('{"summary": "truncated')).toThrow(/output budget/);
	});

	it("parses proposals, coercing malformed edits safely", () => {
		const mixed = [
			{ action: "create", kind: "memory", title: "x", content: "y" },
			"garbage",
		] as unknown as RefinementEdit[];
		const proposal = parseProposal(proposalText(makeProposal({ edits: mixed })));
		expect(proposal.edits).toHaveLength(1);
		expect(proposal.edits[0].action).toBe("create");
	});
});

describe("applyRefinementProposal", () => {
	function stateWithEntry(): HarnessState {
		const state = emptyHarnessState();
		state.entries.memory.cache = {
			id: "cache",
			kind: "memory",
			title: "Cache",
			content: "old content",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: "2026-08-18T00:00:00.000Z",
			updated_at: "2026-08-18T00:00:00.000Z",
			version: 1,
		};
		return state;
	}

	it("creates an entry with a slug id and a snapshot", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(state, makeProposal(), { id: "refine_1", scope: "local" });

		expect(result.appliedEdits[0].applied).toBe(true);
		expect(result.appliedEdits[0].id).toBe("build_cache");
		expect(state.entries.memory.build_cache.title).toBe("Build cache");
		expect(state.entries.memory.build_cache.version).toBe(1);
		expect(state.refinements).toHaveLength(1);
	});

	it("updates an entry, bumping the version and keeping created_at", () => {
		const state = stateWithEntry();
		const proposal = makeProposal({
			edits: [{ action: "update", kind: "memory", id: "cache", title: "Cache", content: "new content" }],
		});
		const result = applyRefinementProposal(state, proposal, { id: "refine_2", scope: "local" });

		expect(result.appliedEdits[0].applied).toBe(true);
		expect(state.entries.memory.cache.content).toBe("new content");
		expect(state.entries.memory.cache.version).toBe(2);
	});

	it("rejects a delete of a missing entry", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			makeProposal({ edits: [{ action: "delete", kind: "memory", id: "nope" }] }),
			{ id: "refine_3", scope: "local" },
		);
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toBe("entry not found");
	});

	it("refuses to edit the base system prompt", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			makeProposal({
				edits: [{ action: "update", kind: "prompt", id: "base_system_prompt", title: "x", content: "y" }],
			}),
			{ id: "refine_4", scope: "local" },
		);
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toMatch(/base system prompt/);
	});

	it("requires a python reference and arguments for skill edits", () => {
		const state = emptyHarnessState();
		const missingArgs = applyRefinementProposal(
			state,
			makeProposal({
				edits: [
					{
						action: "create",
						kind: "skill",
						title: "Formatter",
						content: "Run the formatter",
						reference: { type: "python", import: "fmt", callable: "run" },
					},
				],
			}),
			{ id: "refine_5", scope: "local" },
		);
		expect(missingArgs.appliedEdits[0].applied).toBe(false);
		expect(missingArgs.appliedEdits[0].error).toMatch(/arguments/);

		const valid = applyRefinementProposal(
			state,
			makeProposal({
				edits: [
					{
						action: "create",
						kind: "skill",
						title: "Formatter",
						content: "Run the formatter",
						reference: { type: "python", import: "fmt", callable: "run" },
						arguments: { files: { type: "string", required: true } },
					},
				],
			}),
			{ id: "refine_6", scope: "local" },
		);
		expect(valid.appliedEdits[0].applied).toBe(true);
	});

	it("rejects edits that conflict with the baseline (entry changed during planning)", () => {
		const baseline = stateWithEntry();
		const changed = stateWithEntry();
		changed.entries.memory.cache.content = "changed by another session";

		const result = applyRefinementProposal(
			changed,
			makeProposal({ edits: [{ action: "update", kind: "memory", id: "cache", title: "Cache", content: "mine" }] }),
			{ id: "refine_7", scope: "global", baselineState: baseline },
		);
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toMatch(/changed during refinement planning/);
	});

	it("records a refinement event with the applied changes", () => {
		const state = emptyHarnessState();
		applyRefinementProposal(state, makeProposal(), { id: "refine_8", scope: "local" });
		expect(state.refinements[0].id).toBe("refine_8");
		expect(state.refinements[0].changes).toEqual(["create memory:build_cache"]);
	});
});

describe("rollback", () => {
	it("restores the pre-refinement snapshot via a derived proposal", async () => {
		const state = emptyHarnessState();
		const create = applyRefinementProposal(state, makeProposal(), { id: "refine_a", scope: "local" });

		// Plan a rollback from history without an LLM call.
		const plan = await planRefinement(
			[],
			state,
			[create],
			fakeModel,
			"test-key",
			{ rollbackId: "refine_a" },
			async () => {
				throw new Error("rollback must not call the model");
			},
		);
		expect(plan.rollbackOf).toBe("refine_a");

		const result = applyRefinementProposal(state, plan.proposal, {
			id: plan.id,
			rollbackOf: plan.rollbackOf,
			scope: plan.rollbackScope ?? "local",
		});
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(result.appliedEdits[0].action).toBe("delete");
		expect(state.entries.memory.build_cache).toBeUndefined();
	});

	it("throws when the rollback target does not exist in history", async () => {
		await expect(
			planRefinement([], emptyHarnessState(), [], fakeModel, "test-key", { rollbackId: "refine_missing" }),
		).rejects.toThrow(/not found/);
	});
});

describe("planRefinement / refineHarness with an injected completer", () => {
	it("passes the harness overview and scope policy to the model and parses the proposal", async () => {
		let received = "";
		const plan = await planRefinement(
			[{ role: "user", content: "fix the build" }] as never,
			emptyHarnessState(),
			[],
			fakeModel,
			"test-key",
			{},
			async options => {
				received = options.userPrompt;
				return proposalText(makeProposal());
			},
		);
		expect(received).toContain("<current_harness_state>");
		expect(received).toContain("Requested refinement scope: local");
		expect(plan.proposal.summary).toBe("Add cache memory");
	});

	it("uses the global scope policy when requested", async () => {
		let received = "";
		await planRefinement([], emptyHarnessState(), [], fakeModel, "test-key", { global: true }, async options => {
			received = options.userPrompt;
			return proposalText(makeProposal());
		});
		expect(received).toContain("Requested refinement scope: global");
	});

	it("applies an empty proposal as a no-op refinement", async () => {
		const state = emptyHarnessState();
		const result = await refineHarness(
			[],
			state,
			[],
			fakeModel,
			"test-key",
			{},
			cannedCompleter(makeProposal({ edits: [] })),
		);
		expect(result.appliedEdits).toHaveLength(0);
		expect(state.refinements).toHaveLength(1);
		expect(result.summary).toBe("Add cache memory");
		expect(result.appliedEdits).toHaveLength(0);
	});

	it("throws the truncation error when the completer output is cut off", async () => {
		await expect(
			refineHarness([], emptyHarnessState(), [], fakeModel, "test-key", {}, async () => '{"summary": "cut'),
		).rejects.toThrow(/output budget/);
	});
});
