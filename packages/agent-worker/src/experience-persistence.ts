import type { EventPayloads } from "@semi-os/protocol";
import type { ToolExecutionReceipt } from "@semi-os/tool-sdk";

type SubmitPayload = EventPayloads["memory.candidate.submit"];

/**
 * 已验证经验的后台候选。
 *
 * 这里只消费结构化回执、任务完成状态和任务摘要，不用模型判断成败。
 * 可执行经验是 L3 `verified_outcome` 和 L5 `workflow_candidate`；失败、
 * unknown 或未验证的步骤不能进入这两类。L5 只到工作流候选，不晋升 Skill。
 * 写入仍交给已有的 `memory.candidate.submit`，本模块不打开 SQLite。
 * 调用方必须先送出首句和本轮结果，再排队这里的 Promise，不能 await 它。
 */

export const VERIFIED_EXPERIENCE_ORIGIN = "verified_experience";
export const EXPERIENCE_USER_ID = "local";

const SECRET_PATTERN =
  /api[_ -]?key|password|passwd|private[_ ]key|secret[_ ]key|client[_ ]secret|begin private key|authorization:|bearer |set-cookie|cookie:|密码|密钥|口令|秘钥|\bsk-[a-z0-9]{8,}|\bghp_|\bgithub_pat_|\bxox[bp]-|\bakia/i;

const NOISE_TEXT = new Set([
  "嗯",
  "嗯嗯",
  "哦",
  "啊",
  "ok",
  "okay",
  "好",
  "好的",
  "谢谢",
  "thanks",
  "hi",
  "hello",
  "hey",
  "你好",
  "哈哈",
  "收到",
  "yes",
  "no",
]);

export type ExperienceScope = {
  userId?: string;
  workspaceId?: string;
  applicationId?: string;
  skillId?: string;
};

export type ExperienceToolObservation = {
  attemptId: string;
  taskId: string;
  toolName: string;
  status: ToolExecutionReceipt["status"];
  resultType?: ToolExecutionReceipt["resultType"];
  verificationStatus?: "passed" | "failed" | "inconclusive" | "not_run";
  verificationMethod?: string;
  evidenceCount?: number;
  outputSummary?: string;
};

export type ExperienceCompletionStatus = "completed" | "failed" | "unknown" | "cancelled";

export type ExperienceObservation = {
  scope: ExperienceScope;
  tools: readonly ExperienceToolObservation[];
  completion?: {
    taskId: string;
    status: ExperienceCompletionStatus;
  };
  summary?: {
    taskId: string;
    summary: string;
  };
};

export type ExperienceWriter = (candidate: SubmitPayload, signal: AbortSignal) => Promise<unknown>;

/** 单条写入失败。调用方可以继续后续候选，失败原因不进入语音。 */
export type ExperienceWriteFailure = {
  memoryId: string;
  reason: string;
};

/** 工具回执里只有结构化状态能决定能不能变成经验，输出文本只作摘要。 */
export function toolObservationFromReceipt(
  receipt: ToolExecutionReceipt,
): ExperienceToolObservation {
  return {
    attemptId: receipt.attemptId,
    taskId: receipt.taskId,
    toolName: receipt.toolName,
    status: receipt.status,
    resultType: receipt.resultType,
    verificationStatus: receipt.verification?.status,
    verificationMethod: receipt.verification?.method,
    evidenceCount: receipt.verification?.evidence.length ?? 0,
    outputSummary: receipt.outputSummary,
  };
}

export function experienceScopeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 128) return undefined;
  if ([...trimmed].some((character) => character <= " " || character.charCodeAt(0) < 32)) {
    return undefined;
  }
  return trimmed;
}

/** 整段都成功且每一步都有独立验证时，才是可复用的完成。 */
export function experienceCompletionStatus(
  tools: readonly ExperienceToolObservation[],
): ExperienceCompletionStatus {
  if (tools.length === 0) return "cancelled";
  if (tools.some(isUnknownOperation)) return "unknown";
  if (tools.every(isVerifiedTool)) return "completed";
  return "failed";
}

/**
 * 把一轮结构化观察收成候选。没有工作区就不写，避免变成所有仓库都能看见的全局经验。
 * 失败和 unknown 步骤不会出现在任何候选正文里。
 */
export function planVerifiedExperience(observation: ExperienceObservation): SubmitPayload[] {
  const workspaceId = experienceScopeId(observation.scope.workspaceId);
  const userId = experienceScopeId(observation.scope.userId) ?? EXPERIENCE_USER_ID;
  if (!workspaceId) return [];
  const scope: SubmitPayload["scope"] = {
    userId,
    workspaceId,
    ...(experienceScopeId(observation.scope.applicationId)
      ? { applicationId: experienceScopeId(observation.scope.applicationId) }
      : {}),
    ...(experienceScopeId(observation.scope.skillId)
      ? { skillId: experienceScopeId(observation.scope.skillId) }
      : {}),
  };
  const completion = observation.completion;
  const summary = observation.summary;
  const taskId = completion?.taskId ?? summary?.taskId;
  if (!taskId || !experienceScopeId(taskId)) return [];
  const tools = observation.tools.filter((tool) => tool.taskId === taskId);
  const verified = tools.filter(isVerifiedTool);
  const candidates: SubmitPayload[] = [];
  verified.forEach((tool, index) => {
    const outcome = verifiedOutcomeCandidate(taskId, tool, index, scope);
    if (outcome) candidates.push(outcome);
  });
  const reusable =
    completion?.status === "completed" &&
    completion.taskId === taskId &&
    summary?.taskId === taskId &&
    tools.length > 0 &&
    verified.length === tools.length &&
    !tools.some((tool) => isUnknownOperation(tool) || isFailedOperation(tool));
  if (reusable && summary) {
    const flow = workflowCandidate(taskId, verified, summary.summary, scope);
    const episode = taskSummaryCandidate(taskId, summary.summary, verified, scope);
    if (episode) candidates.push(episode);
    if (flow) candidates.push(flow);
  }
  return candidates;
}

/**
 * 推迟到当前调用栈结束再提交。返回的 Promise 给退出和测试收口，
 * 业务路径不能等它，否则首句和本轮结果会被记忆写入拖住。
 */
export function persistVerifiedExperience(
  observation: ExperienceObservation,
  write: ExperienceWriter,
  signal: AbortSignal,
): Promise<ExperienceWriteFailure[]> {
  const candidates = planVerifiedExperience(observation);
  if (candidates.length === 0 || signal.aborted) return Promise.resolve([]);
  return new Promise((resolve) => {
    queueMicrotask(() => {
      void writeCandidates(candidates, write, signal).then(resolve, () => resolve([]));
    });
  });
}

/**
 * 逐条提交。一条失败只记录这一条，后面的候选继续写。
 * 以前这里直接 return，会把同批尚未提交的经验整批丢掉。
 */
async function writeCandidates(
  candidates: readonly SubmitPayload[],
  write: ExperienceWriter,
  signal: AbortSignal,
): Promise<ExperienceWriteFailure[]> {
  const failures: ExperienceWriteFailure[] = [];
  for (const candidate of candidates) {
    if (signal.aborted) return failures;
    try {
      await write(candidate, signal);
    } catch (error) {
      failures.push({
        memoryId: candidate.memoryId,
        reason: failureReason(error),
      });
    }
  }
  return failures;
}

function failureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : "write_failed";
  const clean = text.replace(/[\u0000-\u001f]/g, " ").trim();
  const clipped = [...clean].slice(0, 180).join("");
  return clipped || "write_failed";
}

function verifiedOutcomeCandidate(
  taskId: string,
  tool: ExperienceToolObservation,
  index: number,
  scope: SubmitPayload["scope"],
): SubmitPayload | null {
  const attemptId = experienceScopeId(tool.attemptId);
  const toolName = publicLabel(tool.toolName);
  if (!attemptId || !toolName || !tool.verificationMethod) return null;
  const detail = publicText(tool.outputSummary, "已验证完成");
  const summary = `${toolName} 已验证：${detail}`;
  if (containsSecret(summary)) return null;
  const memoryId = experienceId(taskId, `l3_out_${index}`);
  return candidate(
    memoryId,
    "verified_outcome",
    "L3",
    { kind: "verified_outcome", summary },
    scope,
    [source(memoryId, "receipt", attemptId, verifiedNote(toolName, tool.verificationMethod))],
  );
}

function taskSummaryCandidate(
  taskId: string,
  summaryText: string,
  tools: readonly ExperienceToolObservation[],
  scope: SubmitPayload["scope"],
): SubmitPayload | null {
  const summary = publicText(summaryText, "");
  if (!summary || isNoise(summary) || containsSecret(summaryText) || containsSecret(summary)) {
    return null;
  }
  const memoryId = experienceId(taskId, "l3_summary");
  return candidate(
    memoryId,
    "task_summary",
    "L3",
    { kind: "task_summary", summary },
    scope,
    proofSources(memoryId, taskId, tools, true),
  );
}

function workflowCandidate(
  taskId: string,
  tools: readonly ExperienceToolObservation[],
  summaryText: string,
  scope: SubmitPayload["scope"],
): SubmitPayload | null {
  const names = tools
    .map((tool) => publicLabel(tool.toolName))
    .filter((name): name is string => !!name);
  if (names.length !== tools.length || names.some((name) => containsSecret(name))) return null;
  const conclusion = publicText(summaryText, names.join("，"));
  if (!conclusion || containsSecret(summaryText)) return null;
  const steps = tools
    .map((tool) => {
      const name = publicLabel(tool.toolName);
      return name ? `${name}：${publicText(tool.outputSummary, "已验证完成")}` : "";
    })
    .filter(Boolean)
    .join("；");
  const name = names.join("+").slice(0, 180);
  const summary = `已验证步骤：${steps}。结论：${conclusion}`.slice(0, 1500);
  if (containsSecret(name) || containsSecret(summary)) return null;
  const memoryId = experienceId(taskId, "l5_flow");
  return candidate(
    memoryId,
    "workflow_candidate",
    "L5",
    { kind: "workflow_candidate", name, summary },
    scope,
    proofSources(memoryId, taskId, tools, true),
  );
}

function proofSources(
  memoryId: string,
  taskId: string,
  tools: readonly ExperienceToolObservation[],
  includeCompletion: boolean,
): SubmitPayload["sourceRefs"] {
  const refs: SubmitPayload["sourceRefs"] = [];
  if (includeCompletion) {
    refs.push(source(memoryId, "task_event", `task.completed:${taskId}`, "completion=completed"));
  }
  for (const tool of tools) {
    const attemptId = experienceScopeId(tool.attemptId);
    const toolName = publicLabel(tool.toolName);
    if (!attemptId || !toolName || !tool.verificationMethod) continue;
    refs.push(
      source(
        `${memoryId}_${refs.length}`,
        "receipt",
        attemptId,
        verifiedNote(toolName, tool.verificationMethod),
      ),
    );
  }
  return refs;
}

function candidate(
  memoryId: string,
  recordKind: "task_summary" | "verified_outcome" | "workflow_candidate",
  layer: "L3" | "L5",
  content: SubmitPayload["content"],
  scope: SubmitPayload["scope"],
  sourceRefs: SubmitPayload["sourceRefs"],
): SubmitPayload | null {
  if (sourceRefs.length === 0) return null;
  return {
    memoryId,
    recordKind,
    layer,
    content,
    scope,
    confidence: 85,
    importance: 64,
    sourceRefs,
    conflictTarget: null,
    origin: VERIFIED_EXPERIENCE_ORIGIN,
  };
}

function source(
  memoryId: string,
  kind: "receipt" | "task_event",
  sourceRef: string,
  note: string,
): SubmitPayload["sourceRefs"][number] {
  return {
    sourceId: `src_${memoryId}`.slice(0, 128),
    kind,
    sourceRef,
    note,
  };
}

function verifiedNote(toolName: string, method: string): string {
  return `status=succeeded; verification=passed; method=${method.trim()}; tool=${toolName}`;
}

function isVerifiedTool(tool: ExperienceToolObservation): boolean {
  return (
    tool.status === "succeeded" &&
    tool.resultType === "success" &&
    tool.verificationStatus === "passed" &&
    !!experienceScopeId(tool.attemptId) &&
    !!publicLabel(tool.toolName) &&
    methodAllowed(tool.verificationMethod) &&
    (tool.evidenceCount ?? 0) > 0 &&
    !isUnknownOperation(tool) &&
    !isFailedOperation(tool)
  );
}

function isUnknownOperation(tool: ExperienceToolObservation): boolean {
  return (
    tool.status === "unknown" ||
    tool.resultType === "unknown" ||
    tool.verificationStatus === "inconclusive"
  );
}

function isFailedOperation(tool: ExperienceToolObservation): boolean {
  return (
    tool.status === "failed" ||
    tool.status === "cancelled" ||
    tool.status === "needs_user" ||
    tool.resultType === "failure" ||
    tool.resultType === "cancelled" ||
    tool.resultType === "needs_user" ||
    tool.verificationStatus === "failed"
  );
}

function methodAllowed(method: string | undefined): boolean {
  const normalized = method?.trim().toLowerCase() ?? "";
  return normalized.length > 0 && normalized !== "none" && normalized !== "model_prose";
}

function experienceId(taskId: string, suffix: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "task";
  return `exp_${safe}_${suffix}`.slice(0, 128);
}

function publicLabel(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (!text || containsSecret(text) || [...text].length > 180) return undefined;
  return text;
}

function publicText(value: string | undefined, fallback: string): string {
  const text = value?.trim() ?? "";
  if (!text || containsSecret(text) || isNoise(text)) return fallback;
  return [...text].slice(0, 500).join("");
}

function containsSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

function isNoise(value: string): boolean {
  const key = value.toLowerCase().replace(/[\s.,!?，。！？、；：~～]/gu, "");
  return key.length === 0 || NOISE_TEXT.has(key);
}
