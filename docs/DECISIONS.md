# Semi-OS Decision Log

This file records confirmed product decisions separately from proposals.

## Confirmed

| Area | Decision |
| --- | --- |
| Product | Voice-controlled computer assistant, not a chat client with voice added |
| MVP scenarios | Multi-site research and voice briefing; coding-agent delegation; generic application/Lark CLI operations |
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
| Memory | MVP uses a separate six-layer memory subsystem; normal low-risk memories are written automatically without user confirmation |
| Memory compaction | MVP uses simple threshold-based Pi session compaction; compaction summary is working context, not long-term memory |
| Progressive memory loading | Load a compact base pack first, then retrieve deeper memory and evidence on demand |
| Agent personality | Personality is a versioned runtime context layer for identity, tone, behavior and voice; it is separate from user facts and memory evidence |
| Permissions | First-run macOS permission center; missing permission degrades capabilities |
| Client UI | Conversation, tasks, memory, skills and settings; simplified user-facing timeline |
| Task complexity | Do not pre-classify turns with a separate complexity classifier; execution-tool use creates or continues a visible TaskRun, while memory recall alone does not |
| User interruption | Let the Agent decide whether an interruption steers, pauses/cancels or starts a new task; preserve the same session and task evidence |
| Research workflow | MVP supports multi-site collection, synthesis, source recording and voice briefing |
| Application workflow | MVP supports generic app launch/focus and bounded desktop operations; Lark CLI is supported where an operation has a stable command path |
| WeChat | Defer WeChat-specific automation; it is not an MVP acceptance blocker |
| MVP implementation strategy | Research, Coding Agent delegation and generic application operation may be implemented in parallel; they share the same voice, Pi, TaskRun, tool and evidence foundations |
| Coding Agent transport | Use a common PTY-like local terminal adapter first; provider-specific differences are isolated to launch, output parsing, steering, resume and result collection |
| Initial providers | STT, TTS and LLM use cloud providers in the first release, behind replaceable provider interfaces |
| Progress UI | Show a simple event-driven task timeline with current step, recent action, waiting reason and result |
| Assistant visuals | Use expressive mouse-following, particle and speech-wave effects; animation is presentation-only and does not define task semantics |
| Personality and preferences | User may manually edit personality and user preferences; the Agent may append or revise only Agent-created memories and cannot mutate user-authored entries |

## Explicitly deferred

- Wake-word and automatic end-of-speech detection.
- Windows and Linux native automation.
- Third-party plugin/skill marketplace.
- MCP server ecosystem.
- Remote execution and multi-device control.
- Full visual-computer-use as the primary locator.
- Dream cycles, graph memory, complex decay and automatic Skill promotion.
- Exact memory token budgets, compaction thresholds and embedding implementation.
- WeChat-specific adapter and message workflow.

## Architecture invariants

1. Model text never proves that a task succeeded.
2. Every side effect is represented by an auditable tool receipt.
3. An approval is bound to the exact target, action and payload digest.
4. An uncertain external outcome is never retried blindly.
5. Rust is the authority for privileged OS actions and durable local state.
6. The Pi integration is replaceable through `AgentRuntimeAdapter`.
7. The UI consumes domain events; it does not parse model prose into task state.
8. Memory writes are automatic for normal low-risk content, but deterministic
   secret/privacy/identity filters still apply.
9. Compaction preserves active-task continuity; it does not silently promote
   summaries into durable memory.
10. Personality, user facts, task history and execution evidence remain separate
    data and prompt layers.
