import { afterEach, describe, expect, it } from "bun:test";
import { resetRlmFamilies } from "@cyberxninja-omp/pi-coding-agent/eval/py/family-store";
import { RlmSpawnLedger } from "@cyberxninja-omp/pi-coding-agent/modes/daemon/rlm-ledger";

describe("RlmSpawnLedger (topology authority)", () => {
	afterEach(() => resetRlmFamilies());

	it("records spawn edges and derives depth from the parent chain", () => {
		const ledger = new RlmSpawnLedger();
		ledger.recordSpawn({ parentId: "main", childId: "rlm-a", name: "a", sessionId: "s-a" });
		// Nested: rlm-a spawns rlm-b.
		ledger.recordSpawn({ parentId: "rlm-a", childId: "rlm-b", name: "b", sessionId: "s-b" });

		const catalog = ledger.getCatalog();
		const a = catalog.find(e => e.id === "rlm-a");
		const b = catalog.find(e => e.id === "rlm-b");
		const root = catalog.find(e => e.id === "main");
		expect(root?.depth).toBe(0);
		expect(a?.depth).toBe(1);
		expect(a?.parentSessionId).toBe("main");
		expect(b?.depth).toBe(2);
		expect(b?.parentSessionId).toBe("rlm-a");

		expect(ledger.childrenOf("main").map(e => e.childId)).toEqual(["rlm-a"]);
		expect(ledger.parentOf("rlm-b")).toBe("rlm-a");
	});

	it("reflects status changes and removal", () => {
		const ledger = new RlmSpawnLedger();
		ledger.recordSpawn({ parentId: "main", childId: "rlm-a", name: "a", sessionId: null });
		ledger.setStatus("rlm-a", "completed");
		expect(ledger.getCatalog().find(e => e.id === "rlm-a")?.status).toBe("idle");
		ledger.remove("rlm-a");
		expect(ledger.getCatalog().find(e => e.id === "rlm-a")).toBeUndefined();
	});

	it("round-trips through JSON for Phase 6 durability", () => {
		const ledger = new RlmSpawnLedger();
		ledger.recordSpawn({ parentId: "main", childId: "rlm-a", name: "a", sessionId: "s-a" });
		const snapshot = ledger.toJSON();
		const other = new RlmSpawnLedger();
		other.loadJSON(snapshot);
		expect(other.childrenOf("main")).toHaveLength(1);
		expect(other.childrenOf("main")[0]?.childId).toBe("rlm-a");
	});
});
