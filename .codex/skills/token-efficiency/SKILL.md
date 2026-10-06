---
name: token-efficiency
description: Reduce unnecessary context, tool calls, file reads, and repeated output while preserving correctness.
---

# Token Efficiency

Use on repository tasks to minimize wasted context without reducing correctness.

- Search narrowly before reading broadly.
- Read only relevant files/sections.
- Never dump large files, logs, dependencies, or generated output into context.
- Reuse information already obtained.
- Combine independent searches when practical.
- Avoid unrelated refactors.
- Make the smallest safe change.
- Prefer focused tests/checks over unnecessary full-suite runs.
- Keep final responses concise: changed, verified, caveats.
- Never sacrifice required verification, security, or correctness to save tokens.
