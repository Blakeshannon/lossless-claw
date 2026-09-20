import { Worker } from "node:worker_threads";
import type { SQLInputValue } from "node:sqlite";
import { DB_WORKER_SOURCE } from "./db-worker.js";
import type {
  AsyncLcmDatabaseConnection,
  LcmPreparedStatement,
  LcmStatementResult,
} from "./types.js";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

type WorkerSuccess = {
  requestId: number;
  result: unknown;
};

type WorkerFailure = {
  requestId: number;
  error: {
    name?: string;
    message?: string;
    stack?: string;
    code?: unknown;
  };
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function reviveWorkerError(error: WorkerFailure["error"]): Error {
  const revived = new Error(error.message ?? "LCM DB worker request failed");
  revived.name = error.name ?? "Error";
  if (error.stack) {
    revived.stack = error.stack;
  }
  if (error.code !== undefined) {
    (revived as Error & { code?: unknown }).code = error.code;
  }
  return revived;
}

class AsyncWorkerStatement implements LcmPreparedStatement {
  constructor(
    private readonly request: (
      method: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly sql: string,
  ) {}

  get(...params: SQLInputValue[]): Promise<unknown> {
    return this.request("statement", { operation: "get", sql: this.sql, params });
  }

  all(...params: SQLInputValue[]): Promise<unknown[]> {
    return this.request("statement", { operation: "all", sql: this.sql, params }) as Promise<unknown[]>;
  }

  run(...params: SQLInputValue[]): Promise<LcmStatementResult> {
    return this.request("statement", { operation: "run", sql: this.sql, params }) as Promise<LcmStatementResult>;
  }
}

export class AsyncWorkerDatabaseConnection implements AsyncLcmDatabaseConnection {
  readonly asyncLcmDatabase = true;
  private readonly worker: Worker;
  private nextRequestId = 1;
  private closed = false;
  private transactionDepth = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    readonly dbPath: string,
    private readonly options: { rpcTimeoutMs?: number } = {},
  ) {
    this.worker = new Worker(DB_WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath },
    });
    this.worker.on("message", (response: WorkerResponse) => this.handleMessage(response));
    this.worker.on("error", (error: Error) => this.rejectAll(error));
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.rejectAll(new Error(`LCM DB worker exited unexpectedly with code ${code}`));
      }
    });
  }

  exec(sql: string): Promise<void> {
    return this.request("exec", { sql }) as Promise<void>;
  }

  prepare(sql: string): LcmPreparedStatement {
    return new AsyncWorkerStatement(
      (method, args) => this.request(method, args),
      sql,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.send("close", {});
    } catch {
      // Ignore close failures; callers are shutting down anyway.
    } finally {
      this.rejectAll(new Error("LCM DB worker connection closed"));
      await this.worker.terminate();
    }
  }

  async withWorkerTransaction<T>(
    beginStatement: "BEGIN" | "BEGIN IMMEDIATE",
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.enqueue(async () => {
      if (this.transactionDepth > 0) {
        const savepointName = `lcm_txn_savepoint_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
        await this.send("exec", { sql: `SAVEPOINT ${savepointName}` });
        this.transactionDepth++;
        try {
          const result = await operation();
          await this.send("exec", { sql: `RELEASE SAVEPOINT ${savepointName}` });
          return result;
        } catch (error) {
          await this.send("exec", { sql: `ROLLBACK TO SAVEPOINT ${savepointName}` });
          await this.send("exec", { sql: `RELEASE SAVEPOINT ${savepointName}` });
          throw error;
        } finally {
          this.transactionDepth--;
        }
      }

      await this.send("exec", { sql: beginStatement });
      this.transactionDepth++;
      try {
        const result = await operation();
        await this.send("exec", { sql: "COMMIT" });
        return result;
      } catch (error) {
        await this.send("exec", { sql: "ROLLBACK" });
        throw error;
      } finally {
        this.transactionDepth--;
      }
    });
  }

  private request(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.transactionDepth > 0) {
      return this.send(method, args);
    }
    return this.enqueue(() => this.send(method, args));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(operation);
    this.queue = run;
    return run;
  }

  private send(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed && method !== "close") {
      return Promise.reject(new Error("LCM DB worker connection is closed"));
    }
    const requestId = this.nextRequestId++;
    const timeoutMs = this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for LCM DB worker response`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.worker.postMessage({ requestId, method, args });
    });
  }

  private handleMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.requestId);
    if ("error" in response) {
      pending.reject(reviveWorkerError(response.error));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

export function createAsyncLcmDatabaseConnection(
  dbPath: string,
  options?: { rpcTimeoutMs?: number },
): AsyncLcmDatabaseConnection {
  return new AsyncWorkerDatabaseConnection(dbPath, options);
}
