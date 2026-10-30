// 自动生成；协议字段和消息方向只在 protocol.schema.json 中维护。
import type { EnvelopeContext, JsonValue } from "../envelope.ts";
import type { RequestId } from "@semi-os/shared";
export type RequestPayloads = {
"desktop.result": { "operationId": string; "result": { "status": "observed" | "verified" | "failure" | "needs_user" | "unknown"; "summary": string; "leaseGeneration": number; "observation"?: { "version": string; "observedAtMs": number; "bundleId": string; "processId": number; "windowId": string; "title": string; "elements": Array<{ "reference": string; "role": string; "label": string; "value"?: string; "valueTruncated": boolean; "focused": boolean; "enabled": boolean; "sensitive": boolean; "actions": Array<"press" | "set_value" | "focus" | "scroll">; "bounds"?: { "x": number; "y": number; "width": number; "height": number }; "depth": number }>; "truncated": boolean }; "evidence"?: string }; "permissions"?: { "accessibility": "granted" | "denied" | "not_determined" | "restricted" | "unavailable"; "screenRecording": "granted" | "denied" | "not_determined" | "restricted" | "unavailable"; "microphone": "granted" | "denied" | "not_determined" | "restricted" | "unavailable"; "inputMonitoring": "granted" | "denied" | "not_determined" | "restricted" | "unavailable"; "takeoverDetection": boolean; "visualFallback": { "status": "available" | "needs_user" | "unavailable"; "reason": string }; "checkedAtMs": number } };
"health.check": { "includeCapabilities"?: boolean } | null;
"voice.turn.start": { "sessionId": string; "taskId": string; "cwd": string; "mimeType": string; "sampleRateHz"?: number; "action"?: "prompt" | "steer" | "follow_up" };
"voice.audio.append": { "sequence": number; "audioBase64": string };
"voice.turn.commit": { "lastSequence": number };
"voice.text.submit": { "sessionId": string; "taskId": string; "cwd": string; "text": string; "action"?: "prompt" | "steer" | "follow_up" };
"voice.interrupt": { "taskId": string; "mode": "pause" | "cancel" | "steer"; "text"?: string };
"voice.session.dispose": { "sessionId": string };
"workflow.control": { "workflowId": string; "sessionId": string; "action": "approved" | "rejected" | "needs_revision" | "pause" | "resume" | "resume_coordinator" | "cancel" | "observe" | "reconcile_application" | "answer_decision"; "requestId"?: string };
"workflow.acknowledged": { "operationId": string; "ok": boolean; "value"?: JsonValue; "error"?: string | null };
"workflow.run.inspect": { "sessionId": string; "workflowId": string; "runId": string };
"workflow.run.reconcile": { "sessionId": string; "workflowId": string; "runId": string };
"workflow.run.steer": { "sessionId": string; "workflowId": string; "runId": string; "text": string };
"workflow.run.answer": { "sessionId": string; "workflowId": string; "runId": string; "text": string };
"workflow.application.prepare": { "sessionId": string; "workflowId": string; "applicationId"?: string | null };
"workflow.application.apply": { "sessionId": string; "workflowId": string; "applicationId": string };
"research.confirmation.required": { "taskId": string };
"research.persisted": { "operationId": string; "ok": boolean; "value"?: JsonValue; "error"?: string | null };
"browser.login.open": { "url"?: string };
"browser.session.resume": { "resumeId": string; "sessionId": string; "taskId": string; "mode": "takeover" | "claim" };
"browser.session.inspect": { [key: string]: JsonValue };
"fixture.request": { [key: string]: JsonValue };
};
export type RequestMessage = { [K in keyof RequestPayloads]: EnvelopeContext & {
protocolVersion: 1; requestId: RequestId; direction: "request"; kind: K; payload: RequestPayloads[K]
} }[keyof RequestPayloads];
export type ResponsePayloads = {
"desktop.acknowledged": { "operationId": string; "ok": boolean; "value"?: JsonValue; "error"?: string | null };
"health.ready": { "pid": number; "worker"?: string };
"voice.session.disposed": { "sessionId": string };
"voice.text.accepted": { "accepted": true };
"voice.turn.started": { "accepted": true };
"voice.audio.accepted": { "sequence": number };
"voice.turn.committed": { "accepted": true };
"voice.interrupt.accepted": { "mode": "pause" | "cancel" | "steer" };
"workflow.received": { "accepted": true };
"workflow.control.accepted": { "accepted": true };
"workflow.run.accepted": { "accepted": true };
"workflow.run.result": { "ok": true; "value": JsonValue } | { "ok": false; "error": string };
"research.confirmation.announced": { "accepted": true };
"research.acknowledged": { "accepted": true };
"browser.login.accepted": { "accepted": true };
"browser.session.resume.accepted": { "accepted": true };
"browser.session.snapshot": null | { "resumeId": string; "sessionId": string; "taskId": string; "status": "waiting_user" | "resuming" | "resumed" | "failed" | "cancelled"; "message": string };
"browser.login.opened": { "pageId": string; "url": string; "title": string; "version": number; "status": "ready" | "needs_user" | "failed"; "reason"?: string; "elements": Array<{ "ref": string; "role": string; "name": string }> };
"browser.login.failed": { "message": string };
};
export type ResponseMessage = { [K in keyof ResponsePayloads]: EnvelopeContext & {
protocolVersion: 1; requestId: RequestId; direction: "response"; kind: K; payload: ResponsePayloads[K]
} }[keyof ResponsePayloads];
export type EventPayloads = {
"browser.session.state": { "resumeId": string; "sessionId": string; "taskId": string; "status": "waiting_user" | "resuming" | "resumed" | "failed" | "cancelled"; "message": string };
"desktop.cancelled": { "operationId": string; "taskId": string };
"desktop.request": { "operationId": string; "taskId": string; "attemptId": string; "inputJson": string; "inputDigest": string; "approvalId"?: string; "action": { "kind": "observe" } | { "kind": "click" | "focus_window"; "version": string; "reference": string } | { "kind": "type"; "version": string; "reference": string; "text": string } | { "kind": "key"; "version": string; "reference": string; "key": "return" | "tab" | "escape" | "space" | "left" | "right" | "up" | "down" | "backspace" | "a" | "c" | "v" | "s" | "z"; "modifiers": Array<"command" | "shift" | "option" | "control"> } | { "kind": "scroll"; "version": string; "reference": string; "direction": "up" | "down" | "left" | "right"; "amount": number } | { "kind": "launch_app"; "bundleId": string } };
"fixture.echo": { [key: string]: JsonValue };
"voice.state": { "state": "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "interrupted" | "error" };
"voice.transcript.partial": { "text": string };
"voice.transcript.final": { "text": string };
"voice.assistant.text_delta": { "text": string; "source": "agent" };
"voice.answer": { "taskId": string; "summary": string; "report": string };
"voice.sentence": { "sentenceId": string; "text": string; "purpose": "answer" | "stage" | "confirmation" };
"voice.timestamps": { "sentenceId": string; "words": Array<{ "text": string; "startMs": number; "endMs": number }> };
"voice.audio.chunk": { "sentenceId": string; "sequence": number; "mimeType": "audio/mpeg" | "audio/pcm;rate=22050;channels=1;format=s16le"; "audioBase64": string; "first": boolean };
"voice.audio.completed": { "sentenceId": string };
"voice.audio.stop": { "reason": string };
"voice.turn.completed": { "taskId": string };
"voice.error": { "code": string; "message": string; "retryable": boolean; "details"?: JsonValue };
"research.progress": { "taskId": string; "label": string; "toolName": string; "callId": string };
"research.receipt": { "attemptId": string; "taskId": string; "toolName": string; "idempotencyKey": string; "attemptNumber": number; "status": "started" | "succeeded" | "failed" | "unknown" | "cancelled" | "needs_user"; "riskLevel": "read" | "local_write" | "external_side_effect" | "privileged"; "inputSummary": string; "inputDigest": string; "policyDecision": "auto" | "confirmation_required" | "approved" | "rejected"; "startedAtMs": number; "finishedAtMs"?: number; "durationMs"?: number; "resultType"?: "success" | "failure" | "unknown" | "cancelled" | "needs_user"; "outputSummary"?: string; "verification"?: { [key: string]: JsonValue }; "artifacts": Array<{ [key: string]: JsonValue }> };
"research.report": { "taskId": string; "summary": string; "claims": Array<{ "text": string; "citations": Array<{ "sourceId": string; "quoteId": string }> }>; "limitations": Array<string> };
"research.timing": { "stage"?: string; "durationMs": number };
"research.interrupted": { "taskId": string; "mode": "pause" | "cancel" | "steer" };
"research.persist": { "operationId": string; "operation": "source"; "value": { "sourceId": string; "taskId": string; "originalUrl": string; "finalUrl": string; "title": string; "collectedAtMs": number; "status": "collected" | "needs_user" | "failed"; "reason"?: string; "artifactId"?: string; "digest"?: string; "excerpt"?: string; "text"?: string; "quotes": Array<{ "quoteId": string; "start": number; "end": number; "text": string }> } } | { "operationId": string; "operation": "report"; "value": { "taskId": string; "summary": string; "claims": Array<{ "text": string; "citations": Array<{ "sourceId": string; "quoteId": string }> }>; "limitations": Array<string> } } | { "operationId": string; "operation": "policy"; "value": { "taskId": string; "toolName": string; "riskLevel": "read" | "local_write" | "external_side_effect" | "privileged"; "inputJson": string; "sessionId"?: string } };
"research.policy.cancelled": { "operationId": string };
"workflow.request": { "operationId": string; "operation": "submit" | "refine"; "value": { "workflowId": string; "sessionId": string; "version": number; "intentVersion": number; "title": string; "goal": string; "scope": Array<string>; "acceptance": Array<string>; "authorizedActions": Array<"read" | "workspace_write" | "local_commit" | "integrate">; "authorizedCapabilities"?: Array<"read:repo" | "read:files" | "read:evidence" | "write:workspace:isolated" | "run:test" | "git:commit:local" | "spawn:peer">; "executionBudget"?: { "maxParallelRuns": number; "maxReworkRounds": number; "maxNoProgressTurns": number }; "repository": string; "baselineCommit"?: string; "workItems": Array<{ "workItemId": string; "title": string; "objective": string; "role": "research" | "planning" | "review" | "implementation" | "integration" | "verification"; "provider": "pi" | "claude" | "codex"; "dependencies": Array<string>; "outputs": Array<string>; "acceptance": Array<string>; "capabilities"?: Array<"read:repo" | "read:files" | "read:evidence" | "write:workspace:isolated" | "run:test" | "git:commit:local" | "spawn:peer">; "isolation"?: "none" | "isolated_worktree"; "evidence"?: { "revision": boolean; "tests": boolean; "independentReview": boolean } }> } } | { "operationId": string; "operation": "list" | "notifications"; "value": { "sessionId": string } } | { "operationId": string; "operation": "authorize"; "value": { "workflowId": string; "version": number; "digest": string; "workItemId": string } } | { "operationId": string; "operation": "run"; "value": { "runId": string; "workflowId": string; "planVersion": number; "intentVersion": number; "workItemId": string; "attempt": number; "provider": "pi" | "claude" | "codex"; "status": "pending" | "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "unknown"; "startedAtMs": number; "endedAtMs"?: number; "workspace"?: string; "providerSessionId"?: string; "revision"?: string; "summary"?: string; "error"?: string; "branch"?: string; "baselineCommit"?: string; "permission"?: { "requestId": string; "tool": string; "description": string }; "capabilities"?: { "steer": boolean; "pause": boolean; "resume": boolean } } } | { "operationId": string; "operation": "event"; "value": { "workflowId": string; "kind": string; "summary": string } } | { "operationId": string; "operation": "finding"; "value": { "workflowId": string; "finding": { "findingId": string; "workItemId": string; "revision": string; "summary": string; "status": "open" | "resolved" | "needs_user"; "reworkRounds": number } } } | { "operationId": string; "operation": "integration"; "value": { "workflowId": string; "result": { "revision": string; "branch": string; "workspace": string; "commits": Array<string>; "status": "unverified" | "conflict" | "verified"; "tests": Array<{ "command": string; "exitCode": number; "revision": string; "artifactId": string }>; "reviews": Array<{ "runId": string; "revision": string; "findingIds": Array<string> }> } } } | { "operationId": string; "operation": "test"; "value": { "workflowId": string; "runId": string; "text": string; "evidence": { "command": string; "exitCode": number; "revision": string; "artifactId": string } } } | { "operationId": string; "operation": "consume"; "value": { "workflowId": string; "sequence": number } } | { "operationId": string; "operation": "application.begin"; "value": { "applicationId": string } } | { "operationId": string; "operation": "application.finish"; "value": { "applicationId": string; "applied": boolean } } | { "operationId": string; "operation": "coordinator.claim" | "coordinator.renew" | "coordinator.fail" | "coordinator.unavailable"; "value": { "workflowId": string; "owner": string } } | { "operationId": string; "operation": "coordinator.finish"; "value": { "workflowId": string; "owner": string; "sequence": number; "checkpoint": { "sessionId": string; "sequence": number; "data": { [key: string]: JsonValue } }; "progress": boolean } } | { "operationId": string; "operation": "suspend"; "value": { "workflowId": string } } | { "operationId": string; "operation": "find"; "value": { "name"?: string; "repository"?: string; "status"?: string } } | { "operationId": string; "operation": "run.phase"; "value": { "runId": string; "phase": "not_started" | "start_requested" | "executing" | "saved" } } | { "operationId": string; "operation": "run.phase.read"; "value": { "runId": string } } | { "operationId": string; "operation": "delegate.request"; "value": { "workflowId": string; "runId": string; "requestId": string; "kind": "clarification" | "plan"; "input": { "plan"?: string; "questions"?: Array<{ "question": string; "header"?: string; "multiSelect"?: boolean; "options"?: Array<{ "label": string; "description": string }> }> } } } | { "operationId": string; "operation": "delegate.decision"; "value": { "workflowId": string; "runId": string; "requestId": string; "kind": "clarification" | "plan"; "decision": { "authority"?: "implementation_detail" | "needs_user"; "reason"?: string; "approved"?: boolean; "answers"?: { [key: string]: string } } } } | { "operationId": string; "operation": "delegate.result"; "value": { "workflowId": string; "requestId": string } } | { "operationId": string; "operation": "operation.authorize"; "value": { "workflowId": string; "runId": string; "tool": string; "input": { [key: string]: JsonValue } } };
"browser.navigation": { "stage"?: string; "durationMs": number };
"browser.extraction": { "stage"?: string; "durationMs": number };
"browser.startup": { "stage"?: string; "durationMs": number };
"browser.playwright": { "stage"?: string; "durationMs": number };
"worker.progress": { "sequence": number };
"worker.state_changed": { "from": "starting" | "ready" | "degraded" | "restarting" | "stopped"; "to": "starting" | "ready" | "degraded" | "restarting" | "stopped"; "reason": string };
"session.ready": { "stage"?: string; "durationMs": number };
"session.started": { "sessionId": string };
"client.device_ready": { "stage"?: string; "durationMs": number };
"client.press_to_first_sample": { "stage"?: string; "durationMs": number };
"client.press_to_first_send": { "stage"?: string; "durationMs": number };
"client.release_to_final_transcript": { "stage"?: string; "durationMs": number };
"client.release_to_first_answer_playback": { "stage"?: string; "durationMs": number };
"client.release_to_first_segment": { "stage"?: string; "durationMs": number };
"client.release_to_first_text_ready": { "stage"?: string; "durationMs": number };
"client.release_to_tts_ready": { "stage"?: string; "durationMs": number };
"runtime.error": { "message": string };
"protocol.error": { "code": string; "message": string; "retryable": boolean; "details"?: JsonValue };
"request.error": { "code": string; "message": string; "retryable": boolean; "details"?: JsonValue };
};
export type EventMessage = { [K in keyof EventPayloads]: EnvelopeContext & {
protocolVersion: 1; requestId: RequestId; direction: "event"; kind: K; payload: EventPayloads[K]
} }[keyof EventPayloads];
export type ErrorPayloads = {
"protocol.error": { "code": string; "message": string; "retryable": boolean; "details"?: JsonValue };
"request.error": { "code": string; "message": string; "retryable": boolean; "details"?: JsonValue };
};
export type ErrorMessage = { [K in keyof ErrorPayloads]: EnvelopeContext & {
protocolVersion: 1; requestId: RequestId; direction: "error"; kind: K; payload: ErrorPayloads[K]
} }[keyof ErrorPayloads];
export type ValidatedMessage = RequestMessage | ResponseMessage | EventMessage | ErrorMessage;
