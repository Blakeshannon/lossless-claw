import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createAsyncLcmDatabaseConnection } from "../src/db/worker/db-client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AsyncWorkerDatabaseConnection", () => {
  it("runs concurrent long SQLite queries without blocking the main event loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-worker-db-"));
    tempDirs.push(dir);
    const db = createAsyncLcmDatabaseConnection(join(dir, "lcm.db"), {
      rpcTimeoutMs: 120_000,
    });

    try {
      await db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
      await db.prepare("INSERT INTO probe (value) VALUES (?)").run("ready");

      const sql = `
        WITH RECURSIVE cnt(x) AS (
          VALUES(0)
          UNION ALL
          SELECT x + 1 FROM cnt WHERE x < 25000
        )
        SELECT max(x) AS max_value FROM cnt
      `;

      let allResolved = false;
      let timerFiredBeforeAllResolved = false;
      const queries = Array.from({ length: 20 }, () => db.prepare(sql).get());
      const allQueries = Promise.all(queries).then((rows) => {
        allResolved = true;
        return rows;
      });

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFiredBeforeAllResolved = !allResolved;
          resolve();
        }, 0);
      });

      const rows = await allQueries;
      expect(timerFiredBeforeAllResolved).toBe(true);
      expect(rows).toHaveLength(20);
      expect(rows.every((row) => (row as { max_value: number }).max_value === 25000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);
});
