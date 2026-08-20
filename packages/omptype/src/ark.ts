/**
 * ArkType compatibility facade — `@cyberxninja-omp/omptype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the omptype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@cyberxninja-omp/omptype/ark"` and nothing else changes. New code should
 * import `@cyberxninja-omp/omptype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `OmpError` /
 * `OmpErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { OmpError, OmpErrors } from "./errors";

export * from "./index";

export const ArkError = OmpError;
export type ArkError = OmpError;
export const ArkErrors = OmpErrors;
export type ArkErrors = OmpErrors;
