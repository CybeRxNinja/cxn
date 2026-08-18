/**
 * Memory-backend adapter for the /refine harness.
 *
 * Harness `memory` entries are the authoritative supplemental state (the
 * harness store, with before/after snapshots for rollback). On top of that,
 * applied memory edits are ALSO synced into the active memory backend via
 * `save()` so refined facts become recallable through the memory tool and the
 * backend's consolidation pipeline, exactly like `learn`-tool lessons.
 *
 * Rollback semantics: a rollback restores the harness store (authoritative),
 * but a copy already synced to the backend persists — the backends are
 * append-only by design (there is no generic per-entry delete on the
 * `MemoryBackend` interface). This mirrors how a `learn` lesson cannot be
 * un-learned today. When the backend is `mnemopi`, users can drop a stray
 * copy with the `memory_edit forget` tool; `buildMemoryRollbackNote` surfaces
 * this so the operator is never surprised.
 */

import { createSessionMemoryRuntimeContext } from "../memory-backend";
import type {
	MemoryBackendSaveInput,
	MemoryBackendSaveResult,
	MemoryBackendStatus,
	MemoryRuntimeContext,
} from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import type { AppliedRefinementEdit, HarnessEntry, RefinementResult } from "./types";

export interface RefinementMemoryContext {
	save(input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	status(): Promise<MemoryBackendStatus>;
}

export function createRefinementMemoryContext(
	session: AgentSession,
	agentDir: string,
	cwd: string,
): RefinementMemoryContext {
	const runtime: MemoryRuntimeContext = createSessionMemoryRuntimeContext(session, agentDir, cwd);
	return {
		save: input => runtime.save(input),
		status: () => runtime.status(),
	};
}

function memorySaveInput(entry: HarnessEntry): MemoryBackendSaveInput {
	const importance = typeof entry.metadata.importance === "number" ? entry.metadata.importance : undefined;
	return {
		content: entry.content,
		context: entry.path ?? "refine",
		source: "refine",
		...(importance !== undefined ? { importance } : {}),
	};
}

/**
 * Sync the `after` snapshots of every applied memory-kind edit into the memory
 * backend. Returns a map of edit id → save result for terminal output.
 */
export async function syncAppliedMemoriesToBackend(
	context: RefinementMemoryContext,
	result: RefinementResult,
): Promise<Map<string, MemoryBackendSaveResult>> {
	const synced = new Map<string, MemoryBackendSaveResult>();
	for (const edit of result.appliedEdits) {
		if (edit.kind !== "memory" || !edit.applied || !edit.after) continue;
		try {
			synced.set(edit.id, await context.save(memorySaveInput(edit.after)));
		} catch {
			// The harness store is authoritative; a failed backend sync is
			// informational, not a refinement failure.
			synced.set(edit.id, {
				backend: "off",
				stored: 0,
				message: "backend sync failed; harness store still updated",
			});
		}
	}
	return synced;
}

/** True when the result contains applied memory edits (i.e. backend copies exist). */
export function resultHasSyncedMemories(result: RefinementResult): boolean {
	return result.appliedEdits.some(edit => edit.kind === "memory" && edit.applied && edit.after !== undefined);
}

/**
 * Note appended to rollback output when the rolled-back refinement had synced
 * memory entries: the harness store is restored, but backend copies persist.
 */
export function buildMemoryRollbackNote(result: RefinementResult): string | undefined {
	if (!resultHasSyncedMemories(result)) return undefined;
	return [
		"Note: the rolled-back refinement synced memory entries to the active memory backend.",
		"Those backend copies persist (backends are append-only); the harness store is restored.",
		"With the mnemopi backend, drop a stray copy with `memory_edit forget`.",
	].join(" ");
}

/** Summarize backend sync results for terminal output. */
export function formatMemorySyncSummary(synced: Map<string, MemoryBackendSaveResult>): string | undefined {
	if (synced.size === 0) return undefined;
	const lines = ["Memory backend sync:"];
	for (const [id, result] of synced) {
		const detail =
			result.stored > 0
				? `stored ${result.stored} (${result.backend}${result.ids?.length ? `, ids: ${result.ids.join(", ")}` : ""})`
				: (result.message ?? "not stored");
		lines.push(`  - memory:${id} — ${detail}`);
	}
	return lines.join("\n");
}

export type { AppliedRefinementEdit, MemoryBackendSaveResult };
