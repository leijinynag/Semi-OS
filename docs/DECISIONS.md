# Semi-OS Decision Log

This file records confirmed product decisions separately from proposals.

## Confirmed

| Area | Decision |
| --- | --- |
| Product | Voice-controlled computer assistant, not a chat client with voice added |
| MVP scenarios | General browser/desktop automation and coding-agent delegation |
| Desktop shell | Tauri + React + TypeScript |
| Native host | Rust owns windows, permissions, shortcuts, OS automation, secrets and SQLite |
| Agent process | A supervised Node.js worker embeds Pi through an adapter |
| Agent loop | All meaningful tasks pass through Pi; no separate “simple-task agent” |
| Runtime extension | Prefer Pi SDK/extensions; MCP is a later interoperability layer |
| Tools | Dynamically expose only tools currently allowed and available |
| Browser | Playwright first, with a dedicated persistent profile |
| Native automation | macOS first; semantic accessibility lookup, screenshot/vision fallback |
| Action granularity | Fresh observation, one atomic action, structured verification |
| Voice trigger | Push-to-talk in MVP; reserve an automatic wake/VAD branch |
| Voice response | Acknowledge first, then speak after the first complete sentence |
| Speech providers | Cloud-first behind STT/TTS provider interfaces; local providers can replace them |
| Interruption | Pause/abort current work and inject steering into the continued Pi session |
| Floating UI | Visible only while hotkey is held, task is running, or confirmation is required |
| Confirmation UI | Voice announcement plus floating-window controls; controls can be disabled |
| Risk policy | `read` and `local_write` auto-run by default; `external_side_effect` confirms |
| Policy settings | Low/high risk defaults are configurable, but high-risk tools default to confirmation |
| Network failure | Limited retry before side effects; uncertain side effects become `unknown` |
| Skills | Candidate matching plus final Agent judgment; built-in only in MVP |
| Skill contents | Skills may include scripts and multi-step workflows |
| Plugins | Extension entry is reserved; MVP loads built-in trusted plugins only |
| Memory | First release needs useful long-term memory, designed as a separate subsystem |
| Permissions | First-run macOS permission center; missing permission degrades capabilities |
| Client UI | Conversation, tasks, memory, skills and settings; simplified user-facing timeline |

## Explicitly deferred

- Wake-word and automatic end-of-speech detection.
- Windows and Linux native automation.
- Third-party plugin/skill marketplace.
- MCP server ecosystem.
- Remote execution and multi-device control.
- Full visual-computer-use as the primary locator.
- Detailed memory ranking algorithm and user-facing memory editing UX.

## Architecture invariants

1. Model text never proves that a task succeeded.
2. Every side effect is represented by an auditable tool receipt.
3. An approval is bound to the exact target, action and payload digest.
4. An uncertain external outcome is never retried blindly.
5. Rust is the authority for privileged OS actions and durable local state.
6. The Pi integration is replaceable through `AgentRuntimeAdapter`.
7. The UI consumes domain events; it does not parse model prose into task state.
