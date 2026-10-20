import { Marked } from "marked";

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const wikiHref = (target: string) => `#wiki=${encodeURIComponent(target)}`;
/** One parser for navigation and rendering: code, escapes, HTML and images are not links. */
export const markdown = new Marked({ gfm: true, async: false, renderer: {
  // Comment tokens are metadata, while other raw HTML remains inert visible text.
  html: ({ text }) => /^\s*<!--/.test(text) ? "" : escapeHtml(text), image: ({ text }) => escapeHtml(text),
}, extensions: [{
  name: "wikilink", level: "inline", start: src => src.indexOf("[["),
  tokenizer(src) {
    const match = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (match) return { type: "wikilink", raw: match[0], target: match[1].trim(), label: (match[2] ?? match[1]).trim() };
  },
  renderer: token => `<a href="${escapeHtml(wikiHref(token.target))}">${escapeHtml(token.label)}</a>`,
}] });
// Link extraction parses Markdown; reuse a record's parse while its body is unchanged.
const extracted = new WeakMap<object, { body: string; hrefs: string[] }>();
export function extractLinks(body: string): string[] {
  // Generated backlinks must not recursively create their own backlinks.
  const tokens = markdown.lexer(body).filter((() => {
    let generated = false;
    return (token: { type: string; raw: string }) => {
      if (token.type === "html" && /^\s*<!--\s*(?:knowledge:)?backlinks:start\s*-->\s*$/i.test(token.raw)) { generated = true; return false; }
      if (token.type === "html" && /^\s*<!--\s*(?:knowledge:)?backlinks:end\s*-->\s*$/i.test(token.raw)) { generated = false; return false; }
      return !generated;
    };
  })());
  const links = new Set<string>();
  markdown.walkTokens(tokens, token => {
    if (token.type === "wikilink") links.add(wikiHref(token.target));
    if (token.type === "link") links.add(token.href);
  });
  return [...links];
}
export type LinkResolution = { href: string; status: "resolved" | "missing" | "ambiguous"; id?: string };
type LinkRecord = { id: string; title: string; path: string; body: string; metadata: { aliases?: string[] } };
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
function cleanPath(value: string): string | undefined {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
type LinkIndex = { byPath: Map<string, Set<LinkRecord>>; byId: Map<string, Set<LinkRecord>>; byName: Map<string, Set<LinkRecord>> };
// Normalized lookup tables for one candidate list, built once instead of
// normalizing every candidate for every link.
const indexes = new WeakMap<LinkRecord[], LinkIndex>();
function linkIndex(records: LinkRecord[]): LinkIndex {
  let index = indexes.get(records);
  if (index) return index;
  index = { byPath: new Map(), byId: new Map(), byName: new Map() };
  const add = (map: Map<string, Set<LinkRecord>>, key: string, r: LinkRecord) => { let set = map.get(key); if (!set) map.set(key, set = new Set()); set.add(r); };
  for (const r of records) {
    add(index.byPath, normalize(r.path.replace(/\.md$/i, "")), r);
    add(index.byId, r.id, r);
    for (const name of [r.title, r.path.split("/").at(-1)!.replace(/\.md$/i, ""), ...(r.metadata.aliases ?? [])]) add(index.byName, normalize(name), r);
  }
  indexes.set(records, index); return index;
}
/** Input records must already be authorized and lifecycle-filtered. Never guess ambiguous names.
 * `canonical` maps a merged page among `records` to the page it was merged into; a name matching
 * both counts once, and a link whose final page is not among `records` is missing. */
export function resolveLinks(record: LinkRecord, records: LinkRecord[], canonical?: (id: string) => string): LinkResolution[] {
  const results: LinkResolution[] = [], index = linkIndex(records);
  let parsed = extracted.get(record);
  if (parsed?.body !== record.body) { parsed = { body: record.body, hrefs: extractLinks(record.body) }; extracted.set(record, parsed); }
  const hrefs = parsed.hrefs;
  for (const href of hrefs) {
    const wiki = href.startsWith("#wiki=");
    if (!wiki && (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href) || !/\.md(?:#.*)?$/i.test(href))) continue;
    let target: string;
    try { target = decodeURIComponent(wiki ? href.slice(6) : href).split("#")[0]; } catch { target = ""; }
    if (!target || /[\\\x00-\x1f]/.test(target) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) { results.push({ href, status: "missing" }); continue; }
    const bare = target.replace(/\.md$/i, ""), parent = record.path.split("/").slice(0, -1).join("/");
    const paths = wiki && !target.startsWith(".") ? [cleanPath(target), cleanPath(`${parent}/${target}`)] : [cleanPath(`${parent}/${target}`)];
    let matches = new Set<LinkRecord>();
    for (const p of paths) if (p) for (const r of index.byPath.get(normalize(p.replace(/\.md$/i, ""))) ?? []) matches.add(r);
    // Old UUID paths survive renames. IDs remain authoritative, not inferred from filenames.
    if (!matches.size) matches = new Set(index.byId.get(bare.split("/").at(-1)!) ?? []);
    if (!matches.size && wiki && !target.includes("/")) matches = new Set(index.byName.get(normalize(bare)) ?? []);
    const ids = new Set([...matches].map(r => canonical ? canonical(r.id) : r.id).filter(id => !canonical || (index.byId.has(id) && canonical(id) === id)));
    const [only] = ids;
    results.push({ href, status: ids.size === 1 ? "resolved" : ids.size ? "ambiguous" : "missing", ...(ids.size === 1 ? { id: only } : {}) });
  }
  return results;
}
