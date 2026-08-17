import { describe, expect, it } from "bun:test";
import { CONFIG_DIR_NAME, parseArgs } from "@cxn/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy shim CLI exports", () => {
	it("re-exports parseArgs and CONFIG_DIR_NAME from the legacy package root", () => {
		expect(CONFIG_DIR_NAME).toBe(".cxn");
		expect(parseArgs(["hello"]).messages).toEqual(["hello"]);
	});
});
