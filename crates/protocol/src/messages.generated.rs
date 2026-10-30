// 自动生成；先校验 wire schema，再解码对应 DTO。
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopElement {
    pub reference: String,
    pub role: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub value_truncated: bool,
    pub focused: bool,
    pub enabled: bool,
    pub sensitive: bool,
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<PayloadDesktopBounds>,
    pub depth: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopObservation {
    pub version: String,
    pub observed_at_ms: u64,
    pub bundle_id: String,
    pub process_id: u64,
    pub window_id: String,
    pub title: String,
    pub elements: Vec<PayloadDesktopElement>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopResult {
    pub status: String,
    pub summary: String,
    pub lease_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<PayloadDesktopObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopVisualCapability {
    pub status: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopPermissions {
    pub accessibility: String,
    pub screen_recording: String,
    pub microphone: String,
    pub input_monitoring: String,
    pub takeover_detection: bool,
    pub visual_fallback: PayloadDesktopVisualCapability,
    pub checked_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDesktopResultPayload {
    pub operation_id: String,
    pub result: PayloadDesktopResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PayloadDesktopPermissions>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestHealthCheckPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_capabilities: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadVoiceStart {
    pub session_id: String,
    pub task_id: String,
    pub cwd: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate_hz: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAudioAppend {
    pub sequence: u64,
    pub audio_base64: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestVoiceTurnCommitPayload {
    pub last_sequence: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadTextSubmit {
    pub session_id: String,
    pub task_id: String,
    pub cwd: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestVoiceInterruptPayload {
    pub task_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadSessionIdentity {
    pub session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestWorkflowControlPayload {
    pub workflow_id: String,
    pub session_id: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAck {
    pub operation_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Option<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadRunIdentity {
    pub session_id: String,
    pub workflow_id: String,
    pub run_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadRunInstruction {
    pub session_id: String,
    pub workflow_id: String,
    pub run_id: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestWorkflowApplicationPreparePayload {
    pub session_id: String,
    pub workflow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_id: Option<Option<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestWorkflowApplicationApplyPayload {
    pub session_id: String,
    pub workflow_id: String,
    pub application_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadTaskIdentity {
    pub task_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBrowserLoginOpenPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBrowserSessionResumePayload {
    pub resume_id: String,
    pub session_id: String,
    pub task_id: String,
    pub mode: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind", content = "payload")]
pub enum RequestMessage {
    #[serde(rename = "desktop.result")]
    DesktopResult(RequestDesktopResultPayload),
    #[serde(rename = "health.check")]
    HealthCheck(Option<RequestHealthCheckPayload>),
    #[serde(rename = "voice.turn.start")]
    VoiceTurnStart(PayloadVoiceStart),
    #[serde(rename = "voice.audio.append")]
    VoiceAudioAppend(PayloadAudioAppend),
    #[serde(rename = "voice.turn.commit")]
    VoiceTurnCommit(RequestVoiceTurnCommitPayload),
    #[serde(rename = "voice.text.submit")]
    VoiceTextSubmit(PayloadTextSubmit),
    #[serde(rename = "voice.interrupt")]
    VoiceInterrupt(RequestVoiceInterruptPayload),
    #[serde(rename = "voice.session.dispose")]
    VoiceSessionDispose(PayloadSessionIdentity),
    #[serde(rename = "workflow.control")]
    WorkflowControl(RequestWorkflowControlPayload),
    #[serde(rename = "workflow.acknowledged")]
    WorkflowAcknowledged(PayloadAck),
    #[serde(rename = "workflow.run.inspect")]
    WorkflowRunInspect(PayloadRunIdentity),
    #[serde(rename = "workflow.run.reconcile")]
    WorkflowRunReconcile(PayloadRunIdentity),
    #[serde(rename = "workflow.run.steer")]
    WorkflowRunSteer(PayloadRunInstruction),
    #[serde(rename = "workflow.run.answer")]
    WorkflowRunAnswer(PayloadRunInstruction),
    #[serde(rename = "workflow.application.prepare")]
    WorkflowApplicationPrepare(RequestWorkflowApplicationPreparePayload),
    #[serde(rename = "workflow.application.apply")]
    WorkflowApplicationApply(RequestWorkflowApplicationApplyPayload),
    #[serde(rename = "research.confirmation.required")]
    ResearchConfirmationRequired(PayloadTaskIdentity),
    #[serde(rename = "research.persisted")]
    ResearchPersisted(PayloadAck),
    #[serde(rename = "browser.login.open")]
    BrowserLoginOpen(RequestBrowserLoginOpenPayload),
    #[serde(rename = "browser.session.resume")]
    BrowserSessionResume(RequestBrowserSessionResumePayload),
    #[serde(rename = "browser.session.inspect")]
    BrowserSessionInspect(std::collections::BTreeMap<String, serde_json::Value>),
    #[serde(rename = "fixture.request")]
    FixtureRequest(std::collections::BTreeMap<String, serde_json::Value>),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHealthReadyPayload {
    pub pid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAccepted {
    pub accepted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseVoiceAudioAcceptedPayload {
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseVoiceInterruptAcceptedPayload {
    pub mode: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseWorkflowRunResultPayloadVariant0 {
    pub ok: bool,
    pub value: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseWorkflowRunResultPayloadVariant1 {
    pub ok: bool,
    pub error: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseWorkflowRunResultPayload {
    Variant0(ResponseWorkflowRunResultPayloadVariant0),
    Variant1(ResponseWorkflowRunResultPayloadVariant1),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadBrowserSessionState {
    pub resume_id: String,
    pub session_id: String,
    pub task_id: String,
    pub status: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseBrowserSessionSnapshotPayload {
    Variant0(serde_json::Value),
    Variant1(PayloadBrowserSessionState),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadBrowserObservationElementsItem {
    pub r#ref: String,
    pub role: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadBrowserObservation {
    pub page_id: String,
    pub url: String,
    pub title: String,
    pub version: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub elements: Vec<PayloadBrowserObservationElementsItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseBrowserLoginFailedPayload {
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind", content = "payload")]
pub enum ResponseMessage {
    #[serde(rename = "desktop.acknowledged")]
    DesktopAcknowledged(PayloadAck),
    #[serde(rename = "health.ready")]
    HealthReady(ResponseHealthReadyPayload),
    #[serde(rename = "voice.session.disposed")]
    VoiceSessionDisposed(PayloadSessionIdentity),
    #[serde(rename = "voice.text.accepted")]
    VoiceTextAccepted(PayloadAccepted),
    #[serde(rename = "voice.turn.started")]
    VoiceTurnStarted(PayloadAccepted),
    #[serde(rename = "voice.audio.accepted")]
    VoiceAudioAccepted(ResponseVoiceAudioAcceptedPayload),
    #[serde(rename = "voice.turn.committed")]
    VoiceTurnCommitted(PayloadAccepted),
    #[serde(rename = "voice.interrupt.accepted")]
    VoiceInterruptAccepted(ResponseVoiceInterruptAcceptedPayload),
    #[serde(rename = "workflow.received")]
    WorkflowReceived(PayloadAccepted),
    #[serde(rename = "workflow.control.accepted")]
    WorkflowControlAccepted(PayloadAccepted),
    #[serde(rename = "workflow.run.accepted")]
    WorkflowRunAccepted(PayloadAccepted),
    #[serde(rename = "workflow.run.result")]
    WorkflowRunResult(ResponseWorkflowRunResultPayload),
    #[serde(rename = "research.confirmation.announced")]
    ResearchConfirmationAnnounced(PayloadAccepted),
    #[serde(rename = "research.acknowledged")]
    ResearchAcknowledged(PayloadAccepted),
    #[serde(rename = "browser.login.accepted")]
    BrowserLoginAccepted(PayloadAccepted),
    #[serde(rename = "browser.session.resume.accepted")]
    BrowserSessionResumeAccepted(PayloadAccepted),
    #[serde(rename = "browser.session.snapshot")]
    BrowserSessionSnapshot(ResponseBrowserSessionSnapshotPayload),
    #[serde(rename = "browser.login.opened")]
    BrowserLoginOpened(PayloadBrowserObservation),
    #[serde(rename = "browser.login.failed")]
    BrowserLoginFailed(ResponseBrowserLoginFailedPayload),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDesktopCancelledPayload {
    pub operation_id: String,
    pub task_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant0 {
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant1 {
    pub kind: String,
    pub version: String,
    pub reference: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant2 {
    pub kind: String,
    pub version: String,
    pub reference: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant3 {
    pub kind: String,
    pub version: String,
    pub reference: String,
    pub key: String,
    pub modifiers: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant4 {
    pub kind: String,
    pub version: String,
    pub reference: String,
    pub direction: String,
    pub amount: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDesktopActionVariant5 {
    pub kind: String,
    pub bundle_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PayloadDesktopAction {
    Variant0(PayloadDesktopActionVariant0),
    Variant1(PayloadDesktopActionVariant1),
    Variant2(PayloadDesktopActionVariant2),
    Variant3(PayloadDesktopActionVariant3),
    Variant4(PayloadDesktopActionVariant4),
    Variant5(PayloadDesktopActionVariant5),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDesktopRequestPayload {
    pub operation_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub input_json: String,
    pub input_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    pub action: PayloadDesktopAction,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceStatePayload {
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadTranscript {
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceAssistantTextDeltaPayload {
    pub text: String,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceAnswerPayload {
    pub task_id: String,
    pub summary: String,
    pub report: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceSentencePayload {
    pub sentence_id: String,
    pub text: String,
    pub purpose: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceTimestampsPayloadWordsItem {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceTimestampsPayload {
    pub sentence_id: String,
    pub words: Vec<EventVoiceTimestampsPayloadWordsItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceAudioChunkPayload {
    pub sentence_id: String,
    pub sequence: u64,
    pub mime_type: String,
    pub audio_base64: String,
    pub first: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceAudioCompletedPayload {
    pub sentence_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventVoiceAudioStopPayload {
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadErrorPayload {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchProgressPayload {
    pub task_id: String,
    pub label: String,
    pub tool_name: String,
    pub call_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadToolReceipt {
    pub attempt_id: String,
    pub task_id: String,
    pub tool_name: String,
    pub idempotency_key: String,
    pub attempt_number: u64,
    pub status: String,
    pub risk_level: String,
    pub input_summary: String,
    pub input_digest: String,
    pub policy_decision: String,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    pub artifacts: Vec<std::collections::BTreeMap<String, serde_json::Value>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadResearchReportClaimsItemCitationsItem {
    pub source_id: String,
    pub quote_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadResearchReportClaimsItem {
    pub text: String,
    pub citations: Vec<PayloadResearchReportClaimsItemCitationsItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadResearchReport {
    pub task_id: String,
    pub summary: String,
    pub claims: Vec<PayloadResearchReportClaimsItem>,
    pub limitations: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadTiming {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    pub duration_ms: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchInterruptedPayload {
    pub task_id: String,
    pub mode: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadResearchSourceQuotesItem {
    pub quote_id: String,
    pub start: u64,
    pub end: u64,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadResearchSource {
    pub source_id: String,
    pub task_id: String,
    pub original_url: String,
    pub final_url: String,
    pub title: String,
    pub collected_at_ms: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub quotes: Vec<PayloadResearchSourceQuotesItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchPersistPayloadVariant0 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadResearchSource,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchPersistPayloadVariant1 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadResearchReport,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadPolicyRequest {
    pub task_id: String,
    pub tool_name: String,
    pub risk_level: String,
    pub input_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchPersistPayloadVariant2 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadPolicyRequest,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EventResearchPersistPayload {
    Variant0(EventResearchPersistPayloadVariant0),
    Variant1(EventResearchPersistPayloadVariant1),
    Variant2(EventResearchPersistPayloadVariant2),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventResearchPolicyCancelledPayload {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadExecutionBudget {
    pub max_parallel_runs: u64,
    pub max_rework_rounds: u64,
    pub max_no_progress_turns: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadEvidenceRequirement {
    pub revision: bool,
    pub tests: bool,
    pub independent_review: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadWorkItem {
    pub work_item_id: String,
    pub title: String,
    pub objective: String,
    pub role: String,
    pub provider: String,
    pub dependencies: Vec<String>,
    pub outputs: Vec<String>,
    pub acceptance: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<PayloadEvidenceRequirement>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadWorkflowPlan {
    pub workflow_id: String,
    pub session_id: String,
    pub version: u64,
    pub intent_version: u64,
    pub title: String,
    pub goal: String,
    pub scope: Vec<String>,
    pub acceptance: Vec<String>,
    pub authorized_actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorized_capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_budget: Option<PayloadExecutionBudget>,
    pub repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_commit: Option<String>,
    pub work_items: Vec<PayloadWorkItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant0 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadWorkflowPlan,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant1 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadSessionIdentity,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant2Value {
    pub workflow_id: String,
    pub version: u64,
    pub digest: String,
    pub work_item_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant2 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant2Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAgentRunPermission {
    pub request_id: String,
    pub tool: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAgentRunCapabilities {
    pub steer: bool,
    pub pause: bool,
    pub resume: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadAgentRun {
    pub run_id: String,
    pub workflow_id: String,
    pub plan_version: u64,
    pub intent_version: u64,
    pub work_item_id: String,
    pub attempt: u64,
    pub provider: String,
    pub status: String,
    pub started_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<PayloadAgentRunPermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<PayloadAgentRunCapabilities>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant3 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadAgentRun,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant4Value {
    pub workflow_id: String,
    pub kind: String,
    pub summary: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant4 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant4Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadReviewFinding {
    pub finding_id: String,
    pub work_item_id: String,
    pub revision: String,
    pub summary: String,
    pub status: String,
    pub rework_rounds: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant5Value {
    pub workflow_id: String,
    pub finding: PayloadReviewFinding,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant5 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant5Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadTestEvidence {
    pub command: String,
    pub exit_code: i64,
    pub revision: String,
    pub artifact_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadIntegrationResultReviewsItem {
    pub run_id: String,
    pub revision: String,
    pub finding_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadIntegrationResult {
    pub revision: String,
    pub branch: String,
    pub workspace: String,
    pub commits: Vec<String>,
    pub status: String,
    pub tests: Vec<PayloadTestEvidence>,
    pub reviews: Vec<PayloadIntegrationResultReviewsItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant6Value {
    pub workflow_id: String,
    pub result: PayloadIntegrationResult,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant6 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant6Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant7Value {
    pub workflow_id: String,
    pub run_id: String,
    pub text: String,
    pub evidence: PayloadTestEvidence,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant7 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant7Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant8Value {
    pub workflow_id: String,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant8 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant8Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant9Value {
    pub application_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant9 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant9Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant10Value {
    pub application_id: String,
    pub applied: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant10 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant10Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant11Value {
    pub workflow_id: String,
    pub owner: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant11 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant11Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadCoordinatorCheckpoint {
    pub session_id: String,
    pub sequence: u64,
    pub data: std::collections::BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant12Value {
    pub workflow_id: String,
    pub owner: String,
    pub sequence: u64,
    pub checkpoint: PayloadCoordinatorCheckpoint,
    pub progress: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant12 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant12Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant13Value {
    pub workflow_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant13 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant13Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant14Value {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant14 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant14Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant15Value {
    pub run_id: String,
    pub phase: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant15 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant15Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant16Value {
    pub run_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant16 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant16Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDecisionInputQuestionsItemOptionsItem {
    pub label: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDecisionInputQuestionsItem {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<PayloadDecisionInputQuestionsItemOptionsItem>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDecisionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<PayloadDecisionInputQuestionsItem>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant17Value {
    pub workflow_id: String,
    pub run_id: String,
    pub request_id: String,
    pub kind: String,
    pub input: PayloadDecisionInput,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant17 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant17Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDecisionValue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<std::collections::BTreeMap<String, String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant18Value {
    pub workflow_id: String,
    pub run_id: String,
    pub request_id: String,
    pub kind: String,
    pub decision: PayloadDecisionValue,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant18 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant18Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant19Value {
    pub workflow_id: String,
    pub request_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant19 {
    pub operation_id: String,
    pub operation: String,
    pub value: EventWorkflowRequestPayloadVariant19Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadOperationAuthorization {
    pub workflow_id: String,
    pub run_id: String,
    pub tool: String,
    pub input: std::collections::BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkflowRequestPayloadVariant20 {
    pub operation_id: String,
    pub operation: String,
    pub value: PayloadOperationAuthorization,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EventWorkflowRequestPayload {
    Variant0(EventWorkflowRequestPayloadVariant0),
    Variant1(EventWorkflowRequestPayloadVariant1),
    Variant2(EventWorkflowRequestPayloadVariant2),
    Variant3(EventWorkflowRequestPayloadVariant3),
    Variant4(EventWorkflowRequestPayloadVariant4),
    Variant5(EventWorkflowRequestPayloadVariant5),
    Variant6(EventWorkflowRequestPayloadVariant6),
    Variant7(EventWorkflowRequestPayloadVariant7),
    Variant8(EventWorkflowRequestPayloadVariant8),
    Variant9(EventWorkflowRequestPayloadVariant9),
    Variant10(EventWorkflowRequestPayloadVariant10),
    Variant11(EventWorkflowRequestPayloadVariant11),
    Variant12(EventWorkflowRequestPayloadVariant12),
    Variant13(EventWorkflowRequestPayloadVariant13),
    Variant14(EventWorkflowRequestPayloadVariant14),
    Variant15(EventWorkflowRequestPayloadVariant15),
    Variant16(EventWorkflowRequestPayloadVariant16),
    Variant17(EventWorkflowRequestPayloadVariant17),
    Variant18(EventWorkflowRequestPayloadVariant18),
    Variant19(EventWorkflowRequestPayloadVariant19),
    Variant20(EventWorkflowRequestPayloadVariant20),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkerProgressPayload {
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventWorkerStateChangedPayload {
    pub from: String,
    pub to: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRuntimeErrorPayload {
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind", content = "payload")]
pub enum EventMessage {
    #[serde(rename = "browser.session.state")]
    BrowserSessionState(PayloadBrowserSessionState),
    #[serde(rename = "desktop.cancelled")]
    DesktopCancelled(EventDesktopCancelledPayload),
    #[serde(rename = "desktop.request")]
    DesktopRequest(EventDesktopRequestPayload),
    #[serde(rename = "fixture.echo")]
    FixtureEcho(std::collections::BTreeMap<String, serde_json::Value>),
    #[serde(rename = "voice.state")]
    VoiceState(EventVoiceStatePayload),
    #[serde(rename = "voice.transcript.partial")]
    VoiceTranscriptPartial(PayloadTranscript),
    #[serde(rename = "voice.transcript.final")]
    VoiceTranscriptFinal(PayloadTranscript),
    #[serde(rename = "voice.assistant.text_delta")]
    VoiceAssistantTextDelta(EventVoiceAssistantTextDeltaPayload),
    #[serde(rename = "voice.answer")]
    VoiceAnswer(EventVoiceAnswerPayload),
    #[serde(rename = "voice.sentence")]
    VoiceSentence(EventVoiceSentencePayload),
    #[serde(rename = "voice.timestamps")]
    VoiceTimestamps(EventVoiceTimestampsPayload),
    #[serde(rename = "voice.audio.chunk")]
    VoiceAudioChunk(EventVoiceAudioChunkPayload),
    #[serde(rename = "voice.audio.completed")]
    VoiceAudioCompleted(EventVoiceAudioCompletedPayload),
    #[serde(rename = "voice.audio.stop")]
    VoiceAudioStop(EventVoiceAudioStopPayload),
    #[serde(rename = "voice.turn.completed")]
    VoiceTurnCompleted(PayloadTaskIdentity),
    #[serde(rename = "voice.error")]
    VoiceError(PayloadErrorPayload),
    #[serde(rename = "research.progress")]
    ResearchProgress(EventResearchProgressPayload),
    #[serde(rename = "research.receipt")]
    ResearchReceipt(PayloadToolReceipt),
    #[serde(rename = "research.report")]
    ResearchReport(PayloadResearchReport),
    #[serde(rename = "research.timing")]
    ResearchTiming(PayloadTiming),
    #[serde(rename = "research.interrupted")]
    ResearchInterrupted(EventResearchInterruptedPayload),
    #[serde(rename = "research.persist")]
    ResearchPersist(EventResearchPersistPayload),
    #[serde(rename = "research.policy.cancelled")]
    ResearchPolicyCancelled(EventResearchPolicyCancelledPayload),
    #[serde(rename = "workflow.request")]
    WorkflowRequest(EventWorkflowRequestPayload),
    #[serde(rename = "browser.navigation")]
    BrowserNavigation(PayloadTiming),
    #[serde(rename = "browser.extraction")]
    BrowserExtraction(PayloadTiming),
    #[serde(rename = "browser.startup")]
    BrowserStartup(PayloadTiming),
    #[serde(rename = "browser.playwright")]
    BrowserPlaywright(PayloadTiming),
    #[serde(rename = "worker.progress")]
    WorkerProgress(EventWorkerProgressPayload),
    #[serde(rename = "worker.state_changed")]
    WorkerStateChanged(EventWorkerStateChangedPayload),
    #[serde(rename = "session.ready")]
    SessionReady(PayloadTiming),
    #[serde(rename = "session.started")]
    SessionStarted(PayloadSessionIdentity),
    #[serde(rename = "client.device_ready")]
    ClientDeviceReady(PayloadTiming),
    #[serde(rename = "client.press_to_first_sample")]
    ClientPressToFirstSample(PayloadTiming),
    #[serde(rename = "client.press_to_first_send")]
    ClientPressToFirstSend(PayloadTiming),
    #[serde(rename = "client.release_to_final_transcript")]
    ClientReleaseToFinalTranscript(PayloadTiming),
    #[serde(rename = "client.release_to_first_answer_playback")]
    ClientReleaseToFirstAnswerPlayback(PayloadTiming),
    #[serde(rename = "client.release_to_first_segment")]
    ClientReleaseToFirstSegment(PayloadTiming),
    #[serde(rename = "client.release_to_first_text_ready")]
    ClientReleaseToFirstTextReady(PayloadTiming),
    #[serde(rename = "client.release_to_tts_ready")]
    ClientReleaseToTtsReady(PayloadTiming),
    #[serde(rename = "runtime.error")]
    RuntimeError(EventRuntimeErrorPayload),
    #[serde(rename = "protocol.error")]
    ProtocolError(PayloadErrorPayload),
    #[serde(rename = "request.error")]
    RequestError(PayloadErrorPayload),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "kind", content = "payload")]
pub enum ErrorMessage {
    #[serde(rename = "protocol.error")]
    ProtocolError(PayloadErrorPayload),
    #[serde(rename = "request.error")]
    RequestError(PayloadErrorPayload),
}
