/**
 * Daemon family-store handler — the authoritative server side.
 *
 * This is the single source of truth for a family's registry + mailboxes when
 * the daemon is running: every `cxn agents` client (and any future
 * daemon-backed child kernel) talks to this handler. Messaging delegates to the
 * same primitives as the in-process path in family-store.ts (so in-process and
 * daemon behavior stay identical), while the spawn topology lives in the
 * `RlmSpawnLedger` and session ownership in the `SessionLeaseRegistry`.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	deleteSubagentInFamily,
	listAgentsInFamily,
	type RlmSubagentRegistryEntry,
	recvFromFamily,
	registerChildInFamily,
	sendToFamily,
} from "../../eval/py/family-store";
import { findCatalogModels } from "../../eval/py/rlm";
import type { DaemonFrom, DaemonRequestEnvelope, DaemonResponseEnvelope } from "./daemon-protocol";
import { RlmSpawnLedger } from "./rlm-ledger";
import { SessionLeaseRegistry } from "./session-lease";

function defaultAgentDir(): string {
	const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
	return path.join(base, "cxn", "daemon");
}

/** The daemon's topology authority (spawn edges) — shared across all connections. */
const ledger = new RlmSpawnLedger();
/** Session-ownership registry for attach/stop. */
let leaseRegistry: SessionLeaseRegistry | null = null;

function ensureLeaseRegistry(): SessionLeaseRegistry {
	if (!leaseRegistry) leaseRegistry = new SessionLeaseRegistry(defaultAgentDir());
	return leaseRegistry;
}

/** Initialize daemon-side state. Call once at boot (or per test) with a writable dir. */
export function setupDaemonState(opts: { agentDir: string }): void {
	ledger.reset();
	leaseRegistry = new SessionLeaseRegistry(opts.agentDir);
}

/** Reset daemon-side state (topology + lease tables). Test-only convenience. */
export function resetDaemonState(): void {
	ledger.reset();
	leaseRegistry?.reset();
}

function ownerIdFor(from: DaemonFrom): string {
	return from.role === "child" && from.childId ? from.childId : "parent";
}

/** Handle one daemon request against the authoritative family store. Never throws. */
export async function handleDaemonRequest(req: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> {
	try {
		const { familyId, from, command, payload } = req;
		let result: unknown;
		switch (command) {
			case "agent_message.send":
				result = sendToFamily(familyId, { role: from.role, childId: from.childId }, payload);
				break;
			case "agent_message.recv": {
				// A child reads its own mailbox (keyed by its rlm_child_id); parent reads "parent".
				const key = from.role === "child" && from.childId ? from.childId : "parent";
				result = recvFromFamily(familyId, key, payload);
				break;
			}
			case "agent_message.list":
				result = { agents: listAgentsInFamily(familyId) };
				break;
			case "rlm.register_child": {
				const entry = payload.entry as RlmSubagentRegistryEntry;
				registerChildInFamily(familyId, entry);
				// The ledger is the topology authority: record the spawn edge.
				ledger.recordSpawn({
					parentId: familyId,
					childId: entry.rlm_child_id,
					name: entry.session_name,
					sessionId: entry.session_id,
				});
				result = { registered: entry.rlm_child_id };
				break;
			}
			case "rlm.list_subagents":
				// Read from the ledger (the topology authority), mapped to the registry shape.
				result = {
					subagents: ledger.childrenOf(familyId).map(e => ({
						rlm_child_id: e.childId,
						active_session_id: null,
						session_id: e.sessionId,
						session_name: e.name,
						session_dir: e.sessionDir ?? "",
						status: e.status,
					})),
				};
				break;
			case "rlm.delete_subagent": {
				const target = String(payload.target ?? "");
				result = deleteSubagentInFamily(familyId, target);
				ledger.remove(target);
				break;
			}
			case "find_models":
				result = { models: findCatalogModels(payload) };
				break;
			case "session.list":
				result = { agents: listAgentsInFamily(familyId) };
				break;
			case "session.attach": {
				const sessionDir = typeof payload.session_dir === "string" ? payload.session_dir : undefined;
				if (!sessionDir) throw new Error("session.attach requires session_dir");
				const lease = await ensureLeaseRegistry().acquire(sessionDir, ownerIdFor(from));
				result = { attached: true, sessionPath: lease.sessionPath, token: lease.token };
				break;
			}
			case "session.stop": {
				const sessionDir = typeof payload.session_dir === "string" ? payload.session_dir : undefined;
				if (!sessionDir) throw new Error("session.stop requires session_dir");
				const released = await ensureLeaseRegistry().release(sessionDir, ownerIdFor(from));
				result = { released };
				break;
			}
			default:
				throw new Error(`unknown daemon command: ${command}`);
		}
		return { id: req.id, ok: true, result };
	} catch (e) {
		return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
