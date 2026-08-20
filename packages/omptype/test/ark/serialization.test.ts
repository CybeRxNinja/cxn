import { expect, it } from "bun:test";
import { type } from "@cyberxninja-omp/omptype/ark";

it("built-in prototypes", () => {
	const A = type({
		age: "number",
	});

	const B = type({
		ages: A.array(),
	});

	const serialized = JSON.stringify(B.toJsonSchema());
	const deserialized: unknown = JSON.parse(serialized);

	expect(deserialized).toEqual(B.toJsonSchema());
});
