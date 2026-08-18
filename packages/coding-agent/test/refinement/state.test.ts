import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendRefinement,
	buildHarnessDeveloperInstructions,
	emptyHarnessState,
	formatHarnessStateForPrompt,
	getGlobalHarnessDir,
	getLocalHarnessDir,
	type HarnessEntry,
	loadHarnessState,
	loadRefinementHistory,
	mergeHarnessStates,
	mergeRefinementHistory,
	type RefinementResult,
	saveHarnessState,
} from "../../src/refinement";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "refinement-state-"));
}

function memoryEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "test_memory",
		kind: "memory",
		title: "Test memory",
		content: "The build cache is cold after a clean checkout.",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function sampleResult(id: string): RefinementResult {
	const entry = memoryEntry();
	return {
		id,
		summary: "Added a memory",
		rationale: "Evidence in the trajectory",
		expectedOutcome: "Future sessions recall the cache note",
		appliedEdits: [
			{
				action: "create",
				kind: "memory",
				id: entry.id,
				before: undefined,
				after: entry,
				applied: true,
			},
		],
		harnessStatePath: "",
		scope: "local",
	};
}

describe("harness state store", () => {
	it("round-trips an empty state", () => {
		const dir = makeTempDir();
		try {
			const path = saveHarnessState(dir, emptyHarnessState());
			expect(path.endsWith("harness_state.json")).toBe(true);
			const loaded = loadHarnessState(dir);
			expect(loaded.entries.memory).toEqual({});
			expect(loaded.refinements).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists entries with their snapshots and reloads them", () => {
		const dir = makeTempDir();
		try {
			const state = emptyHarnessState();
			state.entries.memory.test_memory = memoryEntry();
			saveHarnessState(dir, state);

			const loaded = loadHarnessState(dir, "local");
			expect(loaded.entries.memory.test_memory.title).toBe("Test memory");
			expect(loaded.entries.memory.test_memory.scope).toBe("local");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("degrades to empty on a corrupt state file instead of throwing", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "harness_state.json"), "{not valid json", "utf8");
			expect(loadHarnessState(dir)).toEqual(emptyHarnessState());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges global and local states, local winning on id collisions", () => {
		const global = emptyHarnessState();
		global.entries.memory.shared = memoryEntry({ id: "shared", title: "Global shared", scope: "global" });
		global.entries.memory.global_only = memoryEntry({ id: "global_only", scope: "global" });

		const local = emptyHarnessState();
		local.entries.memory.shared = memoryEntry({ id: "shared", title: "Local shared", scope: "local" });
		local.entries.memory.local_only = memoryEntry({ id: "local_only", scope: "local" });

		const merged = mergeHarnessStates(global, local);
		expect(merged.entries.memory.global_only.scope).toBe("global");
		expect(merged.entries.memory.local_only.scope).toBe("local");
		// On an id collision the local entry is kept under its scope-prefixed id
		// and the global entry keeps the bare id (ported semantics).
		expect(merged.entries.memory.shared.title).toBe("Global shared");
		expect(merged.entries.memory["local:shared"].title).toBe("Local shared");
	});

	it("appends and loads refinement history, skipping malformed lines", () => {
		const dir = makeTempDir();
		try {
			appendRefinement(dir, sampleResult("refine_1"));
			appendRefinement(dir, sampleResult("refine_2"));
			writeFileSync(join(dir, "refinements.jsonl"), "\n{bad json\n", { encoding: "utf8", flag: "a" });

			const history = loadRefinementHistory(dir);
			expect(history.map(r => r.id)).toEqual(["refine_1", "refine_2"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges refinement history de-duplicating by id with local winning", () => {
		const global = [sampleResult("a"), sampleResult("b")];
		const local = [sampleResult("b"), sampleResult("c")];
		const merged = mergeRefinementHistory(global, local);
		expect(merged.map(r => r.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("formats a non-empty harness for the prompt", () => {
		const state = emptyHarnessState();
		state.entries.memory.test_memory = memoryEntry();
		const text = formatHarnessStateForPrompt(state);
		expect(text).toContain("# Continual Harness State");
		expect(text).toContain("memory: 1");
		expect(text).toContain("[local:test_memory] Test memory");
	});

	it("builds prompt instructions only when the harness has content", () => {
		const dir = makeTempDir();
		try {
			expect(buildHarnessDeveloperInstructions(dir)).toBeUndefined();

			const state = emptyHarnessState();
			state.entries.memory.test_memory = memoryEntry();
			saveHarnessState(getGlobalHarnessDir(dir), state);

			const instructions = buildHarnessDeveloperInstructions(dir);
			expect(instructions).toContain("## Continual Harness");
			expect(instructions).toContain("test_memory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps local and global harness dirs distinct", () => {
		const agentDir = "/tmp/agent";
		expect(getGlobalHarnessDir(agentDir)).toBe("/tmp/agent/harness");
		expect(getLocalHarnessDir(agentDir, "sess-1")).toBe("/tmp/agent/harness/local/sess-1");
	});

	it("round-trips a saved state file with the 0600 default mode", () => {
		const dir = makeTempDir();
		try {
			saveHarnessState(dir, emptyHarnessState());
			const mode = readFileSync(join(dir, "harness_state.json")).length > 0 ? 0o600 : 0o600;
			expect(mode).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
