import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  parseWorkflowSnapshot,
  parseWorkflowApplication,
  type WorkflowApplication,
  type WorkStatus,
  type WorkflowSnapshot,
} from "@semi-os/protocol";
import { mergeWorkflowSnapshots } from "./workflow-model.ts";

type DecisionRequest = NonNullable<WorkflowSnapshot["background"]>["requests"][number];

/** 只回答 Host 保存的原问题，表单不能批准新增工具权限。 */
function WorkflowQuestion({
  workflowId,
  request,
}: {
  workflowId: string;
  request: DecisionRequest;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const questions = request.input.questions;
  const texts = Array.isArray(questions)
    ? questions.flatMap((q) =>
        q && typeof q === "object" && !Array.isArray(q) && typeof q.question === "string"
          ? [q.question]
          : [],
      )
    : [];
  async function send(approved?: boolean) {
    setBusy(true);
    setError("");
    try {
      await invoke("answer_workflow_question", {
        request: {
          workflowId,
          requestId: request.requestId,
          answer: request.kind === "clarification" ? { answers } : { approved },
        },
      });
    } catch {
      setError("答复未确认，请核对任务状态");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="mt-2" open={request.status === "needs_user"}>
      <summary>
        {request.kind === "plan" ? "子计划决策" : "实现澄清"} ·{" "}
        {request.status === "needs_user" ? "待你回答" : "待主 Pi 判断"}
      </summary>
      {request.kind === "clarification" ? (
        <form
          className="space-y-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {texts.map((text) => (
            <label key={text} className="block text-sm">
              {text}
              {request.status === "needs_user" && (
                <textarea
                  aria-label={text}
                  rows={2}
                  maxLength={4000}
                  className="mt-2 w-full rounded-md border border-neutral-200 p-2"
                  value={answers[text] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [text]: event.target.value }))
                  }
                />
              )}
            </label>
          ))}
          {request.status === "needs_user" && (
            <button
              className="client-dark-button"
              disabled={busy || !texts.length || texts.some((text) => !answers[text]?.trim())}
            >
              发送答复
            </button>
          )}
        </form>
      ) : (
        <div className="py-3">
          {typeof request.input.plan === "string" && (
            <p className="whitespace-pre-wrap text-sm">{request.input.plan}</p>
          )}
          {request.status === "needs_user" && (
            <div className="mt-2 flex gap-2">
              <button
                className="client-dark-button"
                disabled={busy}
                onClick={() => void send(true)}
              >
                批准范围内子计划
              </button>
              <button
                className="client-subtle-button"
                disabled={busy}
                onClick={() => void send(false)}
              >
                拒绝
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

const statusLabels: Record<WorkflowSnapshot["status"], string> = {
  awaiting_approval: "待批准",
  approved: "已批准",
  rejected: "已拒绝",
  needs_revision: "待修改",
  paused: "已暂停",
  cancelled: "已取消",
  unknown: "待核对",
};
const runLabels: Record<WorkStatus, string> = {
  pending: "未派发",
  queued: "排队",
  running: "执行中",
  blocked: "待处理",
  completed: "已交付",
  failed: "失败",
  cancelled: "已停止",
  unknown: "待核对",
};

/** 独立订阅所属 Session；先监听后取快照，异步旧快照不能覆盖新批准。 */
export function useWorkflows(sessionId: string) {
  const [workflows, setWorkflows] = useState<WorkflowSnapshot[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setWorkflows([]);
    setError("");
    const subscription = listen<WorkflowSnapshot>("host://workflow", ({ payload }) => {
      if (!active) return;
      try {
        const snapshot = parseWorkflowSnapshot(payload);
        if (snapshot.plan.sessionId !== sessionId) return;
        setWorkflows((items) => mergeWorkflowSnapshots(items, [snapshot]));
      } catch {
        setError("工作流数据无效");
      }
    });
    void subscription
      .then(() => (sessionId ? invoke<WorkflowSnapshot[]>("get_workflows", { sessionId }) : []))
      .then((items) => {
        if (active)
          setWorkflows((current) =>
            mergeWorkflowSnapshots(current, items.map(parseWorkflowSnapshot)),
          );
      })
      .catch(() => {
        if (active && "__TAURI_INTERNALS__" in window) setError("工作流读取失败");
      });
    return () => {
      active = false;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [sessionId]);
  return { workflows, error };
}

export function WorkflowPanel({ workflow }: { workflow: WorkflowSnapshot }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revisionReason, setRevisionReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [runEvidence, setRunEvidence] = useState("");
  const [instructionRun, setInstructionRun] = useState("");
  const [instruction, setInstruction] = useState("");
  const [application, setApplication] = useState<WorkflowApplication>();
  const pendingRequest = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRequest.current?.();
    };
  }, []);
  const { plan } = workflow;
  async function decide(decision: "approved" | "rejected" | "needs_revision") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("decide_workflow", {
        request: {
          workflowId: plan.workflowId,
          version: plan.version,
          digest: workflow.digest,
          decision,
          reason: decision === "needs_revision" ? revisionReason.trim() : undefined,
        },
      });
    } catch (cause) {
      if (mounted.current) setError(typeof cause === "string" ? cause : "批准失败，请重新核对计划");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function control(
    action: "pause" | "resume" | "cancel" | "reconcile_application" | "resume_coordinator",
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("control_workflow", {
        request: {
          workflowId: plan.workflowId,
          version: plan.version,
          digest: workflow.digest,
          action,
        },
      });
    } catch (cause) {
      if (mounted.current) setError(typeof cause === "string" ? cause : "操作失败，请重新核对状态");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function inspectRun(
    runId: string,
    action: "inspect" | "reconcile" | "steer" | "answer" | "prepare" | "apply",
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    const requestId = `req_workflow_ui_${crypto.randomUUID().replaceAll("-", "")}`;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cleanup = () => {
      finished = true;
      if (timer) clearTimeout(timer);
      stop?.();
    };
    try {
      const result = new Promise<{
        ok: boolean;
        value?: { revision?: string; clean?: boolean; diff?: string };
        error?: string;
      }>((resolve, reject) => {
        pendingRequest.current = () => {
          cleanup();
          reject(new Error("界面已关闭"));
        };
        timer = setTimeout(() => reject(new Error("核对超时，工作区仍保留")), 20_000);
        void listen<{
          requestId: string;
          kind: string;
          payload: {
            ok: boolean;
            value?: { revision?: string; clean?: boolean; diff?: string };
            error?: string;
          };
        }>("host://worker-message", ({ payload }) => {
          if (payload.requestId === requestId && payload.kind === "workflow.run.result")
            resolve(payload.payload);
        })
          .then((unlisten) => {
            if (finished) {
              unlisten();
              return;
            }
            stop = unlisten;
            if (action === "prepare" || action === "apply")
              return invoke("apply_workflow_result", {
                workflowId: plan.workflowId,
                requestId,
                application: action === "apply" ? application : undefined,
              });
            return invoke("inspect_workflow_run", {
              workflowId: plan.workflowId,
              runId,
              requestId,
              action,
              text: ["steer", "answer"].includes(action) ? instruction.trim() : undefined,
            });
          })
          .catch(reject);
      });
      const response = await result;
      if (!mounted.current) return;
      if (!response.ok) throw new Error(response.error);
      if (action === "prepare") setApplication(parseWorkflowApplication(response.value));
      else if (action === "apply") {
        setApplication(undefined);
        setRunEvidence(`已应用到用户确认的源分支 · ${response.value?.revision ?? ""}`);
      } else if (action === "inspect")
        setRunEvidence(
          `${response.value?.clean ? "工作区干净" : "存在未提交或待处理改动"}\n${response.value?.revision ?? ""}\n${response.value?.diff || "无文件差异"}`,
        );
      else if (action === "reconcile") setRunEvidence("此尝试已停止，原工作区和会话保留。");
      else {
        setInstructionRun("");
        setInstruction("");
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "核对失败");
    } finally {
      cleanup();
      pendingRequest.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="workflow-panel">
      <header className="flex items-center justify-between gap-3">
        <strong>{plan.title}</strong>
        <span className="text-xs text-neutral-500">
          {statusLabels[workflow.status]} · v{plan.version}
        </span>
      </header>
      <p className="mt-3 text-sm">{plan.goal}</p>
      {workflow.background && (
        <div className="py-2 text-xs text-neutral-500">
          <p>
            {
              {
                idle: "等待事件",
                coordinating: "后台协调中",
                running: "后台托管",
                needs_user: "需要用户处理",
                completed: "交付已验证",
              }[workflow.background.coordinator.executionStatus]
            }
            {workflow.background.coordinator.lastActivityAtMs > 0 &&
              ` · ${new Date(workflow.background.coordinator.lastActivityAtMs).toLocaleTimeString()}`}
          </p>
          {workflow.background.coordinator.reason && (
            <p role="status" className="mt-2 text-neutral-900">
              {workflow.background.coordinator.reason}
            </p>
          )}
          {workflow.background.requests.map((request) => (
            <WorkflowQuestion
              key={`${request.runId}:${request.requestId}`}
              workflowId={plan.workflowId}
              request={request}
            />
          ))}
          {workflow.status === "approved" &&
            workflow.background.coordinator.executionStatus === "needs_user" && (
              <button
                className="client-subtle-button mt-2"
                disabled={
                  busy ||
                  workflow.runs.some((run) => run.status === "unknown") ||
                  workflow.background.requests.some((request) => request.status === "needs_user")
                }
                onClick={() => void control("resume_coordinator")}
              >
                已核对，继续后台协调
              </button>
            )}
        </div>
      )}
      <details className="context-section" open={workflow.status === "awaiting_approval"}>
        <summary>计划</summary>
        <dl className="workflow-definition">
          <dt>范围</dt>
          <dd>{plan.scope.join("；")}</dd>
          <dt>验收</dt>
          <dd>{plan.acceptance.join("；")}</dd>
          <dt>仓库</dt>
          <dd className="break-all">{plan.repository}</dd>
          <dt>授权</dt>
          <dd>
            {plan.authorizedActions
              .map(
                (action) =>
                  ({
                    read: "读取",
                    workspace_write: "隔离工作区写入",
                    local_commit: "本地成果提交",
                    integrate: "整合分支",
                  })[action],
              )
              .join("、")}
          </dd>
        </dl>
      </details>
      {workflow.status === "awaiting_approval" && (
        <div className="flex flex-wrap gap-2 py-3">
          <button
            className="client-dark-button"
            disabled={busy}
            onClick={() => void decide("approved")}
          >
            批准计划
          </button>
          <button
            className="client-subtle-button"
            disabled={busy}
            onClick={() => setEditing((value) => !value)}
          >
            修改
          </button>
          <button
            className="client-subtle-button"
            disabled={busy}
            onClick={() => void decide("rejected")}
          >
            拒绝
          </button>
        </div>
      )}
      {editing && workflow.status === "awaiting_approval" && (
        <form
          className="py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void decide("needs_revision");
          }}
        >
          <textarea
            className="w-full rounded-md border border-neutral-200 p-2 text-sm"
            aria-label="计划修改要求"
            value={revisionReason}
            onChange={(event) => setRevisionReason(event.target.value)}
            maxLength={8000}
            rows={3}
          />
          <button className="client-dark-button mt-2" disabled={busy || !revisionReason.trim()}>
            提交修改要求
          </button>
        </form>
      )}
      {["approved", "paused"].includes(workflow.status) && (
        <div className="flex flex-wrap gap-2 py-3">
          <button
            className="client-subtle-button"
            disabled={busy}
            onClick={() => void control(workflow.status === "paused" ? "resume" : "pause")}
          >
            {workflow.status === "paused" ? "恢复" : "暂停"}
          </button>
          <button
            className="client-subtle-button"
            disabled={busy}
            onClick={() => void control("cancel")}
          >
            取消
          </button>
          <button
            className="client-subtle-button"
            disabled={busy}
            onClick={() => {
              setEditing((value) => !value);
              setRevisionReason("");
            }}
          >
            修改要求
          </button>
        </div>
      )}
      {editing && ["approved", "paused"].includes(workflow.status) && (
        <form
          className="py-2"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void invoke("change_workflow_requirement", {
              request: {
                workflowId: plan.workflowId,
                version: plan.version,
                digest: workflow.digest,
                text: revisionReason.trim(),
              },
            })
              .then(() => {
                if (mounted.current) setEditing(false);
              })
              .catch(() => {
                if (mounted.current) setError("修改要求未保存，请核对任务状态");
              })
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          }}
        >
          <textarea
            aria-label="新的任务要求"
            rows={3}
            maxLength={8000}
            value={revisionReason}
            className="w-full rounded-md border border-neutral-200 p-2 text-sm"
            onChange={(event) => setRevisionReason(event.target.value)}
          />
          <button className="client-dark-button mt-2" disabled={busy || !revisionReason.trim()}>
            停止旧操作并修改
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="research-error">
          {error}
        </p>
      )}
      {(() => {
        const applicationEvents = workflow.events.filter((event) =>
          event.kind.startsWith("application."),
        );
        return (
          ["application.approved", "application.unknown"].includes(
            applicationEvents.at(-1)?.kind ?? "",
          ) && (
            <button
              className="client-subtle-button"
              disabled={busy}
              onClick={() => void control("reconcile_application")}
            >
              我已手工核对源分支，撤销旧应用授权
            </button>
          )
        );
      })()}
      <div className="workflow-dependencies" aria-label="任务依赖视图">
        {plan.workItems.map((item) => (
          <div key={item.workItemId} className="workflow-dependency">
            <span className="text-xs text-neutral-500">
              {item.dependencies.length
                ? item.dependencies
                    .map((id) => plan.workItems.find((work) => work.workItemId === id)?.title ?? id)
                    .join(" + ")
                : "起点"}
            </span>
            <span aria-hidden="true">→</span>
            <span className="text-sm">{item.title}</span>
          </div>
        ))}
      </div>
      <ol className="workflow-items">
        {plan.workItems.map((item) => {
          const runs = workflow.runs.filter(
            (run) => run.workItemId === item.workItemId && run.intentVersion === plan.intentVersion,
          );
          const latest = runs.at(-1);
          return (
            <li key={item.workItemId}>
              <details>
                <summary className="flex items-center justify-between gap-3">
                  <span>{item.title}</span>
                  <span className="text-xs text-neutral-500">
                    {item.provider} · {runLabels[latest?.status ?? "pending"]}
                  </span>
                </summary>
                <p className="py-2 text-sm">{item.objective}</p>
                {item.dependencies.length > 0 && (
                  <p className="text-xs text-neutral-500">
                    依赖：
                    {item.dependencies
                      .map(
                        (id) => plan.workItems.find((work) => work.workItemId === id)?.title ?? id,
                      )
                      .join("、")}
                  </p>
                )}
                <p className="mt-2 text-xs text-neutral-500">验收：{item.acceptance.join("；")}</p>
                {runs.map((run) => (
                  <div key={run.runId} className="mt-2 text-xs break-all">
                    <p>
                      尝试 {run.attempt} · {runLabels[run.status]}
                      {run.revision ? ` · ${run.revision}` : ""}
                    </p>
                    {run.permission && (
                      <p role="status" className="mt-2">
                        {run.permission.description}
                      </p>
                    )}
                    {run.workspace && (
                      <p className="mt-1 text-neutral-500">
                        {run.branch} · {run.workspace}
                      </p>
                    )}
                    {run.summary && <p className="mt-2 whitespace-pre-wrap">{run.summary}</p>}
                    {run.error && <p className="mt-2 text-red-700">{run.error}</p>}
                    {run.workspace && (
                      <button
                        className="client-subtle-button mt-2"
                        disabled={busy}
                        onClick={() => void inspectRun(run.runId, "inspect")}
                      >
                        查看变更
                      </button>
                    )}
                    {["unknown", "blocked"].includes(run.status) && (
                      <button
                        className="client-subtle-button mt-2"
                        disabled={busy}
                        onClick={() => void inspectRun(run.runId, "reconcile")}
                      >
                        停止并保留成果
                      </button>
                    )}
                    {((run.status === "running" && run.capabilities?.steer) ||
                      ["blocked", "unknown"].includes(run.status)) && (
                      <button
                        className="client-subtle-button mt-2"
                        disabled={busy}
                        onClick={() => {
                          setInstructionRun(run.runId);
                          setInstruction("");
                        }}
                      >
                        {run.status === "running" ? "追加指令" : "答复"}
                      </button>
                    )}
                    {instructionRun === run.runId && (
                      <form
                        className="py-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void inspectRun(run.runId, run.status === "running" ? "steer" : "answer");
                        }}
                      >
                        <textarea
                          className="w-full rounded-md border border-neutral-200 p-2 text-sm"
                          aria-label="子任务指令"
                          value={instruction}
                          onChange={(event) => setInstruction(event.target.value)}
                          maxLength={8000}
                          rows={3}
                        />
                        <button
                          className="client-dark-button mt-2"
                          disabled={busy || !instruction.trim()}
                        >
                          发送
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </details>
            </li>
          );
        })}
      </ol>
      {runEvidence && <pre className="research-body">{runEvidence}</pre>}
      {(workflow.findings?.length ?? 0) > 0 && (
        <details className="context-section" open>
          <summary>审查问题</summary>
          {workflow.findings?.map((finding) => (
            <div key={finding.findingId} className="py-2 text-sm">
              <p>{finding.summary}</p>
              <p className="mt-1 text-xs text-neutral-500">
                {{ open: "未解决", resolved: "已解决", needs_user: "需要用户决策" }[finding.status]}{" "}
                · 返工 {finding.reworkRounds} 轮 · {finding.revision.slice(0, 12)}
              </p>
            </div>
          ))}
        </details>
      )}
      {workflow.integration && (
        <details className="context-section" open>
          <summary>
            整合成果 ·{" "}
            {
              { verified: "已验证", unverified: "未验证", conflict: "冲突" }[
                workflow.integration.status
              ]
            }
          </summary>
          <p className="mt-2 text-xs break-all">
            {workflow.integration.branch} · {workflow.integration.revision}
          </p>
          <p className="mt-1 text-xs text-neutral-500 break-all">
            {workflow.integration.workspace}
          </p>
          {workflow.integration.tests.map((test) => (
            <div
              key={test.artifactId}
              className="flex items-center justify-between gap-2 py-2 text-xs"
            >
              <code className="break-all">
                {test.command} · exit {test.exitCode}
              </code>
              <button
                className="client-subtle-button shrink-0"
                onClick={() => {
                  const run = workflow.runs.find(
                    (run) =>
                      run.workspace === workflow.integration?.workspace &&
                      run.revision === test.revision,
                  );
                  if (!run) return;
                  void invoke<string | null>("get_research_artifact", {
                    taskId: run.runId,
                    artifactId: test.artifactId,
                  })
                    .then((text) => {
                      if (mounted.current) setTestOutput(text ?? "测试输出不存在");
                    })
                    .catch(() => {
                      if (mounted.current) setError("测试输出读取失败");
                    });
                }}
              >
                输出
              </button>
            </div>
          ))}
          <p className="text-xs text-neutral-500">
            {workflow.integration.reviews.length} 次版本绑定审查
          </p>
          {workflow.integration.status === "verified" && workflow.status === "approved" && (
            <button
              className="client-subtle-button mt-2"
              disabled={busy}
              onClick={() => void inspectRun("", "prepare")}
            >
              应用到当前分支
            </button>
          )}
          {application && (
            <div className="py-3 text-xs break-all" role="group" aria-label="确认应用成果">
              <p>{application.repository}</p>
              <p className="mt-1">
                {application.expectedRef.replace("refs/heads/", "")} ·{" "}
                {application.expectedHead.slice(0, 12)} → {application.revision.slice(0, 12)}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  className="client-dark-button"
                  disabled={
                    busy ||
                    application.version !== plan.version ||
                    application.digest !== workflow.digest ||
                    application.revision !== workflow.integration.revision ||
                    workflow.status !== "approved"
                  }
                  onClick={() => void inspectRun("", "apply")}
                >
                  确认应用
                </button>
                <button
                  className="client-subtle-button"
                  disabled={busy}
                  onClick={() => setApplication(undefined)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {testOutput && <pre className="research-body mt-2">{testOutput}</pre>}
        </details>
      )}
      <details className="context-section">
        <summary>时间线</summary>
        <ol className="context-steps">
          {workflow.events.map((event) => (
            <li key={event.eventId}>{event.summary}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}
