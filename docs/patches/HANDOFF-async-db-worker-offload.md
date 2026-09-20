# Async DB Worker Handoff

## PINNED_SHA

`c168562dc6137e40440654c814170666b121f3e4`

Recorded from `/tmp/lossless-claw-fork/repo` before implementation work. The worktree branch already had checkpoint commit `e2212172f247f29eb0e8e1955930504b8dc5b443`; I preserved that history and committed on `agent/async-db-worker-offload`.

## Transaction Atomicity Design

Implemented a worker-backed async DB client with a per-connection request queue and a `withWorkerTransaction()` method. For async worker connections, `withDatabaseTransaction()` now delegates to `withWorkerTransaction()`, which holds an exclusive client-side queue slot from `BEGIN` through `COMMIT`/`ROLLBACK`. Nested scopes use SQLite savepoints.

This prevents other operations issued through the same async connection from interleaving while the transaction is open, and the actual SQLite work executes on the worker thread. However, this is not the exact single-message/serializable-plan transaction design required by the contract. It remains multiple worker RPC round trips inside an exclusive transaction window.

## Files Changed

- `src/db/worker/types.ts` - added shared async DB protocol types and async connection type guard.
- `src/db/worker/db-worker.ts` - added eval worker source that owns `DatabaseSync`, applies existing pragmas, and serves message-based `exec`/`prepare().get|all|run`/`close` RPCs.
- `src/db/worker/db-client.ts` - added main-thread async worker DB client, RPC timeout handling, request rejection on worker crash, clean close, and exclusive transaction queue.
- `src/db/connection.ts` - added async worker connection creation/tracking/close lifecycle equivalents while leaving existing sync tracking intact.
- `src/transaction-mutex.ts` - routed async worker connections through `withWorkerTransaction()` and kept existing sync mutex behavior for `DatabaseSync`.
- `test/db-worker-client.test.ts` - added event-loop nonblocking regression test for concurrent worker-backed SQLite queries.

## Validation Commands

- `npm run typecheck` - exit code 0.
- `npm test` - exit code 0. Vitest reported 127 files passed and 2002 tests passed.
- `npm run build` - exit code 0.
- `npm test -- test/db-worker-client.test.ts` - exit code 0.

Optional `release:verify` attempts:

- `npm run release:verify` - exit code 1. Failed in `npm run test:tui` because Go tried to write `/Users/blakeshannon/Library/Caches/go-build`, which the sandbox cannot access.
- `GOCACHE=/tmp/lossless-claw-go-build-cache npm run release:verify` - exit code 1. Failed in `npm run test:tui` because Go tried to write module cache paths under `/Users/blakeshannon/go/pkg/mod`, which the sandbox cannot access.
- `GOCACHE=/tmp/lossless-claw-go-build-cache GOPATH=/tmp/lossless-claw-go npm run release:verify` - exit code 1. Got past cache permissions, then failed in `npm run test:tui` because the sandbox has no DNS/network access to download Go modules from `proxy.golang.org`.

## New Regression Test

`test/db-worker-client.test.ts` starts 20 concurrent worker-backed recursive SQLite queries and asserts a `setTimeout(0)` callback fires before all query promises resolve. This proves the main thread remains available while the worker executes SQLite work.

## Deviations From Contract

- The full 28-file call-site migration was not completed. Existing plugin hook execution still constructs and uses the synchronous `DatabaseSync` engine path, so the production hook path is not fully offloaded yet.
- Transaction atomicity is implemented as an exclusive worker transaction window with multiple RPCs, not as a single serialized transaction message or worker-interpreted query plan.
- `createLcmDatabaseConnection()` itself remains synchronous for existing callers. Async lifecycle equivalents were added as `createAsyncLcmDatabaseConnection()` / `closeAsyncLcmConnection()` but the plugin is not yet switched to them.
- No Changeset was added because the completed work is scaffold/lifecycle/test coverage and is not yet a user-facing behavior change.

## Local Commits

- `d823e8e feat: add async database worker client`
- `77f8a74 feat: route async db transactions through worker`
- `c0048ff feat: track async db worker connections`
