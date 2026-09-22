import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

const uiRevision = "foundation-2";

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    const removeNavigation = host.ui.registerNavigation({
      id: "knowledge", label: "Knowledge", page: { id: "overview" }, icon: "bookOpen",
    });
    const removePage = host.ui.registerPage({
      id: "overview", label: "Knowledge",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const section = document.createElement("section");
        section.className = "knowledge-page";
        section.innerHTML = `
          <header><p class="knowledge-eyebrow">KNOWLEDGE</p><h1>Your knowledge, with evidence.</h1>
          <p>Capture, inspect, and connect what matters.</p></header>
          <div class="knowledge-status" role="status" aria-live="polite"></div>
          <div class="knowledge-cards">
            <article><h2>Records</h2><p>People, projects, sourced claims, and their relationships.</p><span>Explorer coming next</span></article>
            <article><h2>Schemas</h2><p>Inspect record types, fields, and filing conventions.</p><span>Not yet implemented</span></article>
            <article><h2>Activity &amp; issues</h2><p>See actual changes, validation issues, and recovery state.</p><span>Not yet implemented</span></article>
          </div>
          <p>No vault is connected. This foundation does not read or write knowledge records.</p>
          <button type="button">Refresh status</button>
          <details><summary>Development status</summary><dl></dl></details>`;
        const status = section.querySelector<HTMLElement>(".knowledge-status")!;
        const button = section.querySelector<HTMLButtonElement>("button")!;
        const details = section.querySelector("dl")!;
        let stopWatch: (() => void) | undefined;
        const refresh = () => {
          stopWatch?.();
          if (context.signal.aborted) return;
          button.disabled = !context.host.connection.connected;
          status.textContent = context.host.connection.connected ? "Checking Knowledge service…" : "Disconnected — waiting for OpenClaw.";
          details.replaceChildren();
          stopWatch = feature.watch("status", {}, {
            events: [],
            onChange(report) {
              if (context.signal.aborted) return;
              status.textContent = "Connected · Knowledge service is ready · Writes disabled";
              details.replaceChildren();
              for (const [name, value] of Object.entries({
                "UI revision": uiRevision,
                "Backend revision": report.backendRevision,
                "Backend instance": report.instanceId,
                "Started": report.startedAt,
                "Last checked": report.checkedAt,
                "Vault": report.vault,
              })) {
                const term = document.createElement("dt"); term.textContent = name;
                const definition = document.createElement("dd"); definition.textContent = value;
                details.append(term, definition);
              }
            },
            onError(error) {
              if (!context.signal.aborted) {
                status.textContent = "Knowledge unavailable: " + context.host.redact(error.message);
                details.replaceChildren();
              }
            },
          });
        };
        button.onclick = refresh;
        let connected = context.host.connection.connected;
        const unsubscribe = context.host.subscribe(() => {
          const next = context.host.connection.connected;
          if (next === connected) return;
          connected = next;
          refresh();
        });
        container.append(section);
        refresh();
        return { dispose() { stopWatch?.(); unsubscribe(); button.onclick = null; section.remove(); } };
      },
    });
    return () => { removePage(); removeNavigation(); };
  },
});
