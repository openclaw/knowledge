import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";

/** The UI explicitly requests its vocabulary detail and follows every page. */
export async function loadVocabulary(feature: FeatureClient<typeof contract>, detail = false) {
  const input = detail ? { view: "definitions" as const, includeRecords: true } : { view: "catalog" as const, kind: "page" as const };
  // Keep detailed responses within the host transport budget.
  const limit = detail ? 10 : 50;
  const result = await feature.invoke("ontology", { ...input, limit });
  while (result.nextOffset !== null) {
    const page = await feature.invoke("ontology", { ...input, limit, offset: result.nextOffset });
    if (page.fingerprint !== result.fingerprint) throw Error("Ontology changed while loading; refresh to read the current vocabulary.");
    result.definitions!.push(...(page.definitions ?? [])); result.nextOffset = page.nextOffset;
  }
  return result as FeatureOutput<typeof contract, "ontology"> & { definitions: NonNullable<FeatureOutput<typeof contract, "ontology">["definitions"]> };
}
