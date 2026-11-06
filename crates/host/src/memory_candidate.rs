//! Worker → Host 记忆候选协议。
//!
//! 本模块把 `memory.candidate.submit` 校验后映射到 [`semi_os_storage::MemoryWriteCandidate`]，
//! 由 Rust Host 独占调用 SQLite。非法或缺字段返回明确拒绝回执，不会静默丢弃。
//! 写入始终以 Agent 身份进行，因此不能覆盖用户记录。

use semi_os_protocol::{Envelope, EnvelopeContext, RequestId};
use semi_os_storage::{
    MemoryActor, MemoryAuthor, MemoryBody, MemoryLayer, MemoryRecordKind, MemoryRelation,
    MemoryScope, MemorySourceKind, MemoryWriteCandidate, MemoryWriteConflict, MemoryWriteOutcome,
    NewMemorySource, Storage, StorageError,
};
use serde::Serialize;
use serde_json::{json, Value};

/// Host 回给 Worker 的候选处理结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidateResult {
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    pub status: MemoryCandidateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCandidateStatus {
    Accepted,
    Stored,
    Duplicate,
    Rejected,
}

/// 识别 Worker 提交的记忆候选；其他消息留给后续 router。
pub fn route_memory_candidate(message: &Envelope) -> Option<&Value> {
    match message {
        Envelope::Event { kind, payload, .. } if kind == "memory.candidate.submit" => Some(payload),
        _ => None,
    }
}

/// 校验并尝试落库。无论成败都返回结构化回执，调用方必须把它发给 Worker。
pub fn apply_memory_candidate(
    storage: &mut Storage,
    message: &Envelope,
    now: i64,
) -> MemoryCandidateResult {
    let Some(payload) = route_memory_candidate(message) else {
        return rejected(
            operation_id(message, &Value::Null),
            None,
            "unsupported_message",
        );
    };
    let operation_id = operation_id(message, payload);
    let memory_id = payload
        .get("memoryId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match persist_candidate(storage, payload, now) {
        Ok(outcome) => map_outcome(operation_id, outcome),
        Err(reason) => rejected(operation_id, memory_id, reason),
    }
}

/// 存储不可用时仍要给出明确拒绝，避免候选被丢弃。
pub fn unavailable_result(message: &Envelope, reason: &str) -> MemoryCandidateResult {
    let payload = route_memory_candidate(message)
        .cloned()
        .unwrap_or(Value::Null);
    rejected(
        operation_id(message, &payload),
        payload
            .get("memoryId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reason,
    )
}

/// Host → Worker 的回执请求，关联原来的 submit `requestId`。
pub fn result_envelope(request_id: RequestId, result: &MemoryCandidateResult) -> Envelope {
    Envelope::Request {
        protocol_version: 1,
        request_id,
        kind: "memory.candidate.result".into(),
        payload: serde_json::to_value(result).unwrap_or_else(|_| {
            json!({
                "operationId": result.operation_id,
                "status": "rejected",
                "reason": "invalid_result_payload"
            })
        }),
        context: EnvelopeContext {
            task_id: None,
            task_run_id: None,
            trace_id: None,
        },
    }
}

/// Desktop 路由挂载的入口：识别 submit、落库或拒绝，并组装回执信封。
/// 非候选消息返回 `None`，让后续 router 继续处理。
pub fn dispatch_memory_candidate(
    storage: Option<&mut Storage>,
    message: &Envelope,
    now: i64,
) -> Option<Envelope> {
    let Envelope::Event {
        kind, request_id, ..
    } = message
    else {
        return None;
    };
    if kind != "memory.candidate.submit" {
        return None;
    }
    let result = match storage {
        Some(storage) => apply_memory_candidate(storage, message, now),
        None => unavailable_result(message, "storage unavailable"),
    };
    Some(result_envelope(request_id.clone(), &result))
}

fn persist_candidate(
    storage: &mut Storage,
    payload: &Value,
    now: i64,
) -> Result<MemoryWriteOutcome, String> {
    if !payload.is_object() {
        return Err("invalid_payload".into());
    }
    let memory_id = required_string(payload, "memoryId")?;
    let record_kind = required_enum::<MemoryRecordKind>(payload, "recordKind")?;
    let layer = required_enum::<MemoryLayer>(payload, "layer")?;
    if !matches!(
        record_kind,
        MemoryRecordKind::Preference | MemoryRecordKind::ProjectFact
    ) {
        return Err(format!("unsupported_record_kind:{}", record_kind.as_str()));
    }
    if layer != record_kind.layer() {
        return Err(format!(
            "layer_mismatch: {} requires {}",
            record_kind.as_str(),
            record_kind.layer().as_str()
        ));
    }
    let content = required_object(payload, "content")?;
    let body: MemoryBody =
        serde_json::from_value(content.clone()).map_err(|_| "invalid_content".to_string())?;
    if body.kind() != record_kind {
        return Err("content_kind_mismatch".into());
    }
    let scope_value = required_object(payload, "scope")?;
    let scope: MemoryScope = serde_json::from_value(scope_value.clone())
        .map_err(|_| "invalid_field:scope".to_string())?;
    let confidence = required_score(payload, "confidence")?;
    let importance = required_score(payload, "importance")?;
    let source_refs = required_array(payload, "sourceRefs")?;
    if source_refs.is_empty() {
        return Err("empty_source_refs".into());
    }
    let origin = required_string(payload, "origin")?;
    if impersonates_user_origin(&origin) {
        return Err("impersonated_user_entry".into());
    }
    let sources = map_sources(&memory_id, source_refs, &origin)?;
    let conflict = parse_conflict(payload)?;

    let candidate = MemoryWriteCandidate {
        memory_id,
        body,
        scope,
        sources,
        confidence,
        importance,
        conflict,
    };
    if let Some(existing) = storage
        .load_memory(&candidate.memory_id)
        .map_err(map_storage_error)?
    {
        if existing.author == MemoryAuthor::Agent && existing.body == candidate.body {
            return Ok(MemoryWriteOutcome::Duplicate {
                existing_id: existing.memory_id,
            });
        }
        return Err("记忆编号已存在，自动写入不能覆盖已有行".into());
    }
    storage
        .write_memory(MemoryActor::Agent, &candidate, now)
        .map_err(map_storage_error)
}

fn map_outcome(operation_id: String, outcome: MemoryWriteOutcome) -> MemoryCandidateResult {
    match outcome {
        MemoryWriteOutcome::Stored { record, .. } => MemoryCandidateResult {
            operation_id,
            memory_id: Some(record.memory_id.clone()),
            status: MemoryCandidateStatus::Stored,
            reason: None,
            existing_id: None,
        },
        MemoryWriteOutcome::Duplicate { existing_id } => MemoryCandidateResult {
            operation_id,
            memory_id: Some(existing_id.clone()),
            status: MemoryCandidateStatus::Duplicate,
            reason: None,
            existing_id: Some(existing_id),
        },
        MemoryWriteOutcome::Rejected(rejection) => MemoryCandidateResult {
            operation_id,
            memory_id: None,
            status: MemoryCandidateStatus::Rejected,
            reason: Some(rejection.as_str().into()),
            existing_id: None,
        },
    }
}

fn map_sources(
    memory_id: &str,
    refs: &[Value],
    origin: &str,
) -> Result<Vec<NewMemorySource>, String> {
    refs.iter()
        .enumerate()
        .map(|(index, item)| {
            if !item.is_object() {
                return Err("invalid_field:sourceRefs".into());
            }
            let source_ref = item
                .get("sourceRef")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "invalid_field:sourceRefs".to_string())?
                .to_owned();
            let source_id = item
                .get("sourceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("src_{memory_id}_{}", index + 1));
            let kind = item
                .get("kind")
                .and_then(Value::as_str)
                .map(|value| {
                    serde_json::from_value::<MemorySourceKind>(Value::String(value.to_owned()))
                        .map_err(|_| "invalid_enum:sourceRefs.kind".to_string())
                })
                .transpose()?
                .unwrap_or(MemorySourceKind::ConversationTurn);
            if kind == MemorySourceKind::UserEntry {
                return Err("impersonated_user_entry".into());
            }
            let note = source_note(item.get("note").and_then(Value::as_str), origin);
            Ok(NewMemorySource {
                source_id,
                kind,
                source_ref,
                note,
            })
        })
        .collect()
}

fn impersonates_user_origin(origin: &str) -> bool {
    let normalized = origin.trim().to_ascii_lowercase().replace('-', "_");
    matches!(normalized.as_str(), "user_entry" | "user" | "userentry")
}

fn source_note(note: Option<&str>, origin: &str) -> Option<String> {
    let origin_mark = format!("origin={origin}");
    match note.map(str::trim).filter(|value| !value.is_empty()) {
        Some(note) if note.contains(&origin_mark) => Some(note.to_owned()),
        Some(note) => Some(format!("{note}; {origin_mark}")),
        None => Some(origin_mark),
    }
}

fn parse_conflict(payload: &Value) -> Result<Option<MemoryWriteConflict>, String> {
    match payload.get("conflictTarget") {
        None => Err("missing_field:conflictTarget".into()),
        Some(Value::Null) => Ok(None),
        Some(value) if value.is_object() => {
            let target_memory_id = required_string(value, "targetMemoryId")?;
            let relation = match value.get("relation") {
                None | Some(Value::Null) => MemoryRelation::Contradicts,
                Some(item) => serde_json::from_value::<MemoryRelation>(item.clone())
                    .map_err(|_| "invalid_enum:conflictTarget.relation".to_string())?,
            };
            Ok(Some(MemoryWriteConflict {
                target_memory_id,
                relation,
            }))
        }
        Some(_) => Err("invalid_field:conflictTarget".into()),
    }
}

fn map_storage_error(error: StorageError) -> String {
    match error {
        StorageError::InvalidMemory(message) => message,
        StorageError::MemoryNotFound(_) => "conflict_target_not_found".into(),
        StorageError::OwnershipDenied { .. } => "ownership_denied".into(),
        StorageError::InvalidEnum { kind, value } => format!("invalid_enum:{kind}:{value}"),
        _ => "storage_error".into(),
    }
}

fn operation_id(message: &Envelope, payload: &Value) -> String {
    if let Some(operation_id) = payload
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return operation_id.to_owned();
    }
    match message {
        Envelope::Event { request_id, .. }
        | Envelope::Request { request_id, .. }
        | Envelope::Response { request_id, .. }
        | Envelope::Error { request_id, .. } => request_id.0.clone(),
    }
}

fn rejected(
    operation_id: String,
    memory_id: Option<String>,
    reason: impl Into<String>,
) -> MemoryCandidateResult {
    MemoryCandidateResult {
        operation_id,
        memory_id,
        status: MemoryCandidateStatus::Rejected,
        reason: Some(reason.into()),
        existing_id: None,
    }
}

fn required_string(payload: &Value, field: &str) -> Result<String, String> {
    match payload.get(field) {
        None => Err(format!("missing_field:{field}")),
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        Some(_) => Err(format!("invalid_field:{field}")),
    }
}

fn required_object<'a>(payload: &'a Value, field: &str) -> Result<&'a Value, String> {
    match payload.get(field) {
        None => Err(format!("missing_field:{field}")),
        Some(value) if value.is_object() => Ok(value),
        Some(_) => Err(format!("invalid_field:{field}")),
    }
}

fn required_array<'a>(payload: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    match payload.get(field) {
        None => Err(format!("missing_field:{field}")),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(format!("invalid_field:{field}")),
    }
}

fn required_score(payload: &Value, field: &str) -> Result<u8, String> {
    match payload.get(field) {
        None => Err(format!("missing_field:{field}")),
        Some(value) => value
            .as_u64()
            .and_then(|score| u8::try_from(score).ok())
            .filter(|score| *score <= 100)
            .ok_or_else(|| format!("invalid_field:{field}")),
    }
}

fn required_enum<T>(payload: &Value, field: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    match payload.get(field) {
        None => Err(format!("missing_field:{field}")),
        Some(value) => {
            serde_json::from_value::<T>(value.clone()).map_err(|_| format!("invalid_enum:{field}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semi_os_storage::{MemoryAuthor, MemoryMutability, NewMemory, Storage};

    fn event(payload: Value) -> Envelope {
        Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_memory_candidate".into()),
            kind: "memory.candidate.submit".into(),
            payload,
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        }
    }

    fn preference_payload() -> Value {
        json!({
            "operationId": "req_memory_pref_1",
            "memoryId": "mem_pref_editor",
            "recordKind": "preference",
            "layer": "L2",
            "content": { "kind": "preference", "key": "editor", "value": "use rustfmt" },
            "scope": { "userId": "user_eval", "workspaceId": "repo_eval" },
            "confidence": 90,
            "importance": 70,
            "sourceRefs": [{ "sourceRef": "turn_pref_1", "kind": "conversation_turn" }],
            "conflictTarget": null,
            "origin": "conversation_turn"
        })
    }

    #[test]
    fn stores_valid_preference_candidate_and_allows_query() {
        let mut storage = Storage::open_in_memory().unwrap();
        let result = apply_memory_candidate(&mut storage, &event(preference_payload()), 10);
        assert_eq!(result.status, MemoryCandidateStatus::Stored);
        assert_eq!(result.memory_id.as_deref(), Some("mem_pref_editor"));
        let record = storage
            .load_memory("mem_pref_editor")
            .unwrap()
            .expect("stored candidate should be queryable");
        assert_eq!(record.record_kind, MemoryRecordKind::Preference);
        assert_eq!(record.layer, MemoryLayer::L2);
        assert_eq!(record.author, MemoryAuthor::Agent);
        assert_eq!(
            record.body,
            MemoryBody::Preference {
                key: "editor".into(),
                value: "use rustfmt".into(),
            }
        );
        let sources = storage.list_memory_sources("mem_pref_editor").unwrap();
        assert!(sources.iter().any(|source| {
            source.source_ref == "turn_pref_1"
                && source
                    .note
                    .as_deref()
                    .is_some_and(|note| note.contains("origin=conversation_turn"))
        }));
    }

    #[test]
    fn stores_project_fact_from_worker_shaped_payload() {
        let mut storage = Storage::open_in_memory().unwrap();
        let payload = json!({
            "operationId": "req_memory_fact_1",
            "memoryId": "mem_fact_bakery",
            "recordKind": "project_fact",
            "layer": "L2",
            "content": { "kind": "project_fact", "fact": "面包房清晨出炉 sourdough" },
            "scope": { "userId": "user_eval", "workspaceId": "repo_eval" },
            "confidence": 80,
            "importance": 60,
            "sourceRefs": [{ "sourceRef": "turn_fact_1" }],
            "conflictTarget": null,
            "origin": "conversation_turn"
        });
        let result = apply_memory_candidate(&mut storage, &event(payload), 11);
        assert_eq!(result.status, MemoryCandidateStatus::Stored);
        assert!(storage.load_memory("mem_fact_bakery").unwrap().is_some());
    }

    #[test]
    fn rejects_missing_and_illegal_fields_without_writing() {
        let mut storage = Storage::open_in_memory().unwrap();
        let mut missing = preference_payload();
        missing.as_object_mut().unwrap().remove("origin");
        let result = apply_memory_candidate(&mut storage, &event(missing), 12);
        assert_eq!(result.status, MemoryCandidateStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("missing_field:origin"));
        assert!(storage.load_memory("mem_pref_editor").unwrap().is_none());

        let mut bad_kind = preference_payload();
        bad_kind["recordKind"] = json!("future_kind");
        let result = apply_memory_candidate(&mut storage, &event(bad_kind), 13);
        assert_eq!(result.reason.as_deref(), Some("invalid_enum:recordKind"));

        let mut mismatch = preference_payload();
        mismatch["layer"] = json!("L3");
        let result = apply_memory_candidate(&mut storage, &event(mismatch), 14);
        assert!(result
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("layer_mismatch")));

        let mut string_content = preference_payload();
        string_content["content"] = json!("just a string");
        let result = apply_memory_candidate(&mut storage, &event(string_content), 15);
        assert_eq!(result.reason.as_deref(), Some("invalid_field:content"));

        let mut empty_sources = preference_payload();
        empty_sources["sourceRefs"] = json!([]);
        let result = apply_memory_candidate(&mut storage, &event(empty_sources), 16);
        assert_eq!(result.reason.as_deref(), Some("empty_source_refs"));

        let mut missing_conflict = preference_payload();
        missing_conflict
            .as_object_mut()
            .unwrap()
            .remove("conflictTarget");
        let result = apply_memory_candidate(&mut storage, &event(missing_conflict), 17);
        assert_eq!(
            result.reason.as_deref(),
            Some("missing_field:conflictTarget")
        );
    }

    #[test]
    fn agent_candidate_cannot_overwrite_user_preference() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage
            .create_memory(
                MemoryActor::User,
                &NewMemory {
                    memory_id: "pref_font".into(),
                    body: MemoryBody::Preference {
                        key: "font".into(),
                        value: "serif".into(),
                    },
                    scope: MemoryScope {
                        user_id: Some("user_eval".into()),
                        workspace_id: Some("repo_eval".into()),
                        ..MemoryScope::default()
                    },
                    sources: vec![NewMemorySource {
                        source_id: "src_pref_font".into(),
                        kind: MemorySourceKind::UserEntry,
                        source_ref: "client-preference".into(),
                        note: None,
                    }],
                },
                20,
            )
            .unwrap();
        let user_before = storage.load_memory("pref_font").unwrap().unwrap();
        assert_eq!(user_before.author, MemoryAuthor::User);
        assert_eq!(user_before.mutability, MemoryMutability::UserReadonly);

        let mut same_id = preference_payload();
        same_id["memoryId"] = json!("pref_font");
        same_id["content"] = json!({ "kind": "preference", "key": "font", "value": "sans" });
        let overwrite = apply_memory_candidate(&mut storage, &event(same_id), 21);
        assert_eq!(overwrite.status, MemoryCandidateStatus::Rejected);
        assert!(overwrite
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("不能覆盖")));
        assert_eq!(
            storage.load_memory("pref_font").unwrap().unwrap(),
            user_before
        );

        let mut correction = preference_payload();
        correction["memoryId"] = json!("pref_font_agent");
        correction["content"] = json!({ "kind": "preference", "key": "font", "value": "sans" });
        let stored = apply_memory_candidate(&mut storage, &event(correction), 22);
        assert_eq!(stored.status, MemoryCandidateStatus::Stored);
        assert_eq!(stored.memory_id.as_deref(), Some("pref_font_agent"));
        let user_after = storage.load_memory("pref_font").unwrap().unwrap();
        assert_eq!(user_after, user_before);
        let agent = storage.load_memory("pref_font_agent").unwrap().unwrap();
        assert_eq!(agent.author, MemoryAuthor::Agent);
        assert_eq!(
            agent.body,
            MemoryBody::Preference {
                key: "font".into(),
                value: "sans".into(),
            }
        );
    }

    #[test]
    fn rejects_non_whitelisted_kinds_including_skill_candidates() {
        let mut storage = Storage::open_in_memory().unwrap();
        for (record_kind, layer, content) in [
            (
                "skill_candidate",
                "L5",
                json!({ "kind": "skill_candidate", "name": "search", "summary": "自动晋升" }),
            ),
            (
                "workflow_candidate",
                "L5",
                json!({ "kind": "workflow_candidate", "name": "review", "summary": "候选工作流" }),
            ),
            (
                "task_summary",
                "L3",
                json!({ "kind": "task_summary", "summary": "本不应写入" }),
            ),
        ] {
            let mut payload = preference_payload();
            payload["memoryId"] = json!(format!("mem_{record_kind}"));
            payload["recordKind"] = json!(record_kind);
            payload["layer"] = json!(layer);
            payload["content"] = content;
            let result = apply_memory_candidate(&mut storage, &event(payload), 18);
            assert_eq!(result.status, MemoryCandidateStatus::Rejected);
            let expected = format!("unsupported_record_kind:{record_kind}");
            assert_eq!(result.reason.as_deref(), Some(expected.as_str()));
            assert!(storage
                .load_memory(&format!("mem_{record_kind}"))
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn rejects_origin_impersonating_user_entry_without_writing() {
        let mut storage = Storage::open_in_memory().unwrap();
        for origin in ["user_entry", "user", "User-Entry"] {
            let mut payload = preference_payload();
            payload["memoryId"] = json!(format!("mem_impersonate_{origin}"));
            payload["origin"] = json!(origin);
            let result = apply_memory_candidate(&mut storage, &event(payload), 19);
            assert_eq!(result.status, MemoryCandidateStatus::Rejected);
            assert_eq!(result.reason.as_deref(), Some("impersonated_user_entry"));
            assert!(storage
                .load_memory(&format!("mem_impersonate_{origin}"))
                .unwrap()
                .is_none());
        }

        let mut via_source = preference_payload();
        via_source["memoryId"] = json!("mem_impersonate_source");
        via_source["sourceRefs"] = json!([{
            "sourceRef": "client-preference",
            "kind": "user_entry"
        }]);
        let result = apply_memory_candidate(&mut storage, &event(via_source), 19);
        assert_eq!(result.status, MemoryCandidateStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("impersonated_user_entry"));
        assert!(storage
            .load_memory("mem_impersonate_source")
            .unwrap()
            .is_none());
    }

    #[test]
    fn replay_of_stored_memory_id_returns_existing_receipt() {
        let mut storage = Storage::open_in_memory().unwrap();
        let payload = preference_payload();
        let first = apply_memory_candidate(&mut storage, &event(payload.clone()), 23);
        assert_eq!(first.status, MemoryCandidateStatus::Stored);
        let replay = apply_memory_candidate(&mut storage, &event(payload), 24);
        assert_eq!(replay.status, MemoryCandidateStatus::Duplicate);
        assert_eq!(replay.memory_id.as_deref(), Some("mem_pref_editor"));
        assert_eq!(replay.existing_id.as_deref(), Some("mem_pref_editor"));
        assert!(storage.load_memory("mem_pref_editor").unwrap().is_some());
    }

    #[test]
    fn dispatch_mount_stores_valid_submit_and_rejects_invalid() {
        let mut storage = Storage::open_in_memory().unwrap();
        let submit = event(preference_payload());
        let reply = dispatch_memory_candidate(Some(&mut storage), &submit, 30)
            .expect("desktop router should mount memory.candidate.submit");
        let Envelope::Request {
            kind,
            payload,
            request_id,
            ..
        } = reply
        else {
            panic!("dispatch should return a Host-to-Worker result request");
        };
        assert_eq!(kind, "memory.candidate.result");
        assert_eq!(request_id.0, "req_memory_candidate");
        assert_eq!(payload["status"], "stored");
        assert_eq!(payload["memoryId"], "mem_pref_editor");
        assert!(storage.load_memory("mem_pref_editor").unwrap().is_some());
        semi_os_protocol::validate_envelope(&Envelope::Request {
            protocol_version: 1,
            request_id: request_id.clone(),
            kind,
            payload: payload.clone(),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        })
        .expect("mounted result should be protocol-valid");

        let mut invalid = preference_payload();
        invalid["memoryId"] = json!("mem_skill_denied");
        invalid["recordKind"] = json!("skill_candidate");
        invalid["layer"] = json!("L5");
        invalid["content"] =
            json!({ "kind": "skill_candidate", "name": "search", "summary": "自动晋升" });
        let reply = dispatch_memory_candidate(Some(&mut storage), &event(invalid), 31)
            .expect("invalid submit still goes through the mounted router");
        let Envelope::Request { payload, .. } = reply else {
            panic!("dispatch should return a result request");
        };
        assert_eq!(payload["status"], "rejected");
        assert_eq!(payload["reason"], "unsupported_record_kind:skill_candidate");
        assert!(storage.load_memory("mem_skill_denied").unwrap().is_none());

        let unrelated = Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_other".into()),
            kind: "workflow.request".into(),
            payload: json!({"operation": "list"}),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert!(dispatch_memory_candidate(Some(&mut storage), &unrelated, 32).is_none());
    }

    #[test]
    fn result_envelope_is_protocol_valid() {
        let result = MemoryCandidateResult {
            operation_id: "req_memory_pref_1".into(),
            memory_id: Some("mem_pref_editor".into()),
            status: MemoryCandidateStatus::Stored,
            reason: None,
            existing_id: None,
        };
        let envelope = result_envelope(RequestId("req_memory_candidate".into()), &result);
        semi_os_protocol::validate_envelope(&envelope).expect("result should match protocol");
    }
}
