import { isBunTestRuntime } from "@cxn/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
