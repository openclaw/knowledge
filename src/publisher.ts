// Internal compatibility entry point; all read/write coordination lives in storage.
export { KnowledgeStorage as Publisher, scopeKey, type PublicationHook } from "./storage.js";
