---
"@martian-engineering/lossless-claw": patch
---

Run pending-summary preparation and deferred compaction in awaited, host-owned
background maintenance instead of detached turn callbacks. Preserve prepare-only
and threshold publication behavior without blocking foreground ingestion. Treat
closed host async scopes as lifecycle failures rather than provider failures,
preventing provider retries and deterministic fallback for this condition.
