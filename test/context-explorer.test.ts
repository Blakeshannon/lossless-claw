import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readContextExplorer, registerContextExplorer, type ExplorerSnapshot, type ExplorerDetail } from "../src/context-explorer.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import type { OpenClawPluginApi, PluginSessionActionRegistration } from "../src/openclaw-bridge.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  runLcmMigrations(db, { fts5Available: getLcmDbFeatures(db).fts5Available });
  db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES
    (1, 'session-a', 'agent:main:a', 1), (2, 'session-b', 'agent:main:b', 1),
    (3, 'old-session-a', 'agent:main:a', 0);
    INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES
    ('leaf-a', 1, 'leaf', 0, 'Original discussion', 12),
    ('root-a', 1, 'condensed', 1, 'Decisions and design', 20),
    ('secret-b', 2, 'leaf', 0, 'Other session', 30),
    ('old-a', 3, 'leaf', 0, 'Archived session', 40);
    INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES
    (1, 1, 1, 'user', 'Recent question', 10);
    INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf-a', 1, 0);
    INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ('root-a', 'leaf-a', 0);
    INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, message_id) VALUES
    (1, 0, 'summary', 'root-a', NULL), (1, 1, 'message', NULL, 1),
    (2, 0, 'summary', 'secret-b', NULL), (3, 0, 'summary', 'old-a', NULL);`);
  return db;
}

describe("Context explorer", () => {
  it("lists only active context roots, preserving order and separating recent-message tokens", () => {
    const db = fixture();
    const before = db.prepare("SELECT total_changes() AS count").get();
    const snapshot = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    expect(snapshot).toMatchObject({ basis: "stored-active-context", conversationId: 1,
      summaryCount: 1, messageCount: 1, summaryTokens: 20, messageTokens: 10, nextOffset: null });
    expect(snapshot.summaries.map(s => s.summaryId)).toEqual(["root-a"]);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
  it("drills into a root's sources without allowing cross-session or archived summary access", () => {
    const db = fixture();
    const detail = readContextExplorer(db, "agent:main:a", { summaryId: "root-a" }) as ExplorerDetail;
    expect(detail.children).toEqual([{ summaryId: "leaf-a", kind: "leaf", depth: 0 }]);
    expect(readContextExplorer(db, "agent:main:a", { summaryId: "leaf-a" })).toMatchObject({ sourceMessages: 1 });
    for (const summaryId of ["secret-b", "old-a", "' OR 1=1 --"]) {
      expect(() => readContextExplorer(db, "agent:main:a", { summaryId })).toThrow("not found");
    }
  });
  it("does not fall back to archived history or another session", () => {
    const db = fixture();
    db.exec("UPDATE conversations SET active = 0 WHERE conversation_id = 1");
    expect(readContextExplorer(db, "agent:main:a")).toMatchObject({ conversationId: null, summaries: [] });
    expect(readContextExplorer(db, "unknown")).toMatchObject({ conversationId: null, summaryTokens: 0 });
  });
  it("bounds summary pages and content, including Unicode text", () => {
    const db = fixture();
    for (let i = 0; i < 51; i++) {
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'extra', 1)").run(`extra-${i}`);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (1, ?, 'summary', ?)").run(i + 2, `extra-${i}`);
    }
    const first = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    const second = readContextExplorer(db, "agent:main:a", { offset: first.nextOffset }) as ExplorerSnapshot;
    expect(first.summaries).toHaveLength(50); expect(first.nextOffset).toBe(50);
    expect(second.summaries).toHaveLength(2); expect(second.nextOffset).toBeNull();
    expect(first.summaryCount).toBe(52); expect(first.summaryTokens).toBe(71);
    const content = "🌿".repeat(24001);
    db.prepare("UPDATE summaries SET content = ? WHERE summary_id = 'root-a'").run(content);
    const a = readContextExplorer(db, "agent:main:a", { summaryId: "root-a" }) as ExplorerDetail;
    const b = readContextExplorer(db, "agent:main:a", { summaryId: "root-a", offset: a.nextOffset }) as ExplorerDetail;
    expect(a.nextOffset).toBe(24000); expect(b.nextOffset).toBeNull(); expect(a.content + b.content).toBe(content);
    expect(() => readContextExplorer(db, "agent:main:a", { offset: -1 })).toThrow("Invalid offset");
  });
  it("registers an operator.read action requiring a session and exposes no SQL errors", async () => {
    const db = fixture(); let action!: PluginSessionActionRegistration;
    const api = { session: { controls: { registerSessionAction: (value: PluginSessionActionRegistration) => { action = value; } } } } as OpenClawPluginApi;
    registerContextExplorer(api, async () => db);
    expect(action.requiredScopes).toEqual(["operator.read"]);
    const base = { pluginId: "lossless-claw", actionId: "context-explorer" };
    expect(await action.handler(base)).toMatchObject({ ok: false });
    expect(await action.handler({ ...base, sessionKey: "agent:main:a" })).toMatchObject({ ok: true, result: { summaryCount: 1 } });
    expect(await action.handler({ ...base, sessionKey: "agent:main:a", payload: { offset: -1 } })).toMatchObject({ ok: false });
    // Failed read rolls back cleanly and releases the shared mutex.
    expect(await action.handler({ ...base, sessionKey: "agent:main:a" })).toMatchObject({ ok: true });
  });
});
