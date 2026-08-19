import { describe, expect, it } from "bun:test";
import {
	DaemonClient,
	type DaemonRequestHandler,
	inMemoryPair,
	serveConnection,
} from "@cxn/pi-coding-agent/modes/daemon/index";

const handler: DaemonRequestHandler = req => ({
	id: req.id,
	ok: true,
	result: { echoed: req.command, familyId: req.familyId },
});

describe("DaemonClient reconnect/retry", () => {
	it("reconnects via the factory and retries the request after a stream drop", async () => {
		const pair1 = inMemoryPair();
		const pair2 = inMemoryPair();
		void serveConnection(pair1.server, handler);

		const client = new DaemonClient(pair1.client, {
			reconnect: async () => {
				void serveConnection(pair2.server, handler);
				return pair2.client;
			},
			maxRetries: 1,
		});

		// Drop the first connection; the client's pump observes the end and reconnects.
		pair1.drop();

		// The request should reconnect to pair2 and succeed.
		const res = (await client.request("find_models", {}, { role: "parent" }, "fam")) as { echoed: string };
		expect(res.echoed).toBe("find_models");
		await client.close();
	});

	it("does not retry when no reconnect factory is configured", async () => {
		const pair = inMemoryPair();
		// Slow handler so the response cannot arrive before we drop the connection.
		void serveConnection(pair.server, async req => {
			await Bun.sleep(50);
			return { id: req.id, ok: true, result: {} };
		});
		const client = new DaemonClient(pair.client);
		const pending = client.request("find_models", {}, { role: "parent" }, "fam");
		// The connection drops; with no reconnect factory the in-flight request fails.
		pair.drop();
		await expect(pending).rejects.toThrow();
	});

	it("survives a reconnect mid-conversation for sequential requests", async () => {
		const pair1 = inMemoryPair();
		const pair2 = inMemoryPair();
		void serveConnection(pair1.server, handler);
		const client = new DaemonClient(pair1.client, {
			reconnect: async () => {
				void serveConnection(pair2.server, handler);
				return pair2.client;
			},
			maxRetries: 1,
		});
		// First request works on pair1.
		const first = (await client.request("find_models", {}, { role: "parent" }, "fam")) as { echoed: string };
		expect(first.echoed).toBe("find_models");
		// Drop, then a second request reconnects to pair2.
		pair1.drop();
		const second = (await client.request("agent_message.send", {}, { role: "parent" }, "fam")) as { echoed: string };
		expect(second.echoed).toBe("agent_message.send");
		await client.close();
	});
});
