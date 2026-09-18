import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import { ContextAssembler } from "../src/assembler.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import {
  extractAssistantToolCallIdsForPairing,
  extractToolResultIdForPairing,
} from "../src/tool-pairing.js";

afterEach(cleanupEngineTestState);
const sessionId = "first-turn-overflow";
const sessionKey = "agent:main:subagent:overflow";
const sessionTarget = {
  sessionId,
  sessionKey,
  agentId: "main",
  storePath: "/tmp/host.sqlite",
  threadId: "child",
};
const runtimeSettings = {
  schemaVersion: 1,
  executionHost: { id: "openclaw-embedded", label: "OpenClaw" },
} as const;
const config = {
  freshTailCount: 4,
  freshTailMaxTokens: 2500,
  leafChunkTokens: 3000,
  bootstrapMaxTokens: 1000,
  maxAssemblyTokenBudget: 8000,
  contextThreshold: 0.7,
  largeFileTokenThreshold: 1000000,
};

/** Build the host's authoritative user-led tool transcript, including stable entry identity. */
function transcript(pairs = 12): VisibleSessionTranscriptMessageEntry[] {
  const messages: AgentMessage[] = [
    { role: "user", content: "Inspect the files and report their findings." },
  ];
  for (let index = 0; index < pairs; index++) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `call_${index}`,
          name: "read",
          arguments: { path: `file-${index}` },
        },
      ],
    } as AgentMessage);
    messages.push({
      role: "toolResult",
      toolCallId: `call_${index}`,
      toolName: "read",
      content: [
        { type: "text", text: `FILE_${index} ${"evidence ".repeat(500)}` },
      ],
    } as AgentMessage);
  }
  return messages.map((message, index) => ({
    entryId: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    seq: index + 1,
    role: message.role,
    message,
    createdAt: new Date(1789730000000 + index).toISOString(),
  }));
}

/** Exercise the same compacted-result retry gate as supported OpenClaw overflow recovery. */
async function recover(
  entries: VisibleSessionTranscriptMessageEntry[],
  warm = false,
  settings = config
) {
  const complete = vi.fn(async () => ({
    content: [
      {
        type: "text",
        text: "Completed file reads found deployment evidence; consult the linked raw messages for details.",
      },
    ],
  }));
  const read = vi.fn(async () => entries);
  const info = vi.fn();
  const engine = createEngineWithDeps(settings, {
    complete,
    readVisibleSessionTranscriptMessageEntries: read,
    log: { info, debug: vi.fn(), warn: info, error: info },
  });
  if (warm) {
    await engine.ingest({
      sessionId,
      sessionKey,
      message: attachTranscriptEntryMeta(entries[0]!.message, {
        entryId: entries[0]!.entryId,
        parentId: null,
        timestamp: entries[0]!.createdAt ?? null,
      }),
    });
  }
  const live = entries.map((entry) => entry.message);
  const before = estimateSerializedMessagesTokens(live);
  // Model the provider's context gate; the initial request fails and the actual
  // assembled retry must fit without dropping summaries through the budget clamp.
  const provider = vi.fn(async (messages: AgentMessage[]) => {
    if (estimateSerializedMessagesTokens(messages) >= 8000)
      throw new Error("context_length_exceeded");
    return {
      role: "assistant",
      content: "The inspected files contain deployment evidence.",
    } as AgentMessage;
  });
  await expect(provider(live)).rejects.toThrow("context_length_exceeded");
  const result = await engine.compact({
    sessionId,
    sessionKey,
    sessionTarget,
    sessionFile: "/tmp/host.jsonl",
    tokenBudget: 8000,
    currentTokenCount: before,
    compactionTarget: "budget",
    force: true,
    runtimeSettings,
  });
  // OpenClaw 2026.9.4 retries when compacted is true, even after partial progress.
  expect(result.compacted).toBe(true);
  const retry = await engine.assemble({
    sessionId,
    sessionKey,
    messages: live,
    tokenBudget: 8000,
    runtimeSettings,
  });
  const conv = await engine
    .getConversationStore()
    .getConversationForSession({ sessionId, sessionKey });
  const raw = await new ContextAssembler(
    engine.getConversationStore(),
    engine.getSummaryStore()
  ).assemble({
    conversationId: conv!.conversationId,
    tokenBudget: 8000,
    freshTailCount: settings.freshTailCount,
    freshTailMaxTokens: settings.freshTailMaxTokens,
  });
  return { engine, complete, read, result, retry, before, raw, info, provider };
}

describe("authoritative forced overflow recovery", () => {
  for (const warm of [false, true])
    it(`reduces the retry prompt and preserves raw history (existing prefix=${warm})`, async () => {
      const entries = transcript();
      const {
        engine,
        complete,
        read,
        result,
        retry,
        before,
        raw,
        info,
        provider,
      } = await recover(entries, warm);
      await expect(provider(retry.messages)).resolves.toMatchObject({
        role: "assistant",
      });
      expect(provider).toHaveBeenCalledTimes(2);
      expect(retry.messages[0]).toMatchObject({
        role: "user",
        content: entries[0]!.message.content,
      });
      expect(retry.messages[1]?.role).toBe("assistant");
      expect(read).toHaveBeenCalledWith(sessionTarget);
      expect(complete).toHaveBeenCalled();
      expect(retry.messages).toEqual(raw.messages);
      expect(
        info.mock.calls.some(([line]) => String(line).includes("budget clamp"))
      ).toBe(false);
      expect(result.result!.tokensAfter).toBeLessThan(
        result.result!.tokensBefore!
      );
      expect(estimateSerializedMessagesTokens(retry.messages)).toBeLessThan(
        8000
      );
      expect(estimateSerializedMessagesTokens(retry.messages)).toBeLessThan(
        before
      );
      expect(
        retry.messages.findLast((message) => message.role === "user")?.content
      ).toBe(entries[0]!.message.content);
      expect(JSON.stringify(retry.messages)).toContain("<summary");
      expect(
        retry.messages.filter((message) => message.role === "user")
      ).toHaveLength(1);
      const ids = retry.messages.flatMap(extractAssistantToolCallIdsForPairing);
      const results = retry.messages
        .map(extractToolResultIdForPairing)
        .filter(Boolean);
      expect(results).toEqual(ids);
      expect(results).toContain("call_11");
      const conversation = await engine
        .getConversationStore()
        .getConversationForSession({ sessionId, sessionKey });
      const rows = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(rows).toHaveLength(entries.length);
      expect(rows.map((row) => row.transcriptEntryId)).toEqual(
        entries.map((entry) => entry.entryId)
      );
      expect(rows.filter((row) => row.role === "tool")).toHaveLength(12);
      expect(rows.at(-1)!.content).toContain("FILE_11");
      expect(rows.find((row) => row.content.includes("FILE_0"))).toBeTruthy();
    });

  it("retains the initiating user when the configured fresh tail is disabled", async () => {
    const entries = transcript();
    const { retry } = await recover(entries, false, {
      ...config,
      freshTailCount: 0,
    });
    expect(retry.messages[0]).toMatchObject(entries[0]!.message);
    expect(
      retry.messages.filter((message) => message.role === "user")
    ).toHaveLength(1);
  });

  it("keeps unresolved calls and later raw history behind a recovery barrier", async () => {
    const entries = transcript();
    entries.splice(12, 1); // Remove call_5's result while retaining later complete groups.
    const { engine, retry } = await recover(entries);
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    const context = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    const raw = await Promise.all(
      context
        .filter((item) => item.messageId != null)
        .map((item) =>
          engine.getConversationStore().getMessageById(item.messageId!)
        )
    );
    expect(raw.some((row) => row?.transcriptEntryId === "entry-11")).toBe(true);
    expect(raw.some((row) => row?.content.includes("FILE_6"))).toBe(true);
    expect(
      retry.messages.findLast((message) => message.role === "user")?.content
    ).toBe(entries[0]!.message.content);
  });

  it.each([
    { force: false, compactionTarget: "budget" as const },
    { force: true, compactionTarget: "threshold" as const },
  ])("leaves ordinary prefix-only compaction unchanged: %o", async (mode) => {
    const entries = transcript();
    const read = vi.fn(async () => entries);
    const complete = vi.fn();
    const engine = createEngineWithDeps(config, {
      complete,
      readVisibleSessionTranscriptMessageEntries: read,
    });
    for (const entry of entries)
      await engine.ingest({ sessionId, sessionKey, message: entry.message });
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionTarget,
      sessionFile: "",
      tokenBudget: 8000,
      runtimeSettings,
      ...mode,
    });
    expect(result.compacted).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps ordinary historical mixed-tool summaries in their existing user role", async () => {
    const engine = createEngineWithDeps(config);
    const messages = [
      ...transcript(1).map((entry) => entry.message),
      {
        role: "user",
        content: "Now review the deployment plan.",
      } as AgentMessage,
    ];
    for (const message of messages)
      await engine.ingest({ sessionId, sessionKey, message });
    const store = engine.getConversationStore();
    const summaries = engine.getSummaryStore();
    const conversation = await store.getConversationForSession({
      sessionId,
      sessionKey,
    });
    const conversationId = conversation!.conversationId;
    const rows = await store.getMessages(conversationId);
    // Existing historical leaf provenance contains both assistant and tool rows,
    // but precedes the current user and must retain normal prefix rendering.
    await summaries.insertSummary({
      summaryId: "historical-tool-leaf",
      conversationId,
      kind: "leaf",
      depth: 0,
      content: "Historical file evidence.",
      tokenCount: 8,
    });
    await summaries.linkSummaryToMessages(
      "historical-tool-leaf",
      rows.slice(1, 3).map((row) => row.messageId)
    );
    await summaries.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: 1,
      endOrdinal: 2,
      summaryId: "historical-tool-leaf",
    });
    const assembled = await new ContextAssembler(store, summaries).assemble({
      conversationId,
      tokenBudget: 8000,
      freshTailCount: 4,
    });
    const summary = assembled.messages.find((message) =>
      JSON.stringify(message.content).includes("Historical file evidence.")
    );
    expect(summary?.role).toBe("user");
    expect(assembled.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Now review the deployment plan.",
    });
  });

  it("imports more than the normal reconciliation cap without truncating the initiating user", async () => {
    const entries = transcript(30);
    const { engine } = await recover(entries);
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(
      await engine
        .getConversationStore()
        .getMessageCount(conversation!.conversationId)
    ).toBe(61);
  });

  it("keeps identity and the initiating user stable through compact, commit, and reassembly", async () => {
    const entries = transcript();
    const { engine, complete, retry } = await recover(entries);
    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({
      sessionId,
      sessionKey,
    });
    const before = await store.getMessages(conversation!.conversationId);
    const admission = {
      ...sessionTarget,
      entryId: entries[0]!.entryId,
      effectiveParentId: null,
      generation: "g1",
      logicalTurnId: "turn-1",
      rawSeq: 1,
      activeMessagePosition: 0,
      role: "user" as const,
    };
    const last = entries.at(-1)!;
    const terminal = {
      ...sessionTarget,
      entryId: last.entryId,
      effectiveParentId: last.parentId,
      generation: "g1",
      rawSeq: entries.length,
      activeMessagePosition: entries.length - 1,
    };
    const commit = {
      sessionId,
      sessionKey,
      sessionTarget,
      advancementKey: "turn-1",
      admission,
      terminal,
      messages: entries.map((entry) =>
        attachTranscriptEntryMeta(entry.message, {
          entryId: entry.entryId,
          parentId: entry.parentId,
          timestamp: entry.createdAt ?? null,
        })
      ),
    };
    await expect(engine.commitTurn(commit)).resolves.toEqual({
      status: "committed",
    });
    await expect(engine.commitTurn(commit)).resolves.toEqual({
      status: "duplicate",
    });
    const calls = complete.mock.calls.length;
    await engine.compact({
      sessionId,
      sessionKey,
      sessionTarget,
      sessionFile: "",
      tokenBudget: 8000,
      force: true,
      compactionTarget: "budget",
      runtimeSettings,
    });
    expect(complete.mock.calls.length).toBe(calls);
    const second = await engine.assemble({
      sessionId,
      sessionKey,
      messages: entries.map((entry) => entry.message),
      tokenBudget: 8000,
      runtimeSettings,
    });
    expect(second.messages).toEqual(retry.messages);
    const after = await store.getMessages(conversation!.conversationId);
    expect(
      after.map((row) => [row.messageId, row.transcriptEntryId, row.content])
    ).toEqual(
      before.map((row) => [row.messageId, row.transcriptEntryId, row.content])
    );
  });

  it.each([
    "empty",
    "duplicate ids",
    "unrelated projection",
    "no initiating user",
    "stale raw suffix",
  ])("does not summarize an unproven snapshot: %s", async (kind) => {
    const entries = kind === "empty" ? [] : transcript();
    if (kind === "no initiating user") entries.shift();
    if (kind === "duplicate ids") entries[1]!.entryId = entries[0]!.entryId;
    const complete = vi.fn();
    const engine = createEngineWithDeps(config, {
      complete,
      readVisibleSessionTranscriptMessageEntries: async () => entries,
    });
    if (kind === "stale raw suffix") {
      for (const entry of entries)
        await engine.ingest({
          sessionId,
          sessionKey,
          message: attachTranscriptEntryMeta(entry.message, {
            entryId: entry.entryId,
            parentId: entry.parentId,
            timestamp: null,
          }),
        });
      await engine.ingest({
        sessionId,
        sessionKey,
        message: { role: "assistant", content: "stale epoch suffix" },
      });
    }
    if (kind === "unrelated projection") {
      await engine.ingest({
        sessionId,
        sessionKey,
        message: attachTranscriptEntryMeta(
          { role: "user", content: "different epoch" },
          { entryId: "other-epoch", parentId: null, timestamp: null }
        ),
      });
    }
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionTarget,
      sessionFile: "",
      force: true,
      compactionTarget: "budget",
      tokenBudget: 8000,
    });
    expect(result.compacted).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it("serializes concurrent recovery snapshots without duplicate ingestion", async () => {
    const entries = transcript();
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "Short completed tool summary." }],
    }));
    const engine = createEngineWithDeps(config, {
      complete,
      readVisibleSessionTranscriptMessageEntries: async () => entries,
    });
    const params = {
      sessionId,
      sessionKey,
      sessionTarget,
      sessionFile: "",
      force: true,
      compactionTarget: "budget" as const,
      tokenBudget: 8000,
      runtimeSettings,
    };
    await Promise.all([engine.compact(params), engine.compact(params)]);
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    const rows = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(rows.map((row) => row.transcriptEntryId)).toEqual(
      entries.map((entry) => entry.entryId)
    );
  });

  it("fails closed when the authoritative reader fails", async () => {
    const complete = vi.fn();
    const engine = createEngineWithDeps(config, {
      complete,
      readVisibleSessionTranscriptMessageEntries: async () => {
        throw new Error("host unavailable");
      },
    });
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionTarget,
      sessionFile: "",
      force: true,
      compactionTarget: "budget",
      tokenBudget: 8000,
    });
    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(complete).not.toHaveBeenCalled();
    expect(
      await engine
        .getConversationStore()
        .getConversationForSession({ sessionId, sessionKey })
    ).toBeNull();
  });
});
