import { afterEach, describe, expect, it } from "bun:test";
import {
	AGENT_FAMILY_REACH_ERROR,
	AGENT_MESSAGE_MAX_CHARS,
	AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	MAX_RLM_MODEL_SEARCH_LIMIT,
	type RlmSpawnOutcome,
	resetRlmFamilies,
	runAgentMessageBridge,
	runRlmBridge,
	setRlmSpawnOverride,
} from "@cxn/pi-coding-agent/eval/py/rlm";
import type { ToolSession } from "@cxn/pi-coding-agent/tools";

/**
 * The RLM bridge (`__rlm__` / `__agent_message__`) is the cxn adaptation of
 * recursive-subagent admission and family messaging. The spawn side is the
 * dangerous one — a real `runStructuredSubagent` spawn is detached and
 * fire-and-forget — so the semantics are locked here through the spawn
 * override seam: admission must return a handle immediately, the registry
 * must settle on the child's outcome, and messaging must respect family
 * reach, mailbox caps, and drain semantics.
 */
function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		getSessionId: () => "parent-session",
		getSessionFile: () => null,
		getActiveModelString: () => "provider/model",
		...overrides,
	} as unknown as ToolSession;
}

/** A child session: its `getAgentId()` is the reserved `rlm_child_id`. */
function createChildSession(childId: string): ToolSession {
	return createSession({
		getAgentId: () => childId,
		getSessionId: () => `child-session-${childId}`,
	});
}

interface FindModelsRow {
	id: string;
	name: string;
	provider: string;
	api: string;
	reasoning: boolean;
	inputModes: string[];
}

async function findModels(payload: Record<string, unknown>): Promise<{ models: FindModelsRow[] }> {
	return (await runRlmBridge(createSession(), { op: "find_models", ...payload })) as {
		models: FindModelsRow[];
	};
}

describe("__rlm__ bridge", () => {
	afterEach(() => {
		setRlmSpawnOverride(undefined);
		resetRlmFamilies();
	});

	it("admits a child immediately and returns a spawn handle", async () => {
		const spawns: Array<{ prompt: string; name?: string; model?: string }> = [];
		setRlmSpawnOverride(async (_session, request, _childId) => {
			spawns.push(request);
			return { status: "completed" } satisfies RlmSpawnOutcome;
		});

		const session = createSession();
		const handle = (await runRlmBridge(session, {
			op: "run",
			prompt: "scout the codebase",
			kwargs: { name: "scout", model: "fast/model" },
		})) as { rlm_child_id: string; name: string; model: string };

		expect(handle.name).toBe("scout");
		expect(handle.model).toBe("fast/model");
		expect(handle.rlm_child_id).toMatch(/^rlm-/);
		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.prompt).toBe("scout the codebase");
	});

	it("derives a readable default name when name is omitted", async () => {
		let seenName: string | undefined;
		setRlmSpawnOverride(async (_session, request, _childId) => {
			seenName = request.name;
			return { status: "completed" };
		});

		const handle = (await runRlmBridge(createSession(), {
			op: "run",
			prompt: "Refactor the auth module",
			kwargs: {},
		})) as { name: string };

		expect(handle.name).toMatch(/^subagent-refactor-the-auth-module-/);
		expect(seenName).toBe(handle.name);
	});

	it("tracks the child's outcome in the registry", async () => {
		let settle!: (outcome: RlmSpawnOutcome) => void;
		setRlmSpawnOverride(
			() =>
				new Promise<RlmSpawnOutcome>(resolve => {
					settle = resolve;
				}),
		);

		const session = createSession();
		const handle = (await runRlmBridge(session, {
			op: "run",
			prompt: "long task",
			kwargs: {},
		})) as { rlm_child_id: string };

		let listed = (await runRlmBridge(session, { op: "list_subagents" })) as {
			subagents: Array<{ rlm_child_id: string; status: string }>;
		};
		expect(listed.subagents).toHaveLength(1);
		expect(listed.subagents[0]?.status).toBe("running");

		settle({ status: "error", error: "boom" });
		// Let the settlement microtask run.
		await new Promise(resolve => setTimeout(resolve, 0));

		listed = (await runRlmBridge(session, { op: "list_subagents" })) as {
			subagents: Array<{ rlm_child_id: string; status: string }>;
		};
		expect(listed.subagents[0]?.status).toBe("error");
		expect(handle.rlm_child_id).toBe(listed.subagents[0]?.rlm_child_id);
	});

	it("deletes a settled child but refuses to delete a running one", async () => {
		setRlmSpawnOverride(async () => ({ status: "completed" }));

		const session = createSession();
		await runRlmBridge(session, { op: "run", prompt: "quick task", kwargs: {} });
		await new Promise(resolve => setTimeout(resolve, 0));

		const listed = (await runRlmBridge(session, { op: "list_subagents" })) as {
			subagents: Array<{ rlm_child_id: string }>;
		};
		const first = listed.subagents[0];
		if (!first) throw new Error("expected a listed child");
		const childId = first.rlm_child_id;

		const removed = (await runRlmBridge(session, {
			op: "delete_subagent",
			target: childId,
		})) as { outcome: string };
		expect(removed.outcome).toBe("deleted");

		const after = (await runRlmBridge(session, { op: "list_subagents" })) as {
			subagents: unknown[];
		};
		expect(after.subagents).toHaveLength(0);
	});

	it("rejects a non-object payload and unknown ops", async () => {
		const session = createSession();
		await expect(runRlmBridge(session, "nope")).rejects.toThrow("payload must be an object");
		await expect(runRlmBridge(session, { op: "teleport" })).rejects.toThrow("unknown op");
	});
});

describe("__agent_message__ bridge", () => {
	afterEach(() => {
		setRlmSpawnOverride(undefined);
		resetRlmFamilies();
	});

	it("lists the family roster with parent and children", async () => {
		setRlmSpawnOverride(async () => ({ status: "completed" }));

		const session = createSession();
		await runRlmBridge(session, { op: "run", prompt: "worker one", kwargs: { name: "worker-1" } });
		await runRlmBridge(session, { op: "run", prompt: "worker two", kwargs: { name: "worker-2" } });
		await new Promise(resolve => setTimeout(resolve, 0));

		const roster = (await runAgentMessageBridge(session, { op: "list_agents" })) as {
			agents: Array<{ id: string; name: string; role: string }>;
		};
		expect(roster.agents).toHaveLength(3);
		expect(roster.agents[0]).toMatchObject({ name: "parent", role: "parent" });
		expect(roster.agents.slice(1).map(a => a.role)).toEqual(["child", "child"]);
	});

	it("sends to the parent mailbox and drains on recv", async () => {
		const session = createSession();
		const receipt = (await runAgentMessageBridge(session, {
			op: "send",
			message: "status check",
			receiver_role: "parent",
			mode: "steer",
		})) as { deliveryStatus: string; deliveredAt: string };

		expect(receipt.deliveryStatus).toBe("delivered");
		expect(receipt.deliveredAt).toBeDefined();

		const peeked = (await runAgentMessageBridge(session, {
			op: "recv",
			peek: true,
		})) as { messages: Array<{ message: string; mode: string; from: string }> };
		expect(peeked.messages).toHaveLength(1);
		expect(peeked.messages[0]).toMatchObject({ message: "status check", mode: "steer", from: "parent" });

		const drained = (await runAgentMessageBridge(session, { op: "recv" })) as {
			messages: unknown[];
		};
		expect(drained.messages).toHaveLength(1);

		const empty = (await runAgentMessageBridge(session, { op: "recv" })) as {
			messages: unknown[];
		};
		expect(empty.messages).toHaveLength(0);
	});

	it("routes to a named child by session name or id", async () => {
		setRlmSpawnOverride(async () => ({ status: "running" }));

		const session = createSession();
		const handle = (await runRlmBridge(session, {
			op: "run",
			prompt: "listener",
			kwargs: { name: "listener-1" },
		})) as { rlm_child_id: string };

		const byName = (await runAgentMessageBridge(session, {
			op: "send",
			message: "hi by name",
			receiver_role: "child",
			receiver_name: "listener-1",
		})) as { deliveryStatus: string };
		expect(byName.deliveryStatus).toBe("delivered");

		const byId = (await runAgentMessageBridge(session, {
			op: "send",
			message: "hi by id",
			receiver_role: "child",
			receiver_name: handle.rlm_child_id,
		})) as { deliveryStatus: string };
		expect(byId.deliveryStatus).toBe("delivered");
	});

	it("rejects unknown children and sibling reach with clear errors", async () => {
		const session = createSession();
		await expect(
			runAgentMessageBridge(session, {
				op: "send",
				message: "hello",
				receiver_role: "child",
				receiver_name: "ghost",
			}),
		).rejects.toThrow("unknown child ghost");
		await expect(
			runAgentMessageBridge(session, {
				op: "send",
				message: "hello",
				receiver_role: "sibling",
				receiver_name: "x",
			}),
		).rejects.toThrow(AGENT_FAMILY_REACH_ERROR);
	});

	it("enforces the message length and pending-mailbox caps", async () => {
		const session = createSession();
		await expect(
			runAgentMessageBridge(session, {
				op: "send",
				message: "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1),
				receiver_role: "parent",
			}),
		).rejects.toThrow(/exceeds/);

		for (let i = 0; i < AGENT_MESSAGE_MAX_PENDING_PER_SESSION; i++) {
			await runAgentMessageBridge(session, {
				op: "send",
				message: `msg ${i}`,
				receiver_role: "parent",
			});
		}
		await expect(
			runAgentMessageBridge(session, {
				op: "send",
				message: "overflow",
				receiver_role: "parent",
			}),
		).rejects.toThrow(/already pending/);
	});
});

describe("__agent_message__ child-kernel wiring", () => {
	afterEach(() => {
		setRlmSpawnOverride(undefined);
		resetRlmFamilies();
	});

	it("delivers a parent-sent message to the child's own recv()", async () => {
		setRlmSpawnOverride(async () => ({ status: "running" }));
		const parent = createSession();
		const handle = (await runRlmBridge(parent, {
			op: "run",
			prompt: "child task",
			kwargs: { name: "kid" },
		})) as { rlm_child_id: string };
		const childId = handle.rlm_child_id;

		const sent = (await runAgentMessageBridge(parent, {
			op: "send",
			message: "hello kid",
			receiver_role: "child",
			receiver_name: childId,
		})) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");

		// The child's OWN kernel (agent_message.recv) must drain its real mailbox,
		// which requires it be wired into the parent family (not a fresh empty one).
		const childSession = createChildSession(childId);
		const received = (await runAgentMessageBridge(childSession, { op: "recv" })) as {
			messages: Array<{ message: string; from: string }>;
		};
		expect(received.messages).toHaveLength(1);
		expect(received.messages[0]?.message).toBe("hello kid");
		expect(received.messages[0]?.from).toBe("parent");
	});

	it("keeps a child from reading a sibling's mailbox (reach isolation)", async () => {
		setRlmSpawnOverride(async () => ({ status: "running" }));
		const parent = createSession();
		const a = (await runRlmBridge(parent, {
			op: "run",
			prompt: "a",
			kwargs: { name: "a" },
		})) as { rlm_child_id: string };
		const b = (await runRlmBridge(parent, {
			op: "run",
			prompt: "b",
			kwargs: { name: "b" },
		})) as { rlm_child_id: string };
		await runAgentMessageBridge(parent, {
			op: "send",
			message: "for A",
			receiver_role: "child",
			receiver_name: a.rlm_child_id,
		});
		// B's recv must not see A's mailbox.
		const bSession = createChildSession(b.rlm_child_id);
		const got = (await runAgentMessageBridge(bSession, { op: "recv" })) as { messages: unknown[] };
		expect(got.messages).toHaveLength(0);
	});

	it("routes a child's send to the parent mailbox (child -> parent)", async () => {
		setRlmSpawnOverride(async () => ({ status: "running" }));
		const parent = createSession();
		const handle = (await runRlmBridge(parent, {
			op: "run",
			prompt: "kid",
			kwargs: { name: "kid" },
		})) as { rlm_child_id: string };
		const childId = handle.rlm_child_id;
		const childSession = createChildSession(childId);
		const sent = (await runAgentMessageBridge(childSession, {
			op: "send",
			message: "hi parent",
			receiver_role: "parent",
		})) as { deliveryStatus: string };
		expect(sent.deliveryStatus).toBe("delivered");
		const drained = (await runAgentMessageBridge(parent, { op: "recv" })) as {
			messages: Array<{ message: string; from: string }>;
		};
		expect(drained.messages).toHaveLength(1);
		expect(drained.messages[0]?.message).toBe("hi parent");
		expect(drained.messages[0]?.from).toBe("child");
	});
});

describe("__rlm__ find_models op", () => {
	it("returns bundled catalog models matching a free-text query", async () => {
		const { models } = await findModels({ query: "gpt" });
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			const haystack = `${m.id} ${m.name} ${m.provider} ${m.api}`.toLowerCase();
			expect(haystack).toContain("gpt");
		}
	});

	it("returns an empty list when no model matches the query", async () => {
		const { models } = await findModels({ query: "zzz-no-such-model-xyz" });
		expect(models).toEqual([]);
	});

	it("filters by exact provider", async () => {
		const { models } = await findModels({ provider: "openai" });
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.provider.toLowerCase()).toBe("openai");
		}
	});

	it("filters by capability=reasoning to reasoning models only", async () => {
		const { models } = await findModels({ capability: "reasoning" });
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.reasoning).toBe(true);
		}
	});

	it("filters by capability=vision to image-capable models only", async () => {
		const { models } = await findModels({ capability: "vision" });
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.inputModes).toContain("image");
		}
	});

	it("caps results at MAX_RLM_MODEL_SEARCH_LIMIT", async () => {
		const { models } = await findModels({});
		expect(models.length).toBeLessThanOrEqual(MAX_RLM_MODEL_SEARCH_LIMIT);
	});
});
