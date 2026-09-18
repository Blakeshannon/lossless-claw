---
"@martian-engineering/lossless-claw": patch
---

Report forced compaction as changed only when a summary pass commits work. Preserve partial progress when later passes fail, and avoid opening summary-spend backoff when no model or custom summarizer call was attempted.
