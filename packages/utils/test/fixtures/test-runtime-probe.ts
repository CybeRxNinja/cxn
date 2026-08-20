import { isBunTestRuntime } from "@cyberxninja-omp/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
