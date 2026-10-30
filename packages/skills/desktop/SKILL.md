---
name: desktop
description: Observe macOS applications and request bounded native actions through the Rust Host.
---

# Controlled Native Desktop

Use `desktop_observe` before any targeted action. References belong to one
observation, window, task, and Host boot; never guess or reuse stale references.
Ask the user to enable missing permissions in Settings. Text chat remains
available without microphone access.

The Host alone owns permissions, exclusive leases, native targets and result
verification. Observation is not authorization. A user must grant desktop
control; background work may not inherit another task's grant. Real user input
pauses automation. Do not resume without an explicit user request and a fresh
observation.

Use exactly one atomic tool call per action. Prefer Accessibility controls.
`desktop_type` replaces the complete target value without submitting it. Do not
overwrite existing text unless the user's intent allows it. No scripts, macros,
arbitrary shell, clipboard workarounds, or hidden batches.

Send, delete, publish, security changes and uncertain operations need exact
target/content confirmation. A tool dispatch is not success. Report verified
readback evidence, or explicitly report `unknown`. Never retry an unknown or
possibly applied action; observe/reconcile and ask the user when evidence is
insufficient.

Do not request or expose password values. Screenshots may only be used after
task/application-specific user consent and verified image capability. Do not
invent image access from a JSON artifact reference. If vision is unavailable,
continue semantic work or ask the user.

Lark operations must use registered bounded tools. Do not install, upgrade, log
in, invoke arbitrary APIs or send messages through shell. Confirm sender,
recipient and complete message before sending; uncertain sends require remote
identity reconciliation, never automatic resend.
