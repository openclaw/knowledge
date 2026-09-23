import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { loadVocabulary } from "./inspection-client.js";
import { contract } from "./contract.js";
import type { SavePage } from "./mutation-contract.js";

type RecordDetail = NonNullable<FeatureOutput<typeof contract, "record">["record"]>;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
/** The dialog lives outside refreshed content; errors/reconnects don't erase a draft. */
export async function pageEditor(parent: HTMLElement, feature: FeatureClient<typeof contract>, record: RecordDetail | undefined, saved: (id: string) => void, redact: (message: string) => string) {
  const dialog = element("dialog"); dialog.className = "knowledge-editor";
  const form = element("form"), feedback = element("p"); feedback.setAttribute("role", "status");
  const title = element("input"); title.value = record?.title ?? ""; title.required = true; title.maxLength = 200;
  const type = element("select"); type.required = true;
  const body = element("textarea"); body.value = record?.body ?? ""; body.rows = 16; body.maxLength = 48000;
  const fields = element("textarea"); fields.rows = 4; fields.value = record ? JSON.stringify(record.metadata?.fields ?? {}, null, 2) : "{}";
  const source = element("textarea"); source.rows = 4; source.maxLength = 48000;
  const attribution = element("input"); attribution.maxLength = 1000;
  const field = (name: string, control: HTMLElement) => { const label = element("label", name); label.append(control); return label; };
  const close = element("button", "Close draft"); close.type = "button"; close.onclick = () => dialog.close();
  const save = element("button", "Save page"); save.type = "submit"; save.disabled = true;
  form.append(element("h2", record ? "Edit page" : "New page"), field("Title", title), field("Page type", type), field("Markdown", body));
  const advanced = element("details"); advanced.append(element("summary", "Structured fields & source evidence"), field("Fields (JSON object)", fields), field("Retain source text (optional)", source), field("Source attribution", attribution));
  form.append(advanced, feedback, save, close); dialog.append(form); parent.append(dialog);
  // Closing keeps the draft available for this mount. Explicit discard removes it.
  const reopen = element("button", "Reopen draft"); reopen.type = "button"; reopen.hidden = true;
  reopen.onclick = () => { reopen.hidden = true; dialog.showModal(); };
  parent.append(reopen);
  dialog.onclose = () => { reopen.hidden = false; };
  dialog.showModal();
  let submitted: SavePage | undefined, saving = false;
  try {
    const ontology = await loadVocabulary(feature);
    for (const d of ontology.definitions.filter(d => d.kind === "page")) { const option = element("option", d.label); option.value = d.name; type.append(option); }
    type.value = record?.type ?? (ontology.definitions.some(d => d.name === "note") ? "note" : type.value); type.disabled = Boolean(record);
    save.disabled = !ontology.available;
  } catch (e) { feedback.textContent = redact(String(e)); }
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    try {
      if (!submitted) {
        const parsed: unknown = JSON.parse(fields.value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw Error("Fields must be a JSON object.");
        if (source.value && !attribution.value.trim()) throw Error("Add attribution for the retained source text.");
        submitted = { requestId: crypto.randomUUID(), title: title.value, body: body.value, type: type.value, fields: parsed as Record<string, unknown>,
          ...(record ? { id: record.id, expectedRevision: record.revision, expectedHash: record.hash } : {}),
          ...(source.value ? { source: { text: source.value, attribution: attribution.value } } : {}) };
      }
      saving = true; save.disabled = true; feedback.textContent = "Saving…";
      for (const control of [title, type, body, fields, source, attribution]) control.disabled = true;
      const receipt = await feature.invoke("save_page", submitted);
      if (receipt.state === "published") {
        dialog.onclose = null; dialog.close(); dialog.remove(); reopen.remove(); saved(receipt.id); return;
      }
      feedback.textContent = receipt.message; save.textContent = "Retry publication";
    } catch (e) {
      feedback.textContent = redact(e instanceof Error ? e.message : String(e)) + (submitted ? " Your draft is retained. Retry uses the same request; copy the text before starting a revised draft." : "");
      if (submitted) {
        save.textContent = "Retry same save";
        try {
          const status = await feature.invoke("mutation", { requestId: submitted.requestId });
          if (!status.receipt) {
            submitted = undefined;
            for (const control of [title, body, fields, source, attribution]) control.disabled = false;
            type.disabled = Boolean(record); save.textContent = "Save page";
            feedback.textContent += " Nothing was accepted for publication; you can revise this draft.";
          }
        } catch { /* Outcome is unknown. Preserve the exact request for a safe retry. */ }
      }
    } finally { saving = false; save.disabled = false; }
  };
}
