import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { StoreChange, StoreEntry } from "./stores-contract.js";
import { icon, type IconName } from "./ui-icons.js";

type Snapshot = FeatureOutput<typeof contract, "stores_snapshot">;
type ChangeResult = FeatureOutput<typeof contract, "stores_change">;
/** Display name for an agent ID (host roster first). */
export type Names = (agentId: string) => string;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text: string, run: () => void, className = "knowledge-button") => { const n = el("button", text, className); n.type = "button"; n.onclick = run; return n; };
const andList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Label for a store: named stores by name, isolated stores by owner. */
export const storeLabel = (entry: StoreEntry, names: Names) => entry.kind === "named" ? entry.label : `${names(entry.owner!)}’s knowledge`;
/** The store an agent currently uses, if its assignment is valid. */
export const storeOf = (snapshot: Snapshot, agentId: string) => {
  const binding = snapshot.agents.find(a => a.id === agentId)?.binding;
  return binding ? snapshot.stores.find(s => s.binding === binding) : undefined;
};
/** "Shared with Research", "No other agents" or "Not shared". */
export function accessText(entry: StoreEntry, agentId: string, names: Names) {
  if (entry.kind === "isolated") return "Not shared";
  const others = entry.members.filter(a => a !== agentId);
  return others.length ? `Shared with ${andList(others.map(names))}` : "No other agents";
}
/** Record count or lifecycle; unknown counts stay unknown, never zero. */
function recordsText(entry: StoreEntry) {
  switch (entry.state) {
    case "unprovisioned": return "Created on first use";
    case "initializing": return "Being created";
    case "unavailable": return "Couldn’t be opened";
    case "recovery-required": return "Needs recovery";
    default: return entry.records === null ? "" : entry.records === 0 ? "Empty" : `${entry.records.toLocaleString()} record${entry.records === 1 ? "" : "s"}`;
  }
}
const storeIcon = (entry: StoreEntry | undefined): IconName => entry?.kind === "named" ? "users" : "circleUser";

/** Agent viewing selector and the viewed agent's store context (spec §8.1).
 * Selecting an agent only changes what is viewed. */
export function storeBar(snapshot: Snapshot, viewing: string, names: Names, select: (agent: string) => void, openSettings: () => void) {
  const bar = el("div", undefined, "knowledge-store-bar");
  const pick = el("label", undefined, "knowledge-agent-select"); pick.append(el("span", "Agent"));
  const wrap = el("span", undefined, "knowledge-select"), menu = el("select");
  for (const agent of snapshot.agents) { const option = el("option", names(agent.id)); option.value = agent.id; option.selected = agent.id === viewing; menu.append(option); }
  menu.onchange = () => select(menu.value);
  wrap.append(menu, icon("chevronDown", 13)); pick.append(wrap);
  const entry = storeOf(snapshot, viewing);
  const context = button("", openSettings, "knowledge-store-context"); context.title = "Stores & sharing";
  if (entry) context.append(icon(storeIcon(entry), 14), el("strong", storeLabel(entry, names)), el("span", `· ${accessText(entry, viewing, names)}`));
  else context.append(icon("alertTriangle", 14), el("span", "Store assignment needs attention"));
  bar.append(pick, context);
  return bar;
}

/** Reading-view placeholder for a store that is not ready to read. */
export function storeNotice(entry: StoreEntry | undefined, state: string, message: string | undefined, agentName: string, names: Names, openSettings: () => void, retry: () => void) {
  const panel = el("div", undefined, "knowledge-empty knowledge-store-notice");
  const label = entry ? storeLabel(entry, names) : `${agentName}’s store`;
  if (state === "unprovisioned") panel.append(el("h2", `${label} doesn’t exist yet`), el("p", `It’s created the first time ${agentName} uses knowledge. Viewing it here doesn’t create it.`));
  else if (state === "initializing") panel.append(el("h2", `${label} is being created`), el("p", "This takes a moment. It is not an empty store yet."));
  else { panel.append(el("h2", "This store couldn’t be opened"), el("p", `${message ?? "Its files or database are missing."} The assignment is kept; nothing is replaced automatically.`)); panel.append(button("Retry", retry, "knowledge-quiet")); }
  panel.append(button("Stores & sharing", openSettings, "knowledge-quiet"));
  return panel;
}

export type SettingsSection = "stores" | "vocab" | "status";
const SECTIONS: [SettingsSection, string, IconName][] = [["stores", "Stores & sharing", "users"], ["vocab", "Vocabulary", "book"], ["status", "Vault status", "activity"]];
/** Settings shell: section navigation plus a content slot the caller fills. */
export function settingsShell(section: SettingsSection, go: (section: SettingsSection) => void, back: () => void, heading: [string, string], issues = 0) {
  const root = el("div", undefined, "knowledge-settings");
  const nav = el("nav", undefined, "knowledge-settings-nav"); nav.setAttribute("aria-label", "Settings");
  nav.append(el("h2", "Settings"));
  for (const [id, text, glyph] of SECTIONS) {
    const item = button("", () => go(id), "knowledge-settings-link"); item.append(icon(glyph, 15), el("span", text));
    if (id === "status" && issues) item.append(el("span", String(issues), "knowledge-settings-count"));
    if (id === section) item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  const main = el("div", undefined, "knowledge-settings-main"), header = el("header");
  header.append(el("h2", heading[0]), el("p", heading[1], "knowledge-muted"));
  const slot = el("div", undefined, "knowledge-settings-slot");
  main.append(header, slot);
  const crumb = button("", back, "knowledge-quiet knowledge-crumb"); crumb.append(icon("arrowLeft", 14), el("span", "Knowledge"));
  root.append(crumb, nav, main);
  return { root, slot };
}

/** Stores & sharing: assignments table and store inventory (spec §8.2). */
export function storesSection(snapshot: Snapshot, viewing: string, names: Names, change: (agent: string, mode: StoreChange["kind"]) => void) {
  const root = el("div", undefined, "knowledge-stores");
  if (!snapshot.canChange && snapshot.changeUnavailable) root.append(el("p", snapshot.changeUnavailable, "knowledge-notice"));
  for (const issue of snapshot.issues) root.append(el("p", issue, "knowledge-notice"));
  const table = el("div", undefined, "knowledge-surface knowledge-assignments"); table.setAttribute("role", "table"); table.setAttribute("aria-label", "Agent store assignments");
  const head = el("div", undefined, "knowledge-assignment knowledge-assignment-head"); head.setAttribute("role", "row");
  for (const text of ["Agent", "Knowledge store", "Access", ""]) { const cell = el("span", text); cell.setAttribute("role", "columnheader"); head.append(cell); }
  table.append(head);
  for (const agent of snapshot.agents) {
    const row = el("div", undefined, "knowledge-assignment"); row.setAttribute("role", "row");
    const who = el("span", undefined, "knowledge-assignment-agent"); who.append(el("strong", names(agent.id)));
    if (agent.id === viewing) who.append(el("span", "Viewing", "chip knowledge-chip"));
    const entry = storeOf(snapshot, agent.id), store = el("span", undefined, "knowledge-assignment-store");
    if (entry) { const line = el("span"); line.append(icon(storeIcon(entry), 14), el("span", storeLabel(entry, names))); store.append(line); const note = recordsText(entry); if (entry.state !== "ready" && note) store.append(el("small", note)); }
    else store.append(el("span", agent.issue ?? "Unavailable", "knowledge-error"));
    const access = el("span", entry ? accessText(entry, agent.id, names) : "", entry?.kind === "named" ? "" : "knowledge-muted");
    const cells = [who, store, access, changeMenu(snapshot, agent.id, names, mode => change(agent.id, mode))];
    for (const cell of cells) { cell.setAttribute("role", "cell"); row.append(cell); }
    table.append(row);
  }
  const inventory = el("section", undefined, "knowledge-store-inventory"); inventory.append(el("h3", "Stores", "knowledge-eyebrow"));
  const list = el("div", undefined, "knowledge-surface");
  for (const entry of [...snapshot.stores].sort((a, b) => Number(b.kind === "named") - Number(a.kind === "named"))) {
    const row = el("div", undefined, "knowledge-store-row"), badge = el("span", undefined, `knowledge-store-icon knowledge-store-${entry.kind}`); badge.append(icon(storeIcon(entry), 14));
    const copy = el("span", undefined, "knowledge-store-copy"), titleLine = el("span"); titleLine.append(el("strong", storeLabel(entry, names))); if (entry.kind === "named") titleLine.append(el("span", "Shared store", "chip knowledge-chip"));
    const used = entry.members.length ? `Used by ${andList(entry.members.map(names))}` : entry.kind === "isolated" ? `Not in use. Kept as it was when ${names(entry.owner!)} switched stores.` : "No agents assigned. Kept as is.";
    copy.append(titleLine, el("span", used, entry.members.length ? "" : "knowledge-muted"));
    row.append(badge, copy, el("span", recordsText(entry), "knowledge-muted"));
    list.append(row);
  }
  inventory.append(list, el("p", "Stores are never merged or deleted from here. Removing an agent stops its future access; it can’t remove what the agent already retrieved into its conversations.", "knowledge-muted"));
  root.append(table, inventory);
  return root;
}

// Change… menu. It renders in the top layer (popover), so the table never clips it.
function changeMenu(snapshot: Snapshot, agentId: string, names: Names, pick: (mode: StoreChange["kind"]) => void) {
  const wrap = el("span", undefined, "knowledge-change");
  const trigger = button("Change…", () => undefined, "knowledge-button knowledge-small");
  trigger.setAttribute("aria-label", `Change store for ${names(agentId)}`); trigger.setAttribute("aria-haspopup", "menu");
  const entry = storeOf(snapshot, agentId), agent = snapshot.agents.find(a => a.id === agentId)!;
  const options: [StoreChange["kind"], string, string, boolean][] = [];
  if (entry?.kind === "isolated") options.push(["share_existing", "Share this store…", entry.state === "ready" ? "Name it and add agents. Knowledge stays where it is." : entry.state === "unprovisioned" ? "Nothing to share until it’s created on first use." : "This store needs recovery first.", entry.state !== "ready"]);
  const targets = snapshot.stores.filter(s => s.kind === "named" && s.binding !== entry?.binding);
  if (targets.length) options.push(["use_named", "Use shared store…", "Switch to a named store. Nothing is moved or merged.", false]);
  if (entry?.kind === "named") { const own = snapshot.stores.find(s => s.binding === `agent:${agentId}`); options.push(["use_own", "Use own store", own ? `Resume ${names(agentId)}’s previous store.` : `Use a new, empty store for ${names(agentId)}.`, false]); }
  if (!snapshot.canChange || !agent.supported || !options.length) { trigger.disabled = true; trigger.title = snapshot.changeUnavailable ?? agent.issue ?? "No changes available"; wrap.append(trigger); return wrap; }
  const menu = el("div", undefined, "knowledge-menu knowledge-surface"); menu.setAttribute("role", "menu"); menu.popover = "auto";
  for (const [mode, text, note, disabled] of options) {
    const item = button("", () => { menu.hidePopover(); pick(mode); }, "knowledge-menu-item"); item.setAttribute("role", "menuitem"); item.disabled = disabled;
    item.append(el("span", text), el("small", note)); menu.append(item);
  }
  trigger.onclick = () => {
    menu.togglePopover();
    if (!menu.matches(":popover-open")) return;
    // Anchor to the trigger; the top layer ignores table overflow clipping.
    const box = trigger.getBoundingClientRect(), width = Math.min(300, window.innerWidth - 16);
    menu.style.width = `${width}px`; menu.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
    const below = box.bottom + 4, height = menu.offsetHeight;
    menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 4) : below}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  };
  menu.onkeydown = event => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
  };
  menu.addEventListener("toggle", event => { if ((event as ToggleEvent).newState === "closed" && menu.contains(document.activeElement)) trigger.focus(); });
  wrap.append(trigger, menu);
  return wrap;
}

/** One assignment dialog (share / use named / use own). `save` performs the
 * change; the dialog keeps inputs on rejection and reports truthful state. */
export function storeDialog(mode: StoreChange["kind"], agentId: string, snapshot: Snapshot, names: Names, save: (change: StoreChange) => Promise<ChangeResult>, done: (result: ChangeResult) => void) {
  const who = names(agentId), current = storeOf(snapshot, agentId);
  const dialog = el("dialog", undefined, "knowledge-store-dialog knowledge-surface"), previousFocus = document.activeElement as HTMLElement | null;
  const heading = el("h3"), body = el("div", undefined, "knowledge-store-dialog-body"), effect = el("div", undefined, "knowledge-effect"), feedback = el("p", "", "knowledge-dialog-feedback");
  feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite");
  const cancel = button("Cancel", () => close(), "knowledge-quiet"), submit = button("", () => void run(), "knowledge-button knowledge-primary");
  let saving = false;
  const close = () => { dialog.close(); dialog.remove(); previousFocus?.focus(); };
  // Escape and backdrop dismissal close the view; an accepted save is never "cancelled".
  dialog.oncancel = event => { event.preventDefault(); close(); };
  let collect: () => StoreChange | undefined = () => undefined;
  let submitLabel = () => "Save";
  const refresh = () => { submit.disabled = saving || !collect(); submit.textContent = saving ? "Saving…" : submitLabel(); renderEffect(); };
  let renderEffect = () => {};

  if (mode === "share_existing") {
    heading.textContent = `Share ${who}’s knowledge`;
    const nameField = el("label", undefined, "knowledge-field"), input = el("input"); input.maxLength = 80; input.placeholder = "e.g. Team"; input.autocomplete = "off";
    const hint = el("small", `${who}’s existing store gets this name. It isn’t copied or replaced.`);
    nameField.append(el("span", "Store name"), input, hint);
    const picks = el("fieldset", undefined, "knowledge-choices"); picks.append(el("legend", "Agents to add"));
    const chosen = new Set<string>();
    for (const agent of snapshot.agents.filter(a => a.id !== agentId)) {
      const entry = storeOf(snapshot, agent.id);
      const note = !agent.supported || !entry ? agent.issue ?? "Unavailable" : entry.kind === "named" ? `Uses ${storeLabel(entry, names)}. It will switch to the new store.` : entry.state === "unprovisioned" ? "No store yet" : `Uses ${storeLabel(entry, names)}`;
      picks.append(choice("checkbox", `share-${agent.id}`, names(agent.id), note, !agent.supported || !entry, checked => { if (checked) chosen.add(agent.id); else chosen.delete(agent.id); refresh(); }));
    }
    const taken = () => { const value = input.value.trim().toLowerCase(); return value && snapshot.stores.some(s => s.kind === "named" && s.label.toLowerCase() === value); };
    input.oninput = () => { hint.textContent = taken() ? `A store with this name already exists. To join it, use “Use shared store…” instead.` : `${who}’s existing store gets this name. It isn’t copied or replaced.`; hint.classList.toggle("knowledge-error", Boolean(taken())); refresh(); };
    collect = () => input.value.trim() && !taken() && chosen.size ? { kind: "share_existing", label: input.value.trim(), agents: [...chosen] } : undefined;
    renderEffect = () => {
      effect.replaceChildren(); if (!chosen.size) return;
      const name = input.value.trim() || "the new store", joiners = [...chosen];
      effect.append(el("p", `${andList(joiners.map(names))} will be able to read and update the knowledge already saved in ${name} from owner-direct conversations.`));
      for (const joiner of joiners) { const entry = storeOf(snapshot, joiner); if (entry && entry.state !== "unprovisioned") effect.append(el("p", `${names(joiner)} will switch from ${storeLabel(entry, names)}. ${storeLabel(entry, names)} remains unchanged.`)); }
      effect.append(el("p", "Group chats still see only their own conversation’s knowledge.", "knowledge-muted"));
    };
    submitLabel = () => "Share store";
    body.append(nameField, picks);
  } else if (mode === "use_named") {
    heading.textContent = `Use a shared store for ${who}`;
    const targets = snapshot.stores.filter(s => s.kind === "named" && s.binding !== current?.binding);
    let target = targets.find(s => s.state !== "unavailable" && s.state !== "recovery-required");
    const picks = el("fieldset", undefined, "knowledge-choices"); picks.append(el("legend", "Shared store"));
    for (const entry of targets) {
      const blocked = entry.state === "unavailable" || entry.state === "recovery-required";
      const note = blocked ? "Couldn’t be opened; needs recovery first." : `${entry.members.length ? `Used by ${andList(entry.members.map(names))}` : "No agents assigned"}${recordsText(entry) ? ` · ${recordsText(entry).toLowerCase()}` : ""}`;
      picks.append(choice("radio", `use-${entry.key}`, entry.label, note, blocked, () => { target = entry; refresh(); }, entry === target, "knowledge-store-target"));
    }
    collect = () => target?.key ? { kind: "use_named", store: target.key } : undefined;
    renderEffect = () => {
      effect.replaceChildren(); if (!target) return;
      effect.append(el("p", `${who} will use ${target.label}.${current ? ` Nothing from ${storeLabel(current, names)} will be moved or merged.` : ""}`));
      effect.append(el("p", `${who} can read and update the knowledge already saved in ${target.label}${target.members.length ? `, alongside ${andList(target.members.map(names))}` : ""}.`));
      if (current) effect.append(el("p", `${who} stops using ${storeLabel(current, names)} from now on. Anything it already retrieved into its conversations can’t be taken back.`, "knowledge-muted"));
      effect.append(el("p", "Group chats still see only their own conversation’s knowledge.", "knowledge-muted"));
    };
    submitLabel = () => target ? `Use ${target.label}` : "Use store";
    body.append(picks);
  } else {
    heading.textContent = `Use own store for ${who}`;
    const own = snapshot.stores.find(s => s.binding === `agent:${agentId}`), blocked = own?.state === "unavailable" || own?.state === "recovery-required";
    const summary = el("div", undefined, "knowledge-own-choice");
    if (blocked) summary.append(el("strong", `${who}’s previous store needs recovery`), el("span", "It couldn’t be opened, so it can’t be resumed or replaced from here.", "knowledge-muted"));
    else if (own && own.state !== "unprovisioned") summary.append(el("strong", `Resume ${who}’s previous store.`), el("span", `${storeLabel(own, names)}${recordsText(own) ? ` · ${recordsText(own).toLowerCase()}` : ""}, as it was left.`, "knowledge-muted"));
    else summary.append(el("strong", `Use a new, empty store for ${who}.`), el("span", "Created on first authorized use. Viewing it here does not create it.", "knowledge-muted"));
    collect = () => blocked ? undefined : { kind: "use_own" };
    renderEffect = () => {
      effect.replaceChildren(); if (!current) return;
      const staying = current.members.filter(a => a !== agentId);
      effect.append(el("p", `Nothing in ${storeLabel(current, names)} is copied or removed${staying.length ? `; ${andList(staying.map(names))} keep${staying.length === 1 ? "s" : ""} using it` : "; it is kept even with no agents assigned"}.`));
      effect.append(el("p", `${who} stops using ${storeLabel(current, names)} from now on. Anything it already retrieved into its conversations can’t be taken back.`, "knowledge-muted"));
    };
    submitLabel = () => "Use own store";
    body.append(summary);
  }

  // Save once; keep the dialog and inputs unless the change was applied.
  async function run() {
    const next = collect(); if (!next || saving) return;
    saving = true; refresh(); feedback.textContent = ""; feedback.className = "knowledge-dialog-feedback";
    try {
      const result = await save(next);
      if (result.outcome === "applied") { close(); done(result); return; }
      feedback.textContent = result.outcome === "pending" || result.outcome === "unknown" ? `Checking whether the change was saved… ${result.message}` : result.message;
      feedback.classList.add(result.outcome === "pending" || result.outcome === "unknown" ? "knowledge-muted" : "knowledge-error");
      if (result.outcome === "conflict" && result.snapshot) done(result);
    } catch (error) {
      feedback.textContent = `The assignment was not changed. ${error instanceof Error ? error.message : String(error)}`; feedback.classList.add("knowledge-error");
    } finally { saving = false; if (dialog.open) refresh(); }
  }
  const close_ = button("", () => close(), "knowledge-icon-button"); close_.setAttribute("aria-label", "Close"); close_.append(icon("x", 14));
  const top = el("div", undefined, "knowledge-store-dialog-head"); top.append(heading, close_);
  const footer = el("div", undefined, "knowledge-actions"); footer.append(cancel, submit);
  dialog.setAttribute("aria-labelledby", "knowledge-store-dialog-title"); heading.id = "knowledge-store-dialog-title";
  body.append(effect);
  dialog.append(top, body, feedback, footer);
  // Inside the page so its styles apply; the modal top layer handles stacking.
  (document.querySelector(".knowledge-page") ?? document.body).append(dialog);
  dialog.showModal();
  refresh();
  (dialog.querySelector<HTMLElement>("input:not(:disabled)") ?? submit).focus();
  return dialog;
}

function choice(type: "checkbox" | "radio", id: string, title: string, note: string, disabled: boolean, onChange: (checked: boolean) => void, checked = false, name?: string) {
  const row = el("label", undefined, "knowledge-choice"), input = el("input");
  input.type = type; input.id = id; input.disabled = disabled; input.checked = checked; if (name) input.name = name;
  input.onchange = () => onChange(input.checked);
  const copy = el("span"); copy.append(el("span", title), el("small", note));
  row.append(input, copy);
  return row;
}

/** Vault status facts for the viewed agent's store. */
export function vaultFacts(rows: [string, string | Node][]) {
  const grid = el("dl", undefined, "knowledge-surface knowledge-facts");
  for (const [key, value] of rows) { const item = el("div"); item.append(el("dt", key)); const dd = el("dd"); dd.append(value); item.append(dd); grid.append(item); }
  return grid;
}
