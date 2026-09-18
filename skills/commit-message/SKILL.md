---
name: commit-message
description: Write a git commit message following Conventional Commits format. Use when the user asks you to write, draft, or suggest a commit message for a code change.
---

# Commit Message Writer

Write a commit message following the Conventional Commits spec:

1. Format: `<type>(<optional scope>): <short summary>`
2. Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
   `perf`, `style`, `ci`, `build`.
3. Summary line: imperative mood ("add", not "added" or "adds"),
   under 72 characters, no trailing period.
4. If the change needs more explanation, add a blank line then a
   body in plain prose — what changed and why, not a line-by-line
   diff narration.
5. Breaking changes: add a `BREAKING CHANGE:` footer describing the
   break and migration path.

Ask for the diff or a description of the change if it wasn't
already given — never invent what the change does.
