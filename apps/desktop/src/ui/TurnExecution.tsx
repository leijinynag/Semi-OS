import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { AgentActivity } from "@/components/agents/agent-activity";
import { ToolResult } from "@/components/agents/tool-result";
import {
  ToolApproval,
  ToolApprovalCode,
  type ToolApprovalStatus,
} from "@/components/agents/tool-approval";
import { Citations } from "@/components/agents/citations";
import { LinkIcon } from "./icons";
import {
  executionActions,
  executionIsActive,
  executionStatusLabel,
  safeSourceUrl,
  type ExecutionApproval,
  type ExecutionSnapshot,
} from "./execution";
import { useExecution } from "./useExecution";

export interface ApprovalDecision {
  approval: ExecutionApproval;
  status: ToolApprovalStatus;
  error?: string;
}
export function ExecutionView({
  snapshot,
  decisions = [],
  onDecide,
  error,
}: {
  snapshot: ExecutionSnapshot;
  decisions?: ApprovalDecision[];
  onDecide: (approval: ExecutionApproval, approved: boolean) => void;
  error?: string;
}) {
  const [artifact, setArtifact] = useState<{ title: string; text: string }>();
  const [artifactError, setArtifactError] = useState("");
  const generation = useRef(0);
  const actions = executionActions(snapshot);
  const active = executionIsActive(snapshot);
  const approvals = new Map(
    snapshot.approvals.map((approval) => [
      approval.operationId,
      { approval, status: "pending" as ToolApprovalStatus },
    ]),
  );
  for (const decision of decisions) approvals.set(decision.approval.operationId, decision);
  const collected = snapshot.sources.filter((source) => source.status === "collected");
  if (
    !actions.length &&
    !snapshot.progress.length &&
    !snapshot.sources.length &&
    !approvals.size &&
    !error
  )
    return null;
  const summary =
    snapshot.lifecycle === "paused"
      ? "已暂停"
      : snapshot.lifecycle === "cancelled"
        ? "已取消"
        : snapshot.lifecycle === "unknown"
          ? "结果待核对"
          : snapshot.lifecycle === "failed"
            ? "执行失败"
            : "执行记录";
  return (
    <section className="turn-execution" aria-label="执行过程">
      {!!snapshot.progress.length && (
        <AgentActivity
          items={snapshot.progress
            .filter(
              (item, index, all) =>
                all.findIndex((other) => other.callId === item.callId) === index,
            )
            .map((item) => {
              const action = actions.find((entry) => entry.id === item.callId);
              return {
                id: item.callId,
                type: "trace" as const,
                kind: item.toolName.startsWith("browser") ? "read" : "run",
                label: item.label,
                detail: action
                  ? `${item.toolName} · ${executionStatusLabel[action.status]}`
                  : item.toolName,
              };
            })}
          status={active ? "working" : "complete"}
          activeLabel={snapshot.approvals.length ? "等待你的确认" : "正在执行"}
          summary={`${summary} · ${actions.length} 次调用`}
          maxHeight={144}
          collapseOnComplete
        />
      )}
      <div className="execution-results">
        {actions.map((action) => (
          <ToolResult
            key={action.id}
            tool={action.toolName}
            title={action.label}
            status={
              (
                {
                  started: "running",
                  succeeded: "success",
                  failed: "error",
                  cancelled: "cancelled",
                  unknown: "unknown",
                  needs_user: "needs_user",
                } as const
              )[action.status]
            }
            kind={action.toolName === "bash" ? "terminal" : "custom"}
            defaultOpen={["failed", "unknown", "needs_user"].includes(action.status)}
            collapseOnComplete={action.status === "succeeded"}
            meta={
              action.receipt?.durationMs != null
                ? `${(action.receipt.durationMs / 1000).toFixed(1)}s`
                : undefined
            }
            copyText={action.receipt?.outputSummary}
          >
            <dl className="execution-receipt">
              <dt>输入</dt>
              <dd>{action.receipt?.inputSummary || "等待工具回执"}</dd>
              <dt>结果</dt>
              <dd>
                {action.receipt?.outputSummary ||
                  (action.status === "unknown"
                    ? "本次调用没有明确终态，不能视为成功，请先核对。"
                    : "暂无结果摘要")}
              </dd>
            </dl>
          </ToolResult>
        ))}
      </div>
      {[...approvals.values()].map(({ approval, status }) => (
        <div key={approval.operationId} className="execution-approval">
          <ToolApproval
            tool={approval.value.toolName}
            title="此操作需要你的确认"
            description={
              status === "approved"
                ? "批准已送达，执行结果以工具回执为准。"
                : status === "error"
                  ? "送达状态不明，请先核对，不要重复执行。"
                  : "检查具体参数后，决定是否允许本次操作。"
            }
            status={status}
            defaultOpen
            parameters={[
              { id: "risk", label: "风险类型", value: approval.value.riskLevel },
              {
                id: "input",
                label: "调用参数",
                value: <ToolApprovalCode code={approval.value.inputJson} language="json" />,
              },
            ]}
            onApprove={() => onDecide(approval, true)}
            onDeny={() => onDecide(approval, false)}
          />
        </div>
      ))}
      {!!collected.length && (
        <Citations
          title="已采集来源"
          idPrefix={`sources-${snapshot.taskId}`}
          citations={collected.map((source) => ({
            id: source.sourceId,
            title: source.title,
            url: safeSourceUrl(source.finalUrl),
            domain: safeSourceUrl(source.finalUrl) ? new URL(source.finalUrl).hostname : undefined,
            icon: <LinkIcon size={14} />,
          }))}
        />
      )}
      {snapshot.sources.map((source) =>
        source.status !== "collected" ? (
          <p key={source.sourceId} className="execution-source-failure">
            {source.title} · {source.status === "needs_user" ? "需要人工处理" : "采集失败"}
            {source.reason ? `：${source.reason}` : ""}
          </p>
        ) : source.artifactId ? (
          <button
            key={source.sourceId}
            className="execution-source-body"
            onClick={() => {
              const current = ++generation.current;
              setArtifactError("");
              void invoke<string | null>("get_research_artifact", {
                taskId: source.taskId,
                artifactId: source.artifactId,
              })
                .then((text) => {
                  if (generation.current === current)
                    setArtifact({ title: source.title, text: text ?? "正文不可用" });
                })
                .catch(() => {
                  if (generation.current === current) setArtifactError("正文读取失败");
                });
            }}
          >
            查看正文 · {source.title}
          </button>
        ) : null,
      )}
      {artifact && (
        <details className="execution-artifact" open>
          <summary>{artifact.title}</summary>
          <pre>{artifact.text}</pre>
        </details>
      )}
      {(error || artifactError) && (
        <p role="alert" className="research-error">
          {error || artifactError}
        </p>
      )}
    </section>
  );
}

/** 点击防重只负责传输状态；批准不能成为虚构的工具成功回执。 */
export function TurnExecution({ taskId }: { taskId: string }) {
  const { snapshot, error } = useExecution(taskId);
  const [decisions, setDecisions] = useState<ApprovalDecision[]>([]);
  const [decisionError, setDecisionError] = useState("");
  const submitted = useRef(new Set<string>());
  const decide = async (approval: ExecutionApproval, approved: boolean) => {
    if (submitted.current.has(approval.operationId)) return;
    submitted.current.add(approval.operationId);
    const update = (status: ToolApprovalStatus) =>
      setDecisions((items) => [
        ...items.filter((item) => item.approval.operationId !== approval.operationId),
        { approval, status },
      ]);
    update("approving");
    try {
      await invoke("confirm_research_action", { operationId: approval.operationId, approved });
      update(approved ? "approved" : "denied");
    } catch {
      update("error");
      setDecisionError("确认结果未能核实，请检查连接并核对执行记录。");
    }
  };
  if (!snapshot)
    return error ? (
      <p role="alert" className="research-error">
        {error}
      </p>
    ) : null;
  return (
    <ExecutionView
      snapshot={snapshot}
      decisions={decisions}
      onDecide={(approval, approved) => {
        void decide(approval, approved);
      }}
      error={error || decisionError}
    />
  );
}
