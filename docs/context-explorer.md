# Context explorer

The **Context explorer** session panel shows the summaries retained in this
session's active Lossless context, in assembly order. It includes readable summary previews, covered dates, stored token estimates,
expandable Markdown, and recursive source-summary drill-down. “Conversation”
summaries summarize messages; “Overview” summaries combine earlier summaries.
Internal summary IDs are not shown, and message counts appear only on leaves. Recent messages
are counted separately; their text is not loaded by the panel.

## Open it

Requires OpenClaw **2026.9.2 or newer**. Native session panels first shipped in
that stable release ([release notes](https://docs.openclaw.ai/releases/2026.9.2)).
This build targets and was contract-checked against OpenClaw 2026.9.4.

1. Build/install this Lossless version (`npm run build` includes browser assets).
2. Enable **Settings → Labs → Custom plugin UI**, then restart the Gateway and
   reload the browser as OpenClaw requests.
3. Open a session and select its **Context explorer** panel.

The compact view updates automatically every ten seconds while visible, and
when reopened or the browser tab becomes visible. There is no Refresh button.
Short ages (`4d`, `1d`, `5h`) refer to the latest covered content, falling back
to summary creation time when coverage is unknown. Hover for exact dates.
Unchanged summary rows retain their expanded text during automatic updates.
The sidebar scrolls independently. Opening a summary shows metadata and a
Markdown preview: the first paragraph or about five rendered lines, whichever
is longer. **Show full summary** loads the remaining text; **Show less** returns
to the preview. Source summaries expand recursively with indentation and the
same preview/full-text controls. Descendants load only when opened.
Colors, accents, focus outlines, and the UI font follow the selected OpenClaw
theme automatically, including theme changes while the panel is open.
It uses the authenticated session-action transport with `operator.read`, passing
both the panel's session key and agent identity. It makes no model calls, sends
no data to external services, and performs no database mutations.

If you cannot upgrade OpenClaw, retain your earlier compatible Lossless release
and use the `lcm-tui` Context View instead. Custom UI being disabled does not
disable Lossless context management or recall tools.

## Conversation overview

The compact overview shows the sum of stored message tokens in this active
conversation, plus the size of its active context (summaries + recent messages).
The compression badge matches `/lcm doctor`: source-message tokens plus
descendant-summary tokens represented by active summaries, divided by active
context tokens, rounded to an integer and shown as `1:N` (minimum `1:1`). It is
omitted when either side is zero. The tooltip explains this accounting; it is
not raw conversation/context division, a savings percentage, or a billing claim.
No model calls are made to generate the source-summary titles: these are excerpts
from the existing summary text.

## Summary quality

Fallback, shortened (truncated), and emergency summaries carry a warning badge,
including nested source summaries. Opening one explains that the summary may
omit detail while original messages remain in history. Detection shares doctor’s
full-content and model-marker logic; it is not inferred from the short preview.
An unmarked summary is not a guarantee of completeness or accuracy.

**Check summaries** runs the read-only summary-quality portion of doctor for the
selected active conversation, including stored summaries outside its active
context. It reports fallback, truncation, and emergency counts inline. It is not
a full `/lcm doctor` health report and never calls a model or rewrites a summary.
For the complete report and repair guidance, run `/lcm doctor` in that session.
The existing repair command is conversation-scoped and has safety preflights;
the explorer does not offer a misleading single-summary repair button or bypass
those checks.

## What “active context” means

This is a coherent snapshot of `context_items` for the active conversation
associated with the selected session. It is **not a recording of the last
model request**. The assembler can select or omit items according to its budget;
focus and runtime projection (including Codex thread continuation) can further
change the delivered prompt. System prompts, tool schemas, and live unsaved
messages are not included in these token totals. Values are stored estimates,
not provider billing or context-window utilization measurements.

Archived conversations are never substituted for a missing current one.
An untracked session and a tracked session without summaries have different
empty states. Failed refreshes label any retained display as potentially stale.

## Read-only API

`plugins.sessionAction`:

```json
{
  "pluginId": "lossless-claw",
  "actionId": "context-explorer",
  "sessionKey": "agent:main:example",
  "agentId": "main",
  "payload": { "offset": 0 }
}
```

Returns `basis: "stored-active-context"`, snapshot time, conversation id, summary
and message counts/tokens, up to 50 summaries, and a nullable `nextOffset`.
Use `{ "summaryId": "sum_...", "offset": 0 }` for summary text (24,000-character
pages), directly linked source-message count, and up to 100 child summaries.
Use `{ "check": true }` for conversation-scoped summary-quality counts.
Detail reads enforce the same active-conversation boundary. The browser renders
Markdown through Marked and a restricted DOMPurify allowlist. Embedded images,
active HTML, styles, and unsafe links are not rendered. No database path, credentials, or provider
access is exposed to the browser.
