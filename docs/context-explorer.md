# Context explorer

The **Context explorer** session panel shows the summaries retained in this
session's active Lossless context, in assembly order. It includes summary kind
and depth, covered dates, creation date, stored token estimates, descendant
counts, expandable summary text, and child-summary drill-down. Recent messages
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
Colors, accents, focus outlines, and the UI font follow the selected OpenClaw
theme automatically, including theme changes while the panel is open.
It uses the authenticated session-action transport with `operator.read`, passing
both the panel's session key and agent identity. It makes no model calls, sends
no data to external services, and performs no database mutations.

If you cannot upgrade OpenClaw, retain your earlier compatible Lossless release
and use the `lcm-tui` Context View instead. Custom UI being disabled does not
disable Lossless context management or recall tools.

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
Detail reads enforce the same active-conversation boundary. The browser renders
all stored text as text, never HTML. No database path, credentials, or provider
access is exposed to the browser.
