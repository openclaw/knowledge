import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { icon } from "./ui-icons.js";

type Detail = FeatureOutput<typeof contract, "record">;
type FileEvidence = NonNullable<Detail["evidence"]>[number];
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };

export function evidenceView(feature: FeatureClient<typeof contract>, result: Detail, alive: () => boolean, redact: (s: string) => string, expansion = { count: 20 }, correction?: HTMLButtonElement) {
  const root = el("section"), id = result.record!.id, hash = result.record!.hash;
  root.className = "knowledge-evidence-list";
  root.setAttribute("aria-label", "Source evidence");
  const append = (e: FileEvidence) => {
    const article = el("article"), quote = el("figure"), metadata = el("figcaption"), actions = el("div");
    article.className = "knowledge-evidence-item"; quote.className = "knowledge-evidence";
    metadata.className = "knowledge-evidence-meta"; actions.className = "knowledge-evidence-actions";
    if (e.excerpt) quote.append(el("blockquote", `“${e.excerpt}”`));
    else quote.append(el("p", "No text preview available. Open the original file to inspect this source."));
    if (e.excerptTruncated) quote.append(el("small", "Excerpt · Original retained in full."));
    const attribution = e.attribution;
    if (attribution) metadata.append(el("span", `— ${attribution}`));
    // The filename is the disclosure: hashes and other file mechanics stay out
    // of the quote-first reading path without losing inspection access.
    const details = el("details"), sourceName = el("summary", e.filename ?? e.path.split("/").at(-1)!);
    details.className = "knowledge-source-reference";
    if (e.start_line !== undefined) sourceName.append(document.createTextNode(` · ${e.start_line === e.end_line ? `line ${e.start_line}` : `lines ${e.start_line}–${e.end_line ?? e.start_line}`}`));
    sourceName.title = "Source file details";
    const technical = el("div"); technical.className = "knowledge-source-technical";
    technical.append(el("code", `${e.path}\nSHA-256: ${e.sha256}`));
    if (e.mediaType || e.size !== undefined) technical.append(el("p", [e.mediaType, e.size !== undefined ? `${e.size.toLocaleString()} bytes` : ""].filter(Boolean).join(" · ")));
    if (result.record?.attribution && result.record.attribution !== attribution) technical.append(el("p", `Assertion attribution: ${result.record.attribution}`));
    details.append(sourceName, technical); metadata.append(details);
    const retained = el("span", e.verified ? "Original retained" : "Source not verified");
    retained.className = e.verified ? "knowledge-retained" : "knowledge-unverified";
    retained.prepend(icon(e.verified ? "badgeCheck" : "info", 12)); metadata.append(retained);
    quote.append(metadata);
    const download = el("button", "Original file"), status = el("p");
    download.type = "button"; download.prepend(icon("download", 16)); download.disabled = !e.verified;
    status.className = "knowledge-download-status"; status.setAttribute("role", "status");
    download.onclick = async () => {
      download.disabled = true;
      let writer: { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | undefined;
      try {
        // Stream to disk when the browser supports it; otherwise use its Blob
        // download facility. Never render source HTML/SVG in the app's origin.
        const picker = (window as unknown as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<NonNullable<typeof writer>> }> }).showSaveFilePicker;
        if (picker) writer = await (await picker.call(window, { suggestedName: e.filename ?? e.path.split("/").at(-1)! })).createWritable();
        const chunks: ArrayBuffer[] = []; let offset = 0;
        while (true) {
          if (!alive()) throw Error("Record view changed; download canceled.");
          const page = await feature.invoke("attachment", { id, path: e.path, sha256: e.sha256, offset });
          const binary = atob(page.data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          if (page.offset !== offset || page.sha256 !== e.sha256) throw Error("Source changed during download");
          if (writer) await writer.write(bytes); else chunks.push(bytes.buffer);
          status.textContent = `${(offset + bytes.length).toLocaleString()} / ${page.size.toLocaleString()} bytes`;
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        if (writer) await writer.close();
        else {
          const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
          const link = el("a"); link.href = url; link.download = e.filename ?? e.path.split("/").at(-1)!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        status.textContent = "Original file downloaded.";
      } catch (error) { await writer?.abort().catch(() => {}); status.textContent = redact(String(error)); }
      finally { download.disabled = !e.verified; }
    };
    actions.append(download);
    if (correction && !correction.parentElement) actions.append(correction);
    article.append(quote, actions, status); root.append(article);
  };
  result.evidence?.forEach(append);
  let offset = result.nextEvidenceOffset;
  if (offset != null) {
    const more = el("button", "More source files"); more.type = "button"; root.append(more);
    const loadMore = async () => {
      more.disabled = true;
      expansion.count = Math.max(expansion.count, offset! + 20);
      try {
        const page = await feature.invoke("record", { id, view: "summary", includeEvidence: true, evidenceOffset: offset!, evidenceLimit: 20 });
        if (!alive()) return;
        if (page.record?.hash !== hash) throw Error("Record changed; reopen it to refresh sources.");
        page.evidence?.forEach(append); offset = page.nextEvidenceOffset;
        if (offset == null) more.remove();
        else { root.append(more); if (offset < expansion.count) await loadMore(); }
      } catch (error) { root.append(el("p", redact(String(error)))); }
      finally { more.disabled = false; }
    };
    more.onclick = () => { void loadMore(); };
    if (offset < expansion.count) void loadMore();
  }
  return root;
}
