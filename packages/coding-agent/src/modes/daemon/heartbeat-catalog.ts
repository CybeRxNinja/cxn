/**
 * Heartbeat catalog — tracks last-seen timestamps for daemon-managed agents
 * and sessions so the supervisor can reap dead/idle ones and reclaim their
 * leases. In-memory for Phase 5; Phase 6 can seed it from durable state.
 */

export class HeartbeatCatalog {
	/** agent/session id -> last-seen epoch ms. */
	#lastSeen = new Map<string, number>();

	/** Record activity for an id (defaults to "now"). */
	touch(id: string, at: number = Date.now()): void {
		this.#lastSeen.set(id, at);
	}

	/** Last-seen epoch ms for an id, or undefined if never seen. */
	seen(id: string): number | undefined {
		return this.#lastSeen.get(id);
	}

	/** Ids whose last-seen is at least `ttlMs` old relative to `now`. */
	staleIds(ttlMs: number, now: number = Date.now()): string[] {
		const out: string[] = [];
		for (const [id, t] of this.#lastSeen) {
			if (now - t >= ttlMs) out.push(id);
		}
		return out;
	}

	/** Forget an id (e.g. after it has been reaped). */
	remove(id: string): void {
		this.#lastSeen.delete(id);
	}

	/** Drop all tracked ids. */
	reset(): void {
		this.#lastSeen.clear();
	}
}
