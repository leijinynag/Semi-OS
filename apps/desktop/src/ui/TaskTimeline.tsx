import type {
  TaskEvidence,
  TaskTimelineModel,
  TimelineMilestoneStatus,
} from "./client-model";
import {
  CheckIcon,
  CurrentActionIcon,
  EvidenceIcon,
  WaitingIcon,
} from "./icons";

const milestoneLabels: Record<TimelineMilestoneStatus, string> = {
  completed: "已完成",
  active: "进行中",
  waiting: "等待",
  pending: "待处理",
  failed: "失败",
};

function EvidenceRow({ evidence }: { evidence: TaskEvidence }) {
  return (
    <a
      className="evidence-row"
      href={evidence.reference}
      onClick={(event) => event.preventDefault()}
      title={evidence.reference}
    >
      <EvidenceIcon size={16} weight="regular" />
      <span>
        <strong>{evidence.label}</strong>
        <small>{evidence.kind}</small>
      </span>
    </a>
  );
}

export function TaskTimeline({ task }: { task: TaskTimelineModel }) {
  return (
    <section className="timeline-detail" aria-label={`${task.title}任务进度`}>
      <header className="timeline-header">
        <div>
          <span className={`status-label status-${task.status}`}>
            {task.status === "running"
              ? "执行中"
              : task.status === "waiting_confirmation"
                ? "等待确认"
                : task.status === "completed"
                  ? "已完成"
                  : task.status}
          </span>
          <h2>{task.title}</h2>
          <p>{task.summary}</p>
        </div>
        <time>{task.updatedAt}</time>
      </header>

      <div className="task-facts">
        {task.currentAction ? (
          <div>
            <CurrentActionIcon size={17} weight="duotone" />
            <span>
              <small>当前动作</small>
              <strong>{task.currentAction}</strong>
            </span>
          </div>
        ) : null}
        {task.waitingReason ? (
          <div className="is-waiting">
            <WaitingIcon size={17} weight="duotone" />
            <span>
              <small>等待原因</small>
              <strong>{task.waitingReason}</strong>
            </span>
          </div>
        ) : null}
        {task.result ? (
          <div className="is-result">
            <CheckIcon size={17} weight="bold" />
            <span>
              <small>任务结果</small>
              <strong>{task.result}</strong>
            </span>
          </div>
        ) : null}
      </div>

      <ol className="task-timeline">
        {task.milestones.map((milestone) => (
          <li className={`milestone-${milestone.status}`} key={milestone.id}>
            <span className="timeline-node" aria-hidden="true" />
            <div>
              <header>
                <strong>{milestone.title}</strong>
                <span>{milestoneLabels[milestone.status]}</span>
              </header>
              <p>{milestone.detail}</p>
              {milestone.occurredAt ? <time>{milestone.occurredAt}</time> : null}
            </div>
          </li>
        ))}
      </ol>

      <section className="evidence-section">
        <header>
          <span>证据与引用</span>
          <small>{task.evidence.length} 项</small>
        </header>
        {task.evidence.length > 0 ? (
          <div className="evidence-list">
            {task.evidence.map((evidence) => (
              <EvidenceRow evidence={evidence} key={evidence.id} />
            ))}
          </div>
        ) : (
          <p className="empty-inline">任务完成或执行后，验证证据会出现在这里。</p>
        )}
      </section>
    </section>
  );
}
