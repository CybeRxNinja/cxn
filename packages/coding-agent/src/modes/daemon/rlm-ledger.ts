/**
 * RLM spawn ledger — the daemon's authoritative topology record.
 *
 * Tracks parent→child spawn edges (id, name, session id, status) so family
 * reach, rosters, and `cxn agents` can be computed from a single source
 * instead of re-derived from per-session registries. This in-memory form is
 * the Phase 3 authority; Phase 6 adds the durable on-disk JSONL (seeded from
 * `toJSON()`/`loadJSON()` below) so it survives compaction/restart.
 *
 * Design note: prime-agent's `RlmSpawnLedger` is a durable append-only file
 * with multi-writer atomicity and torn-line repair. That durability belongs to
 * Phase 6; here we keep the same *data model* and the same last-writer-wins
 * per-child semantics, in memory, so reach/roster logic is identical and the
 * file layer is a drop-in later.
 */

import type { AgentFamilyCatalogEntry, AgentFamilyStatus } from "../../eval/py/family-reach";
import type { RlmChildStatus } from "../../eval/py/family-store";

export interface RlmSpawnEdge {
	childId: string;
	parentId: string;
	name: string;
	sessionId: string | null;
	status: RlmChildStatus;
}

function toFamilyStatus(status: RlmChildStatus): AgentFamilyStatus {
	return status === "completed" ? "idle" : status === "error" ? "inactive" : "running";
}

export class RlmSpawnLedger {
	/** Last-writer-wins per childId. */
	#edges = new Map<string, RlmSpawnEdge>();

	/** Record (or update) a spawn edge. Re-recording the same child overwrites. */
	recordSpawn(input: { parentId: string; childId: string; name: string; sessionId: string | null }): void {
		this.#edges.set(input.childId, {
			childId: input.childId,
			parentId: input.parentId,
			name: input.name,
			sessionId: input.sessionId,
			status: "running",
		});
	}

	setStatus(childId: string, status: RlmChildStatus): void {
		const edge = this.#edges.get(childId);
		if (!edge) return;
		edge.status = status;
	}

	remove(childId: string): void {
		this.#edges.delete(childId);
	}

	edges(): RlmSpawnEdge[] {
		return [...this.#edges.values()];
	}

	childrenOf(parentId: string): RlmSpawnEdge[] {
		return this.edges().filter(e => e.parentId === parentId);
	}

	parentOf(childId: string): string | undefined {
		return this.#edges.get(childId)?.parentId;
	}

	/** All recorded edges as a catalog, with depth derived from the parent chain. */
	getCatalog(): AgentFamilyCatalogEntry[] {
		const childIds = new Set(this.#edges.keys());
		const depthCache = new Map<string, number>();
		const depthOf = (id: string): number => {
			const cached = depthCache.get(id);
			if (cached !== undefined) return cached;
			const parentId = this.#edges.get(id)?.parentId;
			// A node with no parent edge is a root (depth 0); otherwise depth = parent depth + 1.
			const depth = parentId === undefined ? 0 : depthOf(parentId) + 1;
			depthCache.set(id, depth);
			return depth;
		};
		const entries: AgentFamilyCatalogEntry[] = [];
		for (const edge of this.#edges.values()) {
			entries.push({
				id: edge.childId,
				name: edge.name,
				depth: depthOf(edge.childId),
				status: toFamilyStatus(edge.status),
				parentSessionId: edge.parentId,
			});
		}
		// Roots (parents that are not children of anyone) get explicit catalog rows.
		const rootIds = new Set<string>();
		for (const edge of this.#edges.values()) {
			if (!childIds.has(edge.parentId)) rootIds.add(edge.parentId);
		}
		for (const rootId of rootIds) {
			entries.push({ id: rootId, name: rootId, depth: 0, status: "running", parentSessionId: undefined });
		}
		return entries;
	}

	reset(): void {
		this.#edges.clear();
	}

	/** Serializable snapshot for Phase 6 on-disk durability. */
	toJSON(): { edges: RlmSpawnEdge[] } {
		return { edges: this.edges() };
	}

	loadJSON(snapshot: { edges: RlmSpawnEdge[] }): void {
		this.#edges.clear();
		for (const edge of snapshot.edges) this.#edges.set(edge.childId, { ...edge });
	}
}
