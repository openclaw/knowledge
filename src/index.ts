import { Type } from "typebox";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { getToolPluginMetadata, toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { VaultConfig } from "./real-vault.js";

const feature = defineFeaturePlugin({
  contract, name: "Knowledge", description: "Evidence-backed knowledge, inspectable in OpenClaw.",
  setup: createKnowledgeService,
});
// This host's feature helper has no config option. Compose its shared adapters
// with the public entry/config and build-metadata SDK, without duplicating them.
const configSchema = Type.Object({ vault: Type.Optional(VaultConfig) }, { additionalProperties: false });
const entry = definePluginEntry({ ...feature, configSchema: buildJsonPluginConfigSchema({ ...configSchema }) });
Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: { ...getToolPluginMetadata(feature), configSchema }, enumerable: false,
});
export default entry;
