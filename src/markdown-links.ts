import { Marked } from "marked";

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const wikiHref = (target: string) => `#wiki=${encodeURIComponent(target)}`;
/** One parser for navigation and rendering: code, escapes, HTML and images are not links. */
export const markdown = new Marked({ gfm: true, async: false, renderer: {
  html: ({ text }) => escapeHtml(text), image: ({ text }) => escapeHtml(text),
}, extensions: [{
  name: "wikilink", level: "inline", start: src => src.indexOf("[["),
  tokenizer(src) {
    const match = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
    if (match) return { type: "wikilink", raw: match[0], target: match[1].trim(), label: (match[2] ?? match[1]).trim() };
  },
  renderer: token => `<a href="${escapeHtml(wikiHref(token.target))}">${escapeHtml(token.label)}</a>`,
}] });
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
/** Input records must already be authorized and lifecycle-filtered. Never guess ambiguous names. */
export function resolveLinks(record: LinkRecord, records: LinkRecord[]): LinkResolution[] {
  const results: LinkResolution[] = [];
  for (const href of extractLinks(record.body)) {
    const wiki = href.startsWith("#wiki=");
    if (!wiki && (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(href) || !/\.md(?:#.*)?$/i.test(href))) continue;
    let target: string;
    try { target = decodeURIComponent(wiki ? href.slice(6) : href).split("#")[0]; } catch { target = ""; }
    if (!target || /[\\\x00-\x1f]/.test(target) || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) { results.push({ href, status: "missing" }); continue; }
    const bare = target.replace(/\.md$/i, ""), parent = record.path.split("/").slice(0, -1).join("/");
    const paths = wiki && !target.startsWith(".") ? [cleanPath(target), cleanPath(`${parent}/${target}`)] : [cleanPath(`${parent}/${target}`)];
    let matches = records.filter(r => paths.some(p => p && normalize(r.path.replace(/\.md$/i, "")) === normalize(p.replace(/\.md$/i, ""))));
    // Old UUID paths survive renames. IDs remain authoritative, not inferred from filenames.
    if (!matches.length) matches = records.filter(r => r.id === bare.split("/").at(-1));
    if (!matches.length && wiki && !target.includes("/")) matches = records.filter(r => [r.title, r.path.split("/").at(-1)!.replace(/\.md$/i, ""), ...(r.metadata.aliases ?? [])].some(name => normalize(name) === normalize(bare)));
    results.push({ href, status: matches.length === 1 ? "resolved" : matches.length ? "ambiguous" : "missing", ...(matches.length === 1 ? { id: matches[0].id } : {}) });
  }
  return results;
}
