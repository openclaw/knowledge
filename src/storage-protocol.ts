import type { VaultAccess } from "./access.js";
import type { StorageOperations } from "./storage-host.js";

// Messages between the main thread (StorageClient) and the storage worker.
export type HostMessage = { type: "call"; id: number; op: keyof StorageOperations; input: unknown; scope: VaultAccess["scope"]; agentId: string };
export type WorkerMessage = { type: "assert"; id: number } | { type: "done"; id: number; ok: true; value: unknown } | { type: "done"; id: number; ok: false; message: string };
/** Error thrown in the worker when the main thread reports lost authority; the
 * client replaces it with the main thread's original error. */
export const AUTHORITY_REVOKED = "Knowledge authority changed during the operation.";
