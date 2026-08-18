/**
 * Daemon family-store handler — the authoritative server side.
 *
 * This is the single source of truth for a family's registry + mailboxes when
 * the daemon is running: every `cxn agents` client (and any future
 * daemon-backed child kernel) talks to this handler, which delegates to the
 * same primitives as the in-process path in family-store.ts. That keeps the
 * daemon and in-process behaviors identical.
 */

import {
	deleteSubagentInFamily,
	listAgentsInFamily,
	listSubagentsInFamily,
	type RlmSubagentRegistryEntry,
	recvFromFamily,
	registerChildInFamily,
	sendToFamily,
} from "../../eval/py/family-store";
import { findCatalogModels } from "../../eval/py/rlm";
import type { DaemonRequestEnvelope, DaemonResponseEnvelope } from "./daemon-protocol";

/** Handle one daemon request against the authoritative family store. Never throws. */
export async function handleDaemonRequest(req: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> {
	try {
		const { familyId, from, command, payload } = req;
		let result: unknown;
		switch (command) {
			case "agent_message.send":
				result = sendToFamily(familyId, from.role, payload);
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
				result = { registered: entry.rlm_child_id };
				break;
			}
			case "rlm.list_subagents":
				result = { subagents: listSubagentsInFamily(familyId) };
				break;
			case "rlm.delete_subagent":
				result = deleteSubagentInFamily(familyId, String(payload.target ?? ""));
				break;
			case "find_models":
				result = { models: findCatalogModels(payload) };
				break;
			case "session.list":
				result = { agents: listAgentsInFamily(familyId) };
				break;
			default:
				throw new Error(`unknown daemon command: ${command}`);
		}
		return { id: req.id, ok: true, result };
	} catch (e) {
		return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
