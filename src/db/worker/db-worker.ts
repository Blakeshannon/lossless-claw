export const DB_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

function normalizeDbPathInput(dbPath) {
  return typeof dbPath === "string" ? dbPath.trim() : "";
}

function isInMemoryPath(dbPath) {
  const normalized = normalizeDbPathInput(dbPath);
  return normalized === ":memory:" || normalized.startsWith("file::memory:");
}

function getFileBackedDatabasePath(dbPath) {
  const trimmed = normalizeDbPathInput(dbPath);
  if (!trimmed || isInMemoryPath(trimmed)) {
    return null;
  }
  return resolve(trimmed);
}

function ensureDbDirectory(dbPath) {
  const fileBackedDatabasePath = getFileBackedDatabasePath(dbPath);
  if (!fileBackedDatabasePath) {
    return;
  }
  mkdirSync(dirname(fileBackedDatabasePath), { recursive: true });
}

function configureConnection(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = " + SQLITE_BUSY_TIMEOUT_MS);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA temp_store = MEMORY");
  if (typeof db.enableLoadExtension === "function") {
    db.enableLoadExtension(false);
  }
  return db;
}

function createDatabaseSync(dbPath) {
  const supportsExtensionLoading =
    typeof DatabaseSync.prototype.enableLoadExtension === "function";
  return supportsExtensionLoading
    ? new DatabaseSync(dbPath, { allowExtension: true })
    : new DatabaseSync(dbPath);
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

let db;
try {
  ensureDbDirectory(workerData.dbPath);
  db = configureConnection(createDatabaseSync(workerData.dbPath));
} catch (error) {
  parentPort.postMessage({
    requestId: 0,
    error: serializeError(error),
  });
}

parentPort.on("message", (message) => {
  const { requestId, method, args } = message;
  try {
    if (!db) {
      throw new Error("LCM DB worker failed to initialize");
    }
    let result;
    switch (method) {
      case "exec":
        db.exec(args.sql);
        result = undefined;
        break;
      case "statement":
        result = db.prepare(args.sql)[args.operation](...(args.params ?? []));
        break;
      case "close":
        try { db.exec("PRAGMA optimize"); } catch {}
        db.close();
        db = undefined;
        result = undefined;
        break;
      default:
        throw new Error("Unknown LCM DB worker method: " + method);
    }
    parentPort.postMessage({ requestId, result });
  } catch (error) {
    parentPort.postMessage({ requestId, error: serializeError(error) });
  }
});
`;
