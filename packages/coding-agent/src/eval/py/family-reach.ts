/**
 * Nuclear-family reach policy — ported verbatim from prime-agent
 * `core/agent-messages.ts` (`assertAgentFamilyReach` and its helpers).
 *
 * This is the RLM agent-message SECURITY BOUNDARY: reach is limited to a
 * session's parent, siblings, and children, computed purely from persisted
 * parent-edge snapshots (depth + shared parent). It must not be re-derived or
 * "simplified" — any change to this logic is a change to who can message whom.
 *
 * The only adaptation from upstream is dropping the unrelated imports
 * (`AgentMessage` from `@earendil-works/pi-agent-core`, name-reservation
 * helpers) that the reach functions do not depend on.
 */

export type AgentFamilyStatus = "running" | "idle" | "inactive";
export type AgentFamilyRelationship = "parent" | "sibling" | "child";

export const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

export interface AgentFamilyCatalogEntry {
	id: string;
	name?: string;
	depth: number;
	status: AgentFamilyStatus;
	repliedSinceTask?: boolean;
	parentSessionId?: string;
	parentSessionPath?: string;
	sessionPath?: string;
}

export interface AgentFamilyRosterEntry {
	relationship: AgentFamilyRelationship;
	name: string;
	id: string;
	depth: number;
	status: AgentFamilyStatus;
	repliedSinceTask?: boolean;
}

export interface AgentFamilyRosterResult {
	current: { name: string; id: string; depth: number };
	entries: AgentFamilyRosterEntry[];
}

export interface AgentSessionNameScope {
	parentSessionId?: string;
	parentSessionPath?: string;
	depth: number;
}

function sameAgentFamilyParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): boolean {
	if (left.parentSessionPath !== undefined && left.parentSessionPath === right.parentSessionPath) {
		return true;
	}
	if (left.parentSessionId !== undefined && left.parentSessionId === right.parentSessionId) {
		return true;
	}
	const hasCatalogParentPair = (parentSessionId: string | undefined, parentSessionPath: string | undefined) =>
		parentSessionId !== undefined &&
		parentSessionPath !== undefined &&
		catalog.some(
			entry =>
				(entry.id === parentSessionId && entry.sessionPath === parentSessionPath) ||
				(entry.parentSessionId === parentSessionId && entry.parentSessionPath === parentSessionPath),
		);
	if (
		hasCatalogParentPair(left.parentSessionId, right.parentSessionPath) ||
		hasCatalogParentPair(right.parentSessionId, left.parentSessionPath)
	) {
		return true;
	}
	if (
		left.depth === 0 &&
		right.depth === 0 &&
		left.parentSessionPath === undefined &&
		right.parentSessionPath === undefined &&
		left.parentSessionId === undefined &&
		right.parentSessionId === undefined
	) {
		return true;
	}
	// Unresolved mixed identifiers stay unrelated to avoid false name conflicts across families.
	return false;
}

function isAgentFamilyParent(parent: AgentFamilyCatalogEntry, child: AgentFamilyCatalogEntry): boolean {
	return (
		(child.parentSessionPath !== undefined && child.parentSessionPath === parent.sessionPath) ||
		(child.parentSessionId !== undefined && child.parentSessionId === parent.id)
	);
}

/** Pure nuclear-family policy over persisted parent-edge snapshots. */
export function agentFamilyRelationship(
	current: AgentFamilyCatalogEntry,
	target: AgentFamilyCatalogEntry,
): AgentFamilyRelationship | undefined {
	if (current.id === target.id) return undefined;
	if (isAgentFamilyParent(target, current)) return "parent";
	if (isAgentFamilyParent(current, target)) return "child";
	if (current.depth === target.depth && sameAgentFamilyParent(current, target, [current, target])) return "sibling";
	return undefined;
}

export function assertAgentFamilyReach(
	current: AgentFamilyCatalogEntry,
	target: AgentFamilyCatalogEntry,
): AgentFamilyRelationship {
	const relationship = agentFamilyRelationship(current, target);
	if (!relationship) throw new Error(AGENT_FAMILY_REACH_ERROR);
	return relationship;
}

export function buildAgentFamilyRoster(
	current: AgentFamilyCatalogEntry,
	catalog: readonly AgentFamilyCatalogEntry[],
): AgentFamilyRosterResult {
	const parent = catalog.find(entry => isAgentFamilyParent(entry, current));
	const siblings = catalog.filter(
		entry =>
			entry.id !== current.id && entry.depth === current.depth && sameAgentFamilyParent(entry, current, catalog),
	);
	const children = catalog.filter(entry => entry.depth === current.depth + 1 && isAgentFamilyParent(current, entry));
	const row = (relationship: AgentFamilyRelationship, entry: AgentFamilyCatalogEntry): AgentFamilyRosterEntry => ({
		relationship,
		name: entry.name ?? entry.id,
		id: entry.id,
		depth: entry.depth,
		status: entry.status,
		...(relationship === "child" && entry.repliedSinceTask !== undefined
			? { repliedSinceTask: entry.repliedSinceTask }
			: {}),
	});
	return {
		current: {
			name: current.name ?? current.id,
			id: current.id,
			depth: current.depth,
		},
		entries: [
			...(parent ? [row("parent", parent)] : []),
			...siblings.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map(entry => row("sibling", entry)),
			...children.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map(entry => row("child", entry)),
		],
	};
}
