import { describe, expect, it } from "bun:test";
import {
	type AgentFamilyCatalogEntry,
	assertAgentFamilyReach,
	buildAgentFamilyRoster,
} from "@cyberxninja-omp/pi-coding-agent/eval/py/family-reach";

const parent: AgentFamilyCatalogEntry = {
	id: "main",
	name: "parent",
	depth: 0,
	status: "running",
	parentSessionId: undefined,
};
const childA: AgentFamilyCatalogEntry = {
	id: "rlm-a",
	name: "a",
	depth: 1,
	status: "running",
	parentSessionId: "main",
};
const childB: AgentFamilyCatalogEntry = {
	id: "rlm-b",
	name: "b",
	depth: 1,
	status: "running",
	parentSessionId: "main",
};

describe("assertAgentFamilyReach (ported verbatim from the upstream agent runtime)", () => {
	it("allows parent -> child", () => {
		expect(assertAgentFamilyReach(parent, childA)).toBe("child");
	});

	it("allows child -> parent", () => {
		expect(assertAgentFamilyReach(childA, parent)).toBe("parent");
	});

	it("allows child -> sibling (same parent, same depth)", () => {
		expect(assertAgentFamilyReach(childA, childB)).toBe("sibling");
	});

	it("throws for a target outside the nuclear family", () => {
		const stranger: AgentFamilyCatalogEntry = {
			id: "rlm-x",
			name: "x",
			depth: 1,
			status: "running",
			parentSessionId: "other-parent",
		};
		expect(() => assertAgentFamilyReach(parent, stranger)).toThrow();
		expect(() => assertAgentFamilyReach(childA, stranger)).toThrow();
	});

	it("throws for self-target", () => {
		expect(() => assertAgentFamilyReach(parent, parent)).toThrow();
		expect(() => assertAgentFamilyReach(childA, childA)).toThrow();
	});
});

describe("buildAgentFamilyRoster", () => {
	it("returns children for a root and parent + siblings for a child", () => {
		const rootRoster = buildAgentFamilyRoster(parent, [parent, childA, childB]);
		expect(rootRoster.current).toEqual({ name: "parent", id: "main", depth: 0 });
		// A root has no parent row; only its children appear.
		expect(rootRoster.entries.map(e => e.relationship)).toEqual(["child", "child"]);

		const childRoster = buildAgentFamilyRoster(childA, [parent, childA, childB]);
		expect(childRoster.current).toEqual({ name: "a", id: "rlm-a", depth: 1 });
		// A child's roster shows its parent plus its siblings.
		expect(childRoster.entries.map(e => e.relationship)).toEqual(["parent", "sibling"]);
	});
});
