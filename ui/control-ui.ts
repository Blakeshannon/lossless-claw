import type { ExplorerSnapshot, ExplorerSummary, ExplorerDetail } from "../src/context-explorer.js";
import "./context-explorer.css";

// Structural subset of OpenClaw's public ControlUiPlugin v1 contract. Keeping
// this browser-only avoids importing host code or adding a framework runtime.
type Context = {
  props: { sessionKey?: string; agentId?: string }; signal: AbortSignal; presented: boolean;
  host: { connection: { connected: boolean }; request<T>(method: string, params: Record<string, unknown>): Promise<T> };
};
type Host = { ui: { registerPanel(panel: { id: string; label: string; mount: typeof mount }): () => void } };
const number = (value: number) => value.toLocaleString();
const tokens = (value: number) => value >= 10000 ? `${(value / 1000).toFixed(1)}k` : number(value);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function date(value: string | null): string {
  if (!value) return "Unknown date";
  const parsed = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function mount(container: HTMLElement, initial: Context) {
  let context = initial, disposed = false, generation = 0, loading = false;
  let nextOffset: number | null = null, lastSignature = "";
  const root = el("section", "", "lcm-explorer");
  const header = el("header", "", "lcm-explorer__header");
  const heading = el("div");
  heading.append(el("span", "LOSSLESS", "lcm-explorer__eyebrow"), el("h2", "Context explorer"));
  const refresh = el("button", "Refresh", "lcm-explorer__button"); refresh.type = "button";
  header.append(heading, refresh);
  const subtitle = el("p", "This session · active stored context", "lcm-explorer__muted");
  const stats = el("div", "", "lcm-explorer__stats");
  const status = el("p", "Loading context…", "lcm-explorer__status"); status.setAttribute("role", "status");
  const list = el("div", "", "lcm-explorer__list");
  const more = el("button", "Load more summaries", "lcm-explorer__button"); more.type = "button"; more.hidden = true;
  const tail = el("p", "", "lcm-explorer__tail");
  const note = el("p", "The summaries Lossless currently retains for assembly. Budgeting, focus, and runtime projection can change what reaches the model; this is not a recording of the last prompt.", "lcm-explorer__note");
  root.append(header, subtitle, stats, status, list, more, tail, note); container.append(root);

  function alive(epoch: number) { return !disposed && !context.signal.aborted && epoch === generation; }
  async function request<T>(payload: Record<string, unknown>): Promise<T> {
    const active = context;
    const response = await active.host.request<{ ok: boolean; result?: T; error?: string }>("plugins.sessionAction", {
      pluginId: "lossless-claw", actionId: "context-explorer", payload,
      sessionKey: active.props.sessionKey, agentId: active.props.agentId,
    });
    if (!response.ok || !response.result) throw new Error(response.error || "Context unavailable");
    return response.result;
  }

  function summaryCard(summary: ExplorerSummary, totalTokens: number): HTMLElement {
    const card = el("details", "", "lcm-explorer__card"); card.dataset.summaryId = summary.summaryId;
    const top = el("summary");
    const labels = el("div", "", "lcm-explorer__row");
    labels.append(el("span", summary.kind === "leaf" ? "Leaf summary" : `Depth ${summary.depth} summary`, "lcm-explorer__kind"),
      el("span", `${tokens(summary.tokenCount)} tokens`, "lcm-explorer__tokens"));
    const title = summary.preview.replace(/^\s*#+\s*/, "").split("\n").find(line => line.trim()) || summary.summaryId;
    top.append(labels, el("div", title, "lcm-explorer__title"),
      el("div", `${date(summary.earliestAt)} — ${date(summary.latestAt)}`, "lcm-explorer__muted"));
    const bar = el("div", "", "lcm-explorer__bar"); const fill = el("span");
    fill.style.width = `${totalTokens ? Math.max(1, Math.min(100, 100 * summary.tokenCount / totalTokens)) : 0}%`; bar.append(fill); top.append(bar);
    const body = el("div", "", "lcm-explorer__body");
    const metadata = el("div", "", "lcm-explorer__metadata");
    metadata.append(el("code", summary.summaryId), el("span", `Created ${date(summary.createdAt)} · ${number(summary.descendantCount)} descendant summaries`));
    if (summary.sourceMessageTokenCount) metadata.append(el("span", `${tokens(summary.sourceMessageTokenCount)} source-message tokens`));
    body.append(metadata); card.append(top, body);
    let loaded = false, pending = false;
    card.addEventListener("toggle", () => {
      if (!card.open || loaded || pending) return;
      pending = true;
      void loadDetail(summary.summaryId, body, 0).then(ok => { loaded = ok; pending = false; });
    });
    return card;
  }

  async function loadDetail(summaryId: string, target: HTMLElement, depth: number): Promise<boolean> {
    const epoch = generation;
    const message = el("p", "Loading summary…", "lcm-explorer__muted"); target.append(message);
    try {
      const detail = await request<ExplorerDetail>({ summaryId });
      if (!alive(epoch) || !target.isConnected) return false;
      message.remove();
      const text = el("pre", detail.content, "lcm-explorer__content"); target.append(text);
      let offset = detail.nextOffset;
      if (offset !== null) {
        const remainder = el("button", "Read more", "lcm-explorer__button"); remainder.type = "button"; target.append(remainder);
        remainder.onclick = async () => {
          remainder.disabled = true;
          try {
            const chunk = await request<ExplorerDetail>({ summaryId, offset });
            if (!alive(epoch)) return;
            text.textContent += chunk.content; offset = chunk.nextOffset;
            if (offset === null) remainder.remove();
          } catch { if (alive(epoch)) remainder.textContent = "Retry reading more"; }
          finally { remainder.disabled = false; }
        };
      }
      target.append(el("p", `${number(detail.sourceMessages)} directly linked source messages`, "lcm-explorer__muted"));
      if (depth < 8) for (const child of detail.children) {
        const branch = el("details", "", "lcm-explorer__branch");
        branch.append(el("summary", `${child.kind === "leaf" ? "Leaf" : `Depth ${child.depth}`} · ${child.summaryId}`));
        const content = el("div"); branch.append(content); target.append(branch);
        let opened = false;
        branch.addEventListener("toggle", () => {
          if (opened || !branch.open) return;
          opened = true;
          void loadDetail(child.summaryId, content, depth + 1).then(ok => { opened = ok; });
        });
      }
      if (detail.childrenTruncated || (depth >= 8 && detail.children.length)) {
        target.append(el("p", "More descendants are available in lcm-tui.", "lcm-explorer__muted"));
      }
      return true;
    } catch {
      if (alive(epoch)) message.textContent = "Could not read this summary. Close and reopen to retry.";
      return false;
    }
  }

  async function reload(append = false) {
    if (loading || disposed || context.signal.aborted || !context.presented) return;
    if (!context.props.sessionKey) { status.textContent = "Select a session to explore its context."; return; }
    if (!context.host.connection.connected) { status.textContent = "Disconnected · displayed context may be stale."; return; }
    loading = true; refresh.disabled = true; more.disabled = true;
    const epoch = generation;
    try {
      const snapshot = await request<ExplorerSnapshot>({ offset: append ? nextOffset ?? 0 : 0 });
      if (!alive(epoch)) return;
      const signature = JSON.stringify({ ...snapshot, capturedAt: undefined });
      if (append || signature !== lastSignature) {
        if (!append) { generation++; list.replaceChildren(); lastSignature = signature; }
        for (const summary of snapshot.summaries) list.append(summaryCard(summary, snapshot.summaryTokens));
        nextOffset = snapshot.nextOffset; more.hidden = nextOffset === null;
        stats.replaceChildren();
        for (const [value, label] of [[number(snapshot.summaryCount), "summaries"], [tokens(snapshot.summaryTokens), "summary tokens"]]) {
          const stat = el("div"); stat.append(el("strong", value), el("span", label)); stats.append(stat);
        }
        tail.textContent = `${number(snapshot.messageCount)} recent messages · ${tokens(snapshot.messageTokens)} tokens · ${tokens(snapshot.messageTokens + snapshot.summaryTokens)} stored tokens total`;
      }
      status.textContent = snapshot.conversationId === null ? "Lossless has not recorded context for this session yet." :
        snapshot.summaryCount === 0 ? "No summaries yet. This session is still using recent messages." :
        `Updated ${new Date(snapshot.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch {
      if (alive(epoch)) status.textContent = "Context unavailable · displayed context may be stale. Refresh to retry.";
    } finally {
      loading = false; refresh.disabled = false; more.disabled = false;
    }
  }
  refresh.onclick = () => { lastSignature = ""; void reload(); };
  more.onclick = () => void reload(true);
  const timer = setInterval(() => { if (document.visibilityState !== "hidden") void reload(); }, 10000);
  void reload();
  const dispose = () => { disposed = true; generation++; clearInterval(timer); root.remove(); };
  initial.signal.addEventListener("abort", dispose, { once: true });
  return {
    update(next: Context) {
      const changed = next.props.sessionKey !== context.props.sessionKey || next.props.agentId !== context.props.agentId;
      context = next;
      if (changed) { generation++; lastSignature = ""; nextOffset = null; list.replaceChildren(); stats.replaceChildren(); tail.textContent = ""; more.hidden = true; status.textContent = "Loading context…"; }
      void reload();
    },
    dispose,
  };
}

export default { id: "lossless-claw", activate(host: Host) {
  return host.ui.registerPanel({ id: "context-explorer", label: "Context explorer", mount });
} };
