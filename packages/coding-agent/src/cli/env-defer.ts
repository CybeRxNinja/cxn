// Signals @cxn/pi-utils/env to defer its one-time `.env` load.
//
// The CLI entry graph must not load `.env` at import time: doing so would read
// `$HOME/.env` (and the profile/agent `.env`) before `setProfile` has chosen the
// active profile, so the load would target the wrong agent directory and leak the
// user's dotenv into the entry graph (see test/eval/process-entry-import.test.ts).
// Instead the CLI calls `markEnvReady()` from `runCli` right after `setProfile`,
// which performs the deferred load with the correct profile context.
//
// This module is imported FIRST by cli.ts so the flag is present before any
// `@cxn/pi-utils` module that pulls in `env.ts` is evaluated. Non-CLI entry points
// (the SDK, tooling probes, and tests such as packages/utils/test/profiles.test.ts)
// import `env.ts` directly and deliberately keep the eager load so directory
// resolvers honor profile `.env` XDG keys.
process.env.__CXN_ENV_DEFER_LOAD = "1";

export {};
