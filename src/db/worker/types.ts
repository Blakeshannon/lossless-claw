import type { SQLInputValue } from "node:sqlite";

export type MaybePromise<T> = T | Promise<T>;

export interface LcmStatementResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface LcmPreparedStatement {
  get(...params: SQLInputValue[]): MaybePromise<unknown>;
  all(...params: SQLInputValue[]): MaybePromise<unknown[]>;
  run(...params: SQLInputValue[]): MaybePromise<LcmStatementResult>;
}

export interface LcmDatabaseLike {
  exec(sql: string): MaybePromise<void>;
  prepare(sql: string): LcmPreparedStatement;
}

export interface AsyncLcmDatabaseConnection extends LcmDatabaseLike {
  readonly asyncLcmDatabase: true;
  close(): Promise<void>;
  withWorkerTransaction<T>(
    beginStatement: "BEGIN" | "BEGIN IMMEDIATE",
    operation: () => Promise<T> | T,
  ): Promise<T>;
}

export function isAsyncLcmDatabaseConnection(
  db: LcmDatabaseLike,
): db is AsyncLcmDatabaseConnection {
  return (db as Partial<AsyncLcmDatabaseConnection>).asyncLcmDatabase === true;
}
