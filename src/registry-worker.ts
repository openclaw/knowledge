// Worker-thread entry for the store registry. Registry SQLite and store
// provisioning file work run here, never on the Gateway main thread.
import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const data = workerData as { sdk: Record<string, string>; stateRoot: string };
registerHooks({ resolve(specifier, context, next) { const url = data.sdk[specifier]; return url ? { url, shortCircuit: true } : next(specifier, context); } });
const { serveRegistry } = await import("./registry-host.js");
serveRegistry(parentPort!, data.stateRoot);
