import { describe, expect, it } from "bun:test";
import type { MemoryBackendSaveInput } from "../../src/memory-backend/types";
import type { RefinementResult } from "../../src/refinement";
import {
	buildMemoryRollbackNote,
	formatMemorySyncSummary,
	type RefinementMemoryContext,
	resultHasSyncedMemories,
	syncAppliedMemoriesToBackend,
} from "../../src/refinement/memory-backend";

function resultWithMemoryEdit(applied: boolean): RefinementResult {
	const after = {
		id: "cache_note",
		kind: "memory" as const,
		title: "Cache note",
		content: "Clean checkout means a cold cache.",
		path: "general",
		scope: "local" as const,
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		version: 1,
	};
	return {
		id: "refine_mem",
		summary: "Added cache memory",
		rationale: "evidence",
		expectedOutcome: "recall improves",
		appliedEdits: [{ action: "create", kind: "memory", id: "cache_note", after, applied }],
		harnessStatePath: "",
		scope: "local",
	};
}

function stubContext(
	overrides: Partial<RefinementMemoryContext> = {},
): RefinementMemoryContext & { saved: MemoryBackendSaveInput[] } {
	const saved: MemoryBackendSaveInput[] = [];
	return {
		saved,
		async save(input) {
			saved.push(input);
			return { backend: "local", stored: 1, ids: ["stored-1"] };
		},
		async status() {
			return { backend: "local", active: true, writable: true, searchable: false };
		},
		...overrides,
	};
}

describe("memory-backend adapter", () => {
	it("syncs applied memory edits through the backend save", async () => {
		const context = stubContext();
		const synced = await syncAppliedMemoriesToBackend(context, resultWithMemoryEdit(true));

		expect(synced.get("cache_note")?.stored).toBe(1);
		expect(context.saved).toHaveLength(1);
		expect(context.saved[0].content).toContain("cold cache");
		expect(context.saved[0].source).toBe("refine");
	});

	it("skips failed or non-memory edits", async () => {
		const context = stubContext();
		const result = resultWithMemoryEdit(false);
		const synced = await syncAppliedMemoriesToBackend(context, result);
		expect(synced.size).toBe(0);
		expect(context.saved).toHaveLength(0);
	});

	it("survives a failing backend without throwing (harness store is authoritative)", async () => {
		const context = stubContext({
			async save() {
				throw new Error("backend down");
			},
		});
		const synced = await syncAppliedMemoriesToBackend(context, resultWithMemoryEdit(true));
		expect(synced.get("cache_note")?.message).toMatch(/backend sync failed/);
	});

	it("flags results that carry synced memories and builds the rollback note", () => {
		expect(resultHasSyncedMemories(resultWithMemoryEdit(true))).toBe(true);
		expect(resultHasSyncedMemories(resultWithMemoryEdit(false))).toBe(false);

		const note = buildMemoryRollbackNote(resultWithMemoryEdit(true));
		expect(note).toContain("append-only");
		expect(buildMemoryRollbackNote(resultWithMemoryEdit(false))).toBeUndefined();
	});

	it("formats a sync summary for terminal output", async () => {
		const context = stubContext();
		const synced = await syncAppliedMemoriesToBackend(context, resultWithMemoryEdit(true));
		const summary = formatMemorySyncSummary(synced);
		expect(summary).toContain("memory:cache_note");
		expect(summary).toContain("stored 1 (local, ids: stored-1)");
		expect(formatMemorySyncSummary(new Map())).toBeUndefined();
	});
});
