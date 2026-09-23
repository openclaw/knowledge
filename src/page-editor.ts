import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { loadVocabulary } from "./inspection-client.js";
import { contract } from "./contract.js";
import { DraftStore, type EditorDraft } from "./drafts.js";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import type { Evidence } from "./model.js";
import type { SavePage } from "./mutation-contract.js";

type RecordDetail = NonNullable<FeatureOutput<typeof contract, "record">["record"]>;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
/** The dialog lives outside refreshed content; errors/reconnects don't erase a draft. */
export async function pageEditor(parent: HTMLElement, feature: FeatureClient<typeof contract>, record: RecordDetail | undefined, saved: (id: string) => void, redact: (message: string) => string, recovery?: { store: DraftStore; draft?: EditorDraft; signal: AbortSignal; dismissed?: () => void }) {
  const restored = recovery?.draft;
  const base = restored?.base ?? (record ? { id: record.id, revision: record.revision, hash: record.hash } : undefined);
  const key = restored?.key ?? crypto.randomUUID();
  const dialog = element("dialog"); dialog.className = "knowledge-editor";
  const recoveryNotice = element("p"); recoveryNotice.setAttribute("role", "alert");
  const form = element("form"), feedback = element("p"); feedback.setAttribute("role", "status");
  const title = element("input"); title.value = restored?.title ?? record?.title ?? ""; title.required = true; title.maxLength = 200;
  const type = element("select"); type.required = true;
  const body = element("textarea"); body.value = restored?.body ?? record?.body ?? ""; body.rows = 16; body.maxLength = 48000;
  const fields = element("textarea"); fields.rows = 4; fields.value = restored?.fields ?? (record ? JSON.stringify(record.metadata?.fields ?? {}, null, 2) : "{}");
  const source = element("textarea"); source.rows = 4; source.value = restored?.source ?? "";
  const files = element("input"); files.type = "file"; files.multiple = true;
  const attached = element("ul"), attachments: Evidence[] = [...(restored?.attachments ?? [])];
  const renderAttachments = () => { attached.replaceChildren(...attachments.map(e => element("li", e.filename ?? e.path))); };
  renderAttachments();
  const pendingUploads = new Map<File, { requestId: string; offset: number; attribution: string }>();
  const attribution = element("input"); attribution.maxLength = 1000; attribution.value = restored?.attribution ?? "";
  const field = (name: string, control: HTMLElement) => { const label = element("label", name); label.append(control); return label; };
  const close = element("button", "Close draft"); close.type = "button"; close.onclick = () => dialog.close();
  const save = element("button", "Save page"); save.type = "submit"; save.disabled = true;
  form.append(element("h2", base ? "Edit page" : "New page"), field("Title", title), field("Page type", type), field("Markdown", body));
  const advanced = element("details"); advanced.append(element("summary", "Structured fields & source evidence"), field("Fields (JSON object)", fields), field("Attach source files (optional)", files), field("Source attribution (optional; defaults to filename)", attribution), attached, ...(source.value ? [field("Recovered source text", source)] : []));
  form.append(advanced, recoveryNotice, feedback, save, close); dialog.append(form); parent.append(dialog);
  // Closing keeps the draft available for this mount. Explicit discard removes it.
  const reopen = element("button", "Reopen draft"); reopen.type = "button"; reopen.hidden = true;
  reopen.onclick = () => { reopen.hidden = true; dialog.showModal(); };
  parent.append(reopen);
  const discard = element("button", "Discard draft"); discard.type = "button";
  discard.onclick = () => {
    if (saving || submitted) { feedback.textContent = "Resolve the existing save before discarding this draft."; return; }
    if (!window.confirm("Discard this unsaved draft?")) return;
    recovery?.store.remove(key); dialog.onclose = null; dialog.close(); dialog.remove(); reopen.remove(); recovery?.dismissed?.();
  };
  form.append(discard);
  dialog.onclose = () => { reopen.hidden = false; };
  dialog.showModal();
  let submitted: SavePage | undefined = restored?.submitted, saving = false;
  const persist = () => {
    if (!recovery) return true;
    try { recovery.store.write({ version: 1, key, title: title.value, body: body.value, type: type.value || restored?.type || record?.type || "", fields: fields.value, source: source.value, attribution: attribution.value, attachments, ...(base ? { base } : {}), ...(submitted ? { submitted } : {}) }); return true; }
    catch { recoveryNotice.textContent = "Browser draft recovery unavailable. Keep this page open and copy your text before leaving."; return false; }
  };
  form.addEventListener("input", () => persist());
  form.addEventListener("change", () => persist());
  persist();
  if (restored) feedback.textContent = submitted ? "Recovered draft with an unresolved save. Retry uses the original request." : "Recovered unsaved draft from this tab. Nothing has been published.";
  try {
    const ontology = await loadVocabulary(feature);
    for (const d of ontology.definitions.filter(d => d.kind === "page")) { const option = element("option", d.label); option.value = d.name; type.append(option); }
    type.value = restored?.type || record?.type || (ontology.definitions.some(d => d.name === "note") ? "note" : type.value); type.disabled = Boolean(base);
    if (submitted) for (const control of [title, type, body, fields, source, attribution, files]) control.disabled = true;
    save.textContent = submitted ? "Retry same save" : "Save page";
    save.disabled = !ontology.available;
    persist();
  } catch (e) { feedback.textContent = redact(String(e)); }
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    saving = true; save.disabled = true;
    for (const control of [title, type, body, fields, source, attribution, files]) control.disabled = true;
    try {
      if (!submitted) {
        const parsed: unknown = JSON.parse(fields.value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw Error("Fields must be a JSON object.");
        if (source.value && !attribution.value.trim()) throw Error("Add attribution for the retained source text.");
        for (const file of Array.from(files.files ?? [])) {
          let upload = pendingUploads.get(file);
          if (!upload) { upload = { requestId: crypto.randomUUID(), offset: 0, attribution: attribution.value.trim() || file.name }; pendingUploads.set(file, upload); }
          if (attachments.some(e => e.path.startsWith(`artifacts/${upload!.requestId}/`))) continue;
          while (true) {
            feedback.textContent = `Attaching ${file.name}: ${upload.offset.toLocaleString()} / ${file.size.toLocaleString()} bytes…`;
            const bytes = new Uint8Array(await file.slice(upload.offset, upload.offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer());
            let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            const receipt = await feature.invoke("attach", { requestId: upload.requestId, ...(recovery ? { expectedVaultId: recovery.store.vaultId } : {}),
              filename: file.name, mediaType: file.type || "application/octet-stream", attribution: upload.attribution, offset: upload.offset,
              data: btoa(binary), final: upload.offset + bytes.length === file.size });
            upload.offset = receipt.receivedBytes;
            if (receipt.state === "complete" && receipt.evidence) { attachments.push(receipt.evidence); renderAttachments(); persist(); break; }
          }
        }
        submitted = { requestId: crypto.randomUUID(), ...(recovery ? { expectedVaultId: recovery.store.vaultId } : {}), title: title.value, body: body.value, type: type.value, fields: parsed as Record<string, unknown>,
          ...(base ? { id: base.id, expectedRevision: base.revision, expectedHash: base.hash } : {}),
          ...(attachments.length ? { attachments: [...attachments] } : {}),
          ...(source.value ? { source: { text: source.value, attribution: attribution.value } } : {}) };
      }
      persist();
      saving = true; save.disabled = true; feedback.textContent = "Saving…";
      for (const control of [title, type, body, fields, source, attribution, files]) control.disabled = true;
      const receipt = await feature.invoke("save_page", submitted);
      if (receipt.state === "published") {
        recovery?.store.remove(key);
        dialog.onclose = null; dialog.close(); dialog.remove(); reopen.remove(); if (!recovery?.signal.aborted) saved(receipt.id); return;
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
            for (const control of [title, body, fields, source, attribution, files]) control.disabled = false;
            type.disabled = Boolean(base); save.textContent = "Save page";
            feedback.textContent += " Nothing was accepted for publication; you can revise this draft.";
          }
        } catch { /* Outcome is unknown. Preserve the exact request for a safe retry. */ }
      }
    } finally { saving = false; save.disabled = false;
      if (!submitted) { for (const control of [title, body, fields, source, attribution, files]) control.disabled = false; type.disabled = Boolean(base); } if (dialog.isConnected) persist(); }
  };
  return { reopen() { if (!dialog.open) { reopen.hidden = true; dialog.showModal(); } } };
}
