import { Marked } from "marked";
import DOMPurify from "dompurify";

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const markdown = new Marked({ gfm: true, async: false, renderer: {
  // Imported HTML is source text, never privileged UI. Images must not trigger
  // remote requests simply because someone opens a saved page.
  html: ({ text }) => escape(text),
  image: ({ text }) => escape(text),
} });

/** Render portable page content without granting it native-plugin privileges. */
export function markdownView(source: string, openRecord: (id: string) => void): HTMLElement {
  const root = document.createElement("div"); root.className = "knowledge-markdown";
  root.append(DOMPurify.sanitize(markdown.parse(source) as string, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "blockquote", "pre", "code", "a", "table", "thead", "tbody", "tr", "th", "td", "input"],
    ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  }));
  for (const input of root.querySelectorAll("input")) { input.type = "checkbox"; input.disabled = true; }
  for (const link of root.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    link.removeAttribute("href");
    // Only explicit web/mail links leave the app; protocol-relative URLs,
    // file/data/javascript links and unknown relative paths stay inert.
    if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href)) {
      link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
      continue;
    }
    // Published Knowledge pages use stable UUID filenames. Route these through
    // the scoped record API, never to a raw file or an arbitrary host route.
    const match = /^(?:(?:\.\.?|[a-zA-Z0-9_-]+)\/)*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.md(?:#[^\s]*)?$/.exec(href);
    if (match) {
      link.href = "#";
      link.onclick = event => { event.preventDefault(); openRecord(match[1]); };
    }
  }
  for (const table of root.querySelectorAll("table")) {
    const scroll = document.createElement("div"); scroll.className = "knowledge-markdown-table";
    table.replaceWith(scroll); scroll.append(table);
  }
  return root;
}
