---
name: collaboration
description: Complex projects that delegate work to local Coding Agents with user-led planning, delegation, review, integration, and verification.
---

# User-led Collaboration

Start by observing the existing plan. Do not assemble a team for simple requests.
For complex requests, choose roles and Providers based on the goal. Do not require
Claude to plan or Codex to review, and do not create a second Agent Loop.

The submitted plan must state the goal, scope, acceptance criteria, dependencies,
deliverables, repository, and authorized actions. The initial version is 1.
Changes to the goal, scope, acceptance criteria, or authorization must increment
both `version` and `intentVersion`. Reassignment within the approved scope uses
`workflow_refine_plan`, increments only `version`, and preserves the original
boundary. Stop or reconcile unfinished attempts first. Do not rewrite delivered
work items; create new rework items that reference them. Approval must be made by
the user in the client. Never infer approval from the user merely stating a request.
Before approval, only read-only investigation, planning, and plan review are allowed.
Do not use the foreground Pi's native file or shell tools to bypass approval and
modify the target repository.

Before implementation, verify the current Host approval and then dispatch work.
Dependencies must reference explicit deliverable revisions. Isolate parallel writes
in independent worktrees. If the source directory is dirty, ask the user to handle
it or explicitly select a committed baseline. Local deliverable commits must be
covered by the authorized actions. Never push or modify the user's current branch.

Observe actual events, diffs, tests, and review evidence. Do not treat a zero exit
code, silence, or a natural-language "done" as acceptance. Ask the user to decide
when the same issue remains unresolved after three rework rounds. The user's latest
request takes priority. Pause and resubmit the plan when the scope materially changes.
Switching Sessions or stopping speech does not cancel a background workflow. When
the user changes the goal, call `workflow_stop` to close the old operation gate before
submitting a new plan. Resuming a paused workflow only reopens the plan gate; use
`workflow_resume_run` to create a new attempt. An `unknown` result requires user
reconciliation before stopping or retrying. Handle dirty worktrees first; never
continue them as if they were a clean baseline.

After delivery, dispatch an independent integration work item whose dependencies
include the deliverables to integrate. After serial integration, use
`workflow_test` to save the actual test output. Then dispatch a review work item
that depends on the integration result, and bind the review to its specific
revision. Use `workflow_record_finding` to record findings, resolutions, and rework
rounds. Use `workflow_record_integration` to save tests and reviews. Without
evidence, the result may only be marked `unverified`. Do not fabricate Artifacts
with a natural-language "tests passed" claim. Present the integration branch rather
than directly applying changes to the user's branch.

Background coordination uses an independent persistent Pi session. Start a new turn
only when the Host provides a new event. When child tasks are executing, end the
current turn and wait for events; do not repeatedly observe or poll the model.
Normal foreground conversations must not interrupt the background workflow.
Use `workflow_find` to search across Sessions. Ask the user when multiple tasks
match, and report the current stage, agents, deliverables, and blockers without
inventing percentages. Background coordination must not invoke speech.

When an implementation clarification arrives in `background.requests`, answer it
with `workflow_decide_request`. Answer keys must exactly match the question text.
Decide only implementation details within the approved plan. New goals, user
preferences, or additional permissions require `needs_user`. Approval of a child
plan must not expand the authorization of the overall plan.
Claude's plan-exit protocol has not been verified against the real CLI. Treat its
planning output as an Artifact or delivery summary, have the main Pi review it, and
dispatch an explicit implementation work item instead of simulating keyboard input
that says "approve".

Produce a short spoken summary and Markdown details when necessary. Do not expose
internal reasoning.
