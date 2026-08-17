import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@cxn/pi-coding-agent/internal-urls";

describe("OmpProtocolHandler", () => {
	it("treats cxn://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("cxn://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("cxn://tools/read.md");
		const prefixed = await router.resolve("cxn://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
