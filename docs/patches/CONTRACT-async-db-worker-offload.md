# Contract: Async DB access for lossless-claw (fork + patch)

## Objective
`lossless-claw` (fork of https://github.com/Martian-Engineering/lossless-claw, pinned at commit
below) uses synchronous `node:sqlite` `DatabaseSync` calls directly inside OpenClaw hook execution
(before_tool_call / after_tool_call / session lifecycle). Under load (56 concurrent agents, 11GB
`lcm.db`, WAL mode) these synchronous B-tree walks block the Node.js main event loop for up to ~10
seconds, freezing the entire gateway for every agent, not just the one whose hook fired. Confirmed
by stack-sample analysis: 315 of 1,373 gateway-freeze stack samples (23%) show
`sqlite3BtreeIndexMoveto -> getAndInitPage -> page-cache allocation` as the dominant frame, spanning
Jul 30 - Sep 19 2026 (predates any other plugin install, so this is lossless-claw's own code path).

Fix: move all `DatabaseSync` query execution off the main thread into a dedicated `worker_threads`
worker, so hook code awaits a message-passed promise instead of blocking the event loop directly.
The worker still executes queries synchronously against SQLite (unavoidable with this driver), but
the *main* thread — the one servicing every other agent's turn — never blocks.

## Source / pin
- Upstream repo: https://github.com/Martian-Engineering/lossless-claw
- Local fork checkout: /tmp/lossless-claw-fork/repo
- Pin commit: record `git log -1 --format='%H'` output from the checkout as PINNED_SHA in your
  handoff notes before starting. Do not rebase onto a newer upstream commit mid-task.

## Write scope
- Worktree: create with git-worktree-discipline from /tmp/lossless-claw-fork/repo — path
  `/tmp/wt-<uuid>`, branch `agent/async-db-worker-offload`. Do not write to
  /tmp/lossless-claw-fork/repo directly or to any OpenClaw agent/extension directory.
- Nothing outside the worktree is in scope. Do not touch the live installed plugin at
  ~/.openclaw/extensions/lossless-claw — that is a separate deploy step, gated, after review.

## Architecture (confirmed this session, read before designing)
- Single connection factory: `src/db/connection.ts` — `createLcmDatabaseConnection(dbPath)` returns
  a raw `DatabaseSync` handle. Also owns `connectionsByPath`/`connectionIndex` tracking maps used by
  tests to close connections by path.
- 28 files under `src/` import `DatabaseSync`/`node:sqlite` or consume the connection, including:
  `src/engine.ts`, `src/compaction.ts`, `src/prune.ts`, `src/transaction-mutex.ts`,
  `src/store/*.ts` (summary-store, conversation-store, pending-summary-store,
  compaction-telemetry-store, focus-brief-store, compaction-maintenance-store),
  `src/cli/*.ts`, `src/plugin/*.ts` (index.ts, lcm-command.ts, lcm-doctor-*.ts, lcm-db-backup.ts,
  shared-init.ts).
- Hook wiring lives in `src/plugin/index.ts`, which imports `createLcmDatabaseConnection` /
  `closeLcmConnection` from `src/db/connection.ts` directly and calls store methods synchronously
  inside the hook handler (`return async (params) => { ... }` at line 86 — already async at the
  outer level, but every DB call inside is a blocking sync call, not an awaited one).
- `src/transaction-mutex.ts` implements `withDatabaseTransaction` — a mutex wrapper around
  transactions. Any worker-offload design must preserve transactional semantics (a batch of writes
  that must commit/rollback atomically cannot be split across separate worker round-trips).

## Design requirements
1. Build a worker module (e.g. `src/db/worker/db-worker.ts`) that owns the actual `DatabaseSync`
   connection and exposes a message-based RPC surface: `{ requestId, method, args } -> { requestId,
   result | error }`. The worker thread does the real synchronous SQLite work; it is allowed to
   block itself — that's fine, it's not the main thread.
2. Build a main-thread proxy (e.g. `src/db/worker/db-client.ts`) exposing the same shape of API the
   stores currently call, but async: every method returns a `Promise` that resolves/rejects based on
   the worker's response. This is the seam — the goal is minimizing churn in the 28 call-site files
   by keeping method signatures structurally similar (same method names/args, now returning
   Promises), rather than a bespoke API per store.
3. Preserve transaction atomicity: `withDatabaseTransaction` must execute its full callback body
   inside a single worker-side transaction, not decompose into N round trips that could interleave
   with other transactions. Design the RPC so a transaction is a single message (serialize the
   list of operations, or pass a query plan) rather than a naive per-statement round trip, OR keep
   the whole transaction body executing worker-side via a serializable script the worker interprets.
   State clearly in your handoff which approach you took and why.
4. Update every one of the 28 call sites to `await` the now-async API. Do not silently swallow
   promise rejections — existing error handling behavior (including `catch { /* best-effort */ }`
   patterns already present in the code) must be preserved at each site, not just moved.
5. Startup/shutdown: `createLcmDatabaseConnection`/`closeLcmConnection` need worker-lifecycle
   equivalents (spawn worker on init, terminate cleanly on close, handle worker crash without
   hanging the main thread forever — set a reasonable RPC timeout, e.g. reuse the existing 30s
   SQLITE_BUSY_TIMEOUT_MS as a ceiling).
6. Do not change on-disk schema, pragmas (WAL mode, busy_timeout, cache_size, synchronous=NORMAL,
   temp_store=MEMORY), or the `lcm.db` file path/location logic in `src/plugin/shared-init.ts`.

## Validation (must pass before declaring done)
1. `npm run typecheck` — zero new errors.
2. `npm test` (vitest run --dir test) — full existing suite green. Do not skip/delete failing tests
   to make this pass; if a test's assumptions no longer hold because the API is now async, update
   the test to await the new API, and note that explicitly in your handoff — do not weaken the
   assertion.
3. `npm run build` — esbuild bundle succeeds with no new external deps beyond `node:worker_threads`
   (built-in, no package.json change needed for that).
4. New test: write at least one test that starts N (e.g. 20) concurrent long-running queries against
   a shared in-memory or temp-file db through the new async client and asserts that a
   `setImmediate`/`setTimeout(0)` callback queued after issuing the queries fires before all N
   queries resolve — i.e. prove the main thread was not blocked. This is the actual regression test
   for the bug being fixed; without it we have no evidence the fix works, just that nothing broke.
5. Run `release:verify` script if time allows (typecheck + build + test + pack --dry-run).

## Explicitly out of scope
- Do not touch `context-mode` plugin (separate codebase, separate owner decision).
- Do not deploy to the live `~/.openclaw/extensions/lossless-claw` install. That is a separate,
  Blake-gated step after code review of this branch's diff.
- Do not push the branch anywhere (no `git push`) — local commits only, per git-worktree-discipline.
- Do not attempt to shrink/vacuum the live 11GB `lcm.db` — unrelated mitigation, handled separately.
- Do not upgrade any dependency versions incidentally while touching these files.

## Required handoff / RESULT line
On completion (or if blocked/parked per Tier 1.9 loop-break rules), write a handoff file
`/tmp/lossless-claw-fork/HANDOFF-async-db-worker.md` containing:
- PINNED_SHA used
- Design choice made for requirement 3 (transaction atomicity) and why
- Full list of files changed with one-line description each
- Exact commands run and their exit codes for typecheck/test/build
- The new concurrency regression test's file path and a one-line description of what it proves
- Any deviation from this contract and why

Final message back to the orchestrator must include one line starting `RESULT:` stating pass/fail
per validation step above, with exact commands and exit codes — not "tests look good."
