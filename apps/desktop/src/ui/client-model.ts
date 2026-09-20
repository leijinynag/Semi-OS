export type ClientPageId =
  | "conversation"
  | "tasks"
  | "memory"
  | "skills"
  | "settings";

export type TaskStatus =
  | "running"
  | "waiting_confirmation"
  | "completed"
  | "paused"
  | "failed"
  | "cancelled";

export type TimelineMilestoneStatus =
  | "completed"
  | "active"
  | "waiting"
  | "pending"
  | "failed";

export interface ConversationMessage {
  id: string;
  author: "user" | "assistant";
  content: string;
  time: string;
}

export interface TimelineMilestone {
  id: string;
  title: string;
  detail: string;
  status: TimelineMilestoneStatus;
  occurredAt?: string;
}

export interface TaskEvidence {
  id: string;
  label: string;
  reference: string;
  kind: "source" | "artifact" | "verification";
}

export interface TaskTimelineModel {
  id: string;
  title: string;
  status: TaskStatus;
  summary: string;
  currentAction?: string;
  waitingReason?: string;
  result?: string;
  startedAt: string;
  updatedAt: string;
  milestones: readonly TimelineMilestone[];
  evidence: readonly TaskEvidence[];
}

export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  layer: string;
  source: "user" | "agent";
  updatedAt: string;
}

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  category: string;
  availability: "ready" | "permission_required" | "unavailable";
  toolCount: number;
}

export interface ClientSettings {
  personality: string;
  voiceReply: boolean;
  floatingConfirmation: boolean;
  confirmHighRisk: boolean;
  confirmExternalSideEffect: boolean;
}

export type AssistantMode =
  | "idle"
  | "listening"
  | "working"
  | "waiting_confirmation"
  | "paused"
  | "cancelled";

export interface AssistantViewState {
  status: string;
  title: string;
  detail: string;
  confirmation?: {
    action: string;
    target: string;
  };
}
