//! 用户明确纠正的确定性识别与写入。
//!
//! 本模块不调用模型，也不改 Pi Agent Loop。它在 Host 收到用户原文之后、
//! 组装下一轮记忆包之前运行：匹配「以后」「记住」「不是 X，是 Y」等规则，
//! 以用户身份调用 [`semi_os_storage::Storage::write_memory`]，旧记录保留，
//! 并用 supersedes（必要时补充 contradicts）指向被替换的版本。
//! 这样 `load_memory_pack` 会优先有效版本，冲突不会同时进入提示词。

use crate::memory_controls::CLIENT_USER_ID;
use semi_os_protocol::Envelope;
use semi_os_storage::{
    MemoryActor, MemoryAuthor, MemoryBody, MemoryLink, MemoryQuery, MemoryRecord, MemoryRelation,
    MemoryScope, MemorySourceKind, MemoryWriteCandidate, MemoryWriteConflict, MemoryWriteOutcome,
    MemoryWriteRejection, NewMemoryLink, NewMemorySource, Storage, StorageResult,
};
use serde_json::Value;

const USER_CONFIDENCE: u8 = 100;
const USER_IMPORTANCE: u8 = 90;

/// 从用户原文里解析出的结构化纠正。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecognizedCorrection {
    pub body: MemoryBody,
    /// 「不是 X，是 Y」里的 X，用来匹配要替换的旧记录。
    pub dismissed: Option<String>,
}

/// 纠正写入结果。未识别到明确纠正时是 [`CorrectionOutcome::Ignored`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CorrectionOutcome {
    Ignored,
    Stored {
        memory_id: String,
        author: MemoryAuthor,
        link: Option<MemoryLink>,
        extra_links: Vec<MemoryLink>,
    },
    Duplicate {
        existing_id: String,
    },
    Rejected(MemoryWriteRejection),
}

/// 确定性规则：只在用户明确要求记住、今后照做，或给出「不是 X，是 Y」时写入。
pub fn recognize_explicit_correction(text: &str) -> Option<RecognizedCorrection> {
    let normalized = normalize_utterance(text);
    if normalized.is_empty() {
        return None;
    }
    let replacement = parse_replacement(&normalized);
    let remember = has_remember_marker(&normalized);
    let future = has_future_marker(&normalized);
    if replacement.is_none() && !remember && !future {
        return None;
    }

    if let Some((old, new_value)) = replacement.as_ref() {
        if let Some(body) =
            extract_known_preference(new_value).or_else(|| extract_known_preference(&normalized))
        {
            return Some(RecognizedCorrection {
                body,
                dismissed: Some(old.clone()),
            });
        }
        let fact = trim_clause(new_value);
        if !fact.is_empty() {
            return Some(RecognizedCorrection {
                body: MemoryBody::ProjectFact { fact },
                dismissed: Some(old.clone()),
            });
        }
    }

    if let Some(body) = extract_known_preference(&normalized) {
        return Some(RecognizedCorrection {
            body,
            dismissed: None,
        });
    }

    if remember {
        if let Some(clause) = remember_clause(&normalized) {
            if let Some(body) = extract_known_preference(&clause) {
                return Some(RecognizedCorrection {
                    body,
                    dismissed: None,
                });
            }
            if !clause.is_empty() {
                return Some(RecognizedCorrection {
                    body: MemoryBody::ProjectFact { fact: clause },
                    dismissed: None,
                });
            }
        }
    }

    None
}

/// 识别用户原文并按用户作者写入。不是明确纠正时返回 [`CorrectionOutcome::Ignored`]。
pub fn apply_explicit_correction(
    storage: &mut Storage,
    text: &str,
    source_ref: &str,
    now: i64,
) -> StorageResult<CorrectionOutcome> {
    let Some(recognized) = recognize_explicit_correction(text) else {
        return Ok(CorrectionOutcome::Ignored);
    };
    persist_correction(storage, recognized, source_ref, now)
}

/// 从用户轮次信封取出原文并尝试写入。只处理 `voice.text.submit` 与
/// `voice.transcript.final`，避免在音频分片或首句合成路径上做额外工作。
pub fn apply_turn_explicit_corrections(
    storage: &mut Storage,
    envelope: &Envelope,
    now: i64,
) -> StorageResult<bool> {
    let Some(text) = turn_text(envelope) else {
        return Ok(false);
    };
    match apply_explicit_correction(storage, text, &turn_source_ref(envelope), now)? {
        CorrectionOutcome::Ignored | CorrectionOutcome::Rejected(_) => Ok(false),
        CorrectionOutcome::Stored { .. } | CorrectionOutcome::Duplicate { .. } => Ok(true),
    }
}

fn persist_correction(
    storage: &mut Storage,
    recognized: RecognizedCorrection,
    source_ref: &str,
    now: i64,
) -> StorageResult<CorrectionOutcome> {
    let memory_id = allocate_correction_id(storage, now)?;
    let scope = MemoryScope {
        user_id: Some(CLIENT_USER_ID.to_owned()),
        ..MemoryScope::default()
    };
    let (conflict, extras) =
        find_conflict_targets(storage, &recognized.body, recognized.dismissed.as_deref())?;
    let candidate = MemoryWriteCandidate {
        memory_id: memory_id.clone(),
        body: recognized.body,
        scope,
        sources: vec![NewMemorySource {
            source_id: format!("src_{memory_id}"),
            kind: MemorySourceKind::UserEntry,
            source_ref: source_ref.trim().to_owned(),
            note: Some("origin=explicit_correction".into()),
        }],
        confidence: USER_CONFIDENCE,
        importance: USER_IMPORTANCE,
        conflict,
    };
    match storage.write_memory(MemoryActor::User, &candidate, now)? {
        MemoryWriteOutcome::Stored { record, link } => {
            let extra_links =
                link_remaining(storage, &record.memory_id, link.as_ref(), &extras, now)?;
            Ok(CorrectionOutcome::Stored {
                memory_id: record.memory_id,
                author: record.author,
                link,
                extra_links,
            })
        }
        MemoryWriteOutcome::Duplicate { existing_id } => {
            Ok(CorrectionOutcome::Duplicate { existing_id })
        }
        MemoryWriteOutcome::Rejected(rejection) => Ok(CorrectionOutcome::Rejected(rejection)),
    }
}

fn link_remaining(
    storage: &mut Storage,
    from_memory_id: &str,
    primary: Option<&MemoryLink>,
    extras: &[(String, MemoryRelation)],
    now: i64,
) -> StorageResult<Vec<MemoryLink>> {
    let mut links = Vec::new();
    for (index, (target_id, relation)) in extras.iter().enumerate() {
        if primary.is_some_and(|link| link.to_memory_id == *target_id && link.relation == *relation)
        {
            continue;
        }
        let created = storage.link_memories(
            MemoryActor::User,
            &NewMemoryLink {
                link_id: format!("ln_corr_{now}_{}", index + 1),
                from_memory_id: from_memory_id.to_owned(),
                to_memory_id: target_id.clone(),
                relation: *relation,
            },
            now,
        )?;
        links.push(created);
    }
    Ok(links)
}

type ConflictPlan = (Option<MemoryWriteConflict>, Vec<(String, MemoryRelation)>);

fn find_conflict_targets(
    storage: &Storage,
    body: &MemoryBody,
    dismissed: Option<&str>,
) -> StorageResult<ConflictPlan> {
    let records = storage.list_memories(&MemoryQuery {
        user_id: Some(CLIENT_USER_ID.to_owned()),
        ..MemoryQuery::default()
    })?;
    let superseded = superseded_ids(storage, &records)?;
    let mut matched = Vec::new();
    for record in &records {
        if superseded.contains(&record.memory_id) {
            continue;
        }
        if !in_local_scope(record) {
            continue;
        }
        if same_body(record, body) {
            continue;
        }
        if should_replace(record, body, dismissed) {
            matched.push(record);
        }
    }
    matched.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then(left.memory_id.cmp(&right.memory_id))
    });
    let extras = matched
        .iter()
        .map(|record| (record.memory_id.clone(), relation_for(body, record)))
        .collect::<Vec<_>>();
    let conflict = extras
        .first()
        .map(|(target, relation)| MemoryWriteConflict {
            target_memory_id: target.clone(),
            relation: *relation,
        });
    Ok((conflict, extras.into_iter().skip(1).collect()))
}

fn relation_for(body: &MemoryBody, record: &MemoryRecord) -> MemoryRelation {
    let both_preferences = preference_key(body).is_some() && preference_key(&record.body).is_some();
    let both_facts = matches!(body, MemoryBody::ProjectFact { .. })
        && matches!(record.body, MemoryBody::ProjectFact { .. });
    let dismissed_old =
        dismissed_match(&record.body, &preference_value(body).unwrap_or_default()).is_some();
    if both_preferences || both_facts || dismissed_old {
        MemoryRelation::Supersedes
    } else {
        MemoryRelation::Contradicts
    }
}

fn should_replace(record: &MemoryRecord, body: &MemoryBody, dismissed: Option<&str>) -> bool {
    if let (Some(new_key), Some(old_key)) = (preference_key(body), preference_key(&record.body)) {
        if new_key == old_key {
            return true;
        }
        if semantic_opposites(
            preference_value(body).as_deref(),
            preference_value(&record.body).as_deref(),
        ) {
            return true;
        }
    }
    if let Some(old) = dismissed {
        if text_contains(&render_simple(&record.body), old)
            || preference_value(&record.body).is_some_and(|value| text_contains(&value, old))
        {
            return true;
        }
    }
    if let Some(new_value) = preference_value(body) {
        if semantic_opposites(Some(&new_value), preference_value(&record.body).as_deref()) {
            return true;
        }
    }
    false
}

fn superseded_ids(
    storage: &Storage,
    records: &[MemoryRecord],
) -> StorageResult<std::collections::HashSet<String>> {
    let mut ids = std::collections::HashSet::new();
    for record in records {
        for link in storage.list_memory_links(&record.memory_id)? {
            if link.relation == MemoryRelation::Supersedes {
                ids.insert(link.to_memory_id);
            }
        }
    }
    Ok(ids)
}

fn in_local_scope(record: &MemoryRecord) -> bool {
    record.scope.user_id.as_deref() == Some(CLIENT_USER_ID)
}

fn same_body(record: &MemoryRecord, body: &MemoryBody) -> bool {
    render_simple(&record.body).eq_ignore_ascii_case(&render_simple(body))
}

fn allocate_correction_id(storage: &Storage, now: i64) -> StorageResult<String> {
    for seq in 0..32 {
        let memory_id = if seq == 0 {
            format!("corr_{now}")
        } else {
            format!("corr_{now}_{seq}")
        };
        if storage.load_memory(&memory_id)?.is_none() {
            return Ok(memory_id);
        }
    }
    Err(semi_os_storage::StorageError::InvalidMemory(
        "纠正编号暂时不可用".into(),
    ))
}

fn turn_text(envelope: &Envelope) -> Option<&str> {
    match envelope {
        Envelope::Request { kind, payload, .. } if kind == "voice.text.submit" => {
            payload.get("text").and_then(Value::as_str)
        }
        Envelope::Event { kind, payload, .. } if kind == "voice.transcript.final" => {
            payload.get("text").and_then(Value::as_str)
        }
        _ => None,
    }
}

fn turn_source_ref(envelope: &Envelope) -> String {
    match envelope {
        Envelope::Request {
            request_id,
            payload,
            ..
        }
        | Envelope::Event {
            request_id,
            payload,
            ..
        } => payload
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|session| format!("turn_{session}"))
            .unwrap_or_else(|| format!("turn_{}", request_id.0)),
        Envelope::Response { request_id, .. } | Envelope::Error { request_id, .. } => {
            format!("turn_{}", request_id.0)
        }
    }
}

fn normalize_utterance(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim()
        .trim_end_matches(['。', '！', '？', '.', '!', '?', '；', ';'])
        .to_owned()
}

fn has_future_marker(text: &str) -> bool {
    const MARKERS: &[&str] = &[
        "以后都这样",
        "以后都",
        "以后",
        "今后",
        "从现在开始",
        "从今往后",
        "之后都",
        "from now on",
        "going forward",
        "always",
    ];
    contains_marker(text, MARKERS)
}

fn has_remember_marker(text: &str) -> bool {
    // 只接受「请记住 / 帮我记住 / 记住：」等明确指令形态，避免句中或句首随意
    // 出现「记住」就把普通陈述误判成要落库的纠正，进而写成 ProjectFact。
    const MARKERS: &[&str] = &[
        "请记住",
        "帮我记住",
        "给我记住",
        "记住：",
        "记住:",
        "please remember",
        "remember that",
        "remember:",
    ];
    contains_marker(text, MARKERS)
}

fn remember_clause(text: &str) -> Option<String> {
    // 与 [`has_remember_marker`] 保持同一组明确指令前缀，不做裸「记住 / remember」
    // 前缀提取，否则普通陈述会被截成事实正文。
    const PREFIXES: &[&str] = &[
        "请记住",
        "帮我记住",
        "给我记住",
        "记住：",
        "记住:",
        "please remember",
        "remember that",
        "remember:",
    ];
    let lower = text.to_lowercase();
    for prefix in PREFIXES {
        if let Some(index) = find_prefix(text, &lower, prefix) {
            // `find_prefix` 返回字节下标，这里必须用 `prefix.len()` 的字节长度截取，
            // 否则中文前缀（例如「请记住」）会从中间字节开始，把「记住」留在正文里。
            let clause = trim_clause(&text[index + prefix.len()..]);
            if !clause.is_empty() {
                return Some(clause);
            }
        }
    }
    None
}

fn parse_replacement(text: &str) -> Option<(String, String)> {
    if let Some(pair) = text.split_once("而是") {
        if pair.0.contains("不是") {
            return replacement_parts(pair.0, pair.1);
        }
    }
    if let Some(pair) = split_once_any(text, &["，是", ",是", ", 是", "， 是"]) {
        if pair.0.contains("不是") {
            return replacement_parts(pair.0, pair.1);
        }
    }
    if let Some(rest) = strip_prefix_ci(text, "不是") {
        if let Some((old, new_value)) = rest.split_once('是') {
            return replacement_parts(old, new_value);
        }
    }
    for (left, right) in [
        ("it's not ", ", it's "),
        ("it's not ", ", it is "),
        ("it's not ", ", but "),
        ("it is not ", ", it's "),
        ("it is not ", ", it is "),
        ("not ", ", it's "),
        ("not ", ", it is "),
        ("not ", ", but "),
    ] {
        if let Some(rest) = strip_prefix_ci(text, left) {
            if let Some((old, new_value)) = split_once_str_ci(rest, right) {
                return replacement_parts(&old, &new_value);
            }
        }
    }
    None
}

fn replacement_parts(old: &str, new_value: &str) -> Option<(String, String)> {
    let old = trim_clause(old.trim_start_matches(['，', ',', ':', '：']));
    let old = trim_clause(old.trim_start_matches("不是"));
    let new_value = trim_clause(new_value);
    if old.is_empty() || new_value.is_empty() || old.eq_ignore_ascii_case(&new_value) {
        return None;
    }
    Some((old, new_value))
}

fn extract_known_preference(text: &str) -> Option<MemoryBody> {
    if let Some(value) = extract_verbosity(text) {
        return Some(preference("详略", value));
    }
    if let Some(value) = extract_tone(text) {
        return Some(preference("语气", value));
    }
    if let Some(value) = extract_language(text) {
        return Some(preference("语言", value));
    }
    None
}

fn extract_verbosity(text: &str) -> Option<&'static str> {
    const SHORT: &[&str] = &[
        "简短回答",
        "简要回答",
        "简洁回答",
        "回答简短",
        "简短一点",
        "简短些",
        "短一点",
        "少说点",
        "说短点",
        "说简洁",
        "用简短",
        "要简短",
        "请简短",
        "be concise",
        "be brief",
        "short answer",
        "short answers",
        "shorter answer",
        "keep it short",
        "brief answers",
    ];
    const LONG: &[&str] = &[
        "详细回答",
        "详尽回答",
        "回答详细",
        "讲详细",
        "说详细",
        "详细一点",
        "详细些",
        "多说点",
        "展开说",
        "用详细",
        "要详细",
        "请详细",
        "be detailed",
        "more detail",
        "more details",
        "verbose",
        "longer answer",
        "long answers",
    ];
    if mentions_positive(text, SHORT) {
        return Some("简短");
    }
    if mentions_positive(text, LONG) {
        return Some("详细");
    }
    if contains_marker(text, &["简短", "简要", "简洁", "concise", "brief"])
        && !negated(text, &["简短", "简要", "简洁", "concise", "brief"])
        && (has_future_marker(text) || has_remember_marker(text) || text.contains("回答"))
    {
        return Some("简短");
    }
    if contains_marker(text, &["详细", "详尽", "detailed", "verbose"])
        && !negated(text, &["详细", "详尽", "detailed", "verbose"])
        && (has_future_marker(text) || has_remember_marker(text) || text.contains("回答"))
    {
        return Some("详细");
    }
    match text.trim() {
        "简短" | "简要" | "简洁" | "concise" | "brief" | "short" => Some("简短"),
        "详细" | "详尽" | "detailed" | "verbose" | "long" => Some("详细"),
        _ => None,
    }
}

fn extract_tone(text: &str) -> Option<String> {
    const TONES: &[&str] = &["活泼", "正式", "平静", "幽默", "严肃", "轻松", "温和"];
    if let Some(value) = capture_after(text, &["语气要", "语气用", "语气是", "语气"]) {
        let value = trim_clause(&value);
        if !value.is_empty() {
            return Some(value);
        }
    }
    for tone in TONES {
        if text.contains(&format!("用{tone}"))
            || text.contains(&format!("{tone}的语气"))
            || text.contains(&format!("语气{tone}"))
        {
            return Some((*tone).to_owned());
        }
    }
    None
}

fn extract_language(text: &str) -> Option<&'static str> {
    if contains_marker(text, &["简体中文", "简体"]) {
        return Some("简体中文");
    }
    if contains_marker(text, &["繁体中文", "繁体"]) {
        return Some("繁体中文");
    }
    if contains_marker(
        text,
        &[
            "用中文",
            "说中文",
            "中文回答",
            "speak chinese",
            "in chinese",
        ],
    ) {
        return Some("中文");
    }
    if contains_marker(
        text,
        &[
            "用英文",
            "用英语",
            "说英文",
            "说英语",
            "英文回答",
            "speak english",
            "in english",
        ],
    ) {
        return Some("英文");
    }
    None
}

fn preference(key: &str, value: impl Into<String>) -> MemoryBody {
    MemoryBody::Preference {
        key: key.to_owned(),
        value: value.into(),
    }
}

fn preference_key(body: &MemoryBody) -> Option<String> {
    match body {
        MemoryBody::Preference { key, .. } => Some(key.trim().to_lowercase()),
        _ => None,
    }
}

fn preference_value(body: &MemoryBody) -> Option<String> {
    match body {
        MemoryBody::Preference { value, .. } => Some(value.clone()),
        _ => None,
    }
}

fn render_simple(body: &MemoryBody) -> String {
    match body {
        MemoryBody::Preference { key, value } => format!("{key} {value}"),
        MemoryBody::ProjectFact { fact } | MemoryBody::Profile { fact } => fact.clone(),
        _ => String::new(),
    }
}

fn semantic_opposites(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            verbosity_group(left) != 0
                && verbosity_group(right) != 0
                && verbosity_group(left) != verbosity_group(right)
        }
        _ => false,
    }
}

fn verbosity_group(value: &str) -> u8 {
    let text = value.to_lowercase();
    if contains_marker(
        &text,
        &["简短", "简要", "简洁", "concise", "brief", "short"],
    ) {
        1
    } else if contains_marker(
        &text,
        &["详细", "详尽", "很长", "detailed", "verbose", "long"],
    ) {
        2
    } else {
        0
    }
}

fn mentions_positive(text: &str, needles: &[&str]) -> bool {
    needles
        .iter()
        .any(|needle| contains_marker(text, &[needle]) && !negated(text, &[needle]))
}

fn negated(text: &str, values: &[&str]) -> bool {
    const NEG: &[&str] = &[
        "不要",
        "别再",
        "别",
        "不用",
        "不要用",
        "don't ",
        "do not ",
        "never ",
    ];
    let lower = text.to_lowercase();
    values.iter().any(|value| {
        let value_l = value.to_lowercase();
        NEG.iter().any(|neg| {
            lower.contains(&format!("{neg}{value_l}")) || text.contains(&format!("{neg}{value}"))
        })
    })
}

fn contains_marker(text: &str, markers: &[&str]) -> bool {
    let lower = text.to_lowercase();
    markers
        .iter()
        .any(|marker| text.contains(marker) || lower.contains(&marker.to_lowercase()))
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if starts_with_ignore_case(text, prefix) {
        text.get(prefix.len()..)
    } else {
        None
    }
}

fn split_once_any<'a>(text: &'a str, delimiters: &[&str]) -> Option<(&'a str, &'a str)> {
    delimiters
        .iter()
        .find_map(|delimiter| text.split_once(delimiter))
}

fn split_once_str_ci(text: &str, delimiter: &str) -> Option<(String, String)> {
    let lower = text.to_lowercase();
    let delim = delimiter.to_lowercase();
    let index = lower.find(&delim)?;
    Some((
        text[..index].to_owned(),
        text[index + delimiter.len()..].to_owned(),
    ))
}

fn find_prefix(text: &str, lower: &str, prefix: &str) -> Option<usize> {
    if let Some(index) = text.find(prefix) {
        return Some(index);
    }
    lower.find(&prefix.to_lowercase()).and_then(|byte_index| {
        // prefixes we search are ASCII or already matched above for CJK
        text.get(byte_index..).map(|_| byte_index)
    })
}

fn capture_after(text: &str, prefixes: &[&str]) -> Option<String> {
    for prefix in prefixes {
        if let Some(index) = text.find(prefix) {
            let rest = trim_clause(&text[index + prefix.len()..]);
            if !rest.is_empty() {
                return Some(rest);
            }
        }
    }
    None
}

fn trim_clause(text: &str) -> String {
    text.trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                '，' | ','
                    | '。'
                    | '！'
                    | '？'
                    | '.'
                    | '!'
                    | '?'
                    | '、'
                    | '：'
                    | ':'
                    | '；'
                    | ';'
                    | '的'
            )
        })
        .trim()
        .to_owned()
}

fn text_contains(haystack: &str, needle: &str) -> bool {
    let needle = needle.trim();
    !needle.is_empty()
        && (haystack.contains(needle) || haystack.to_lowercase().contains(&needle.to_lowercase()))
}

fn dismissed_match(body: &MemoryBody, needle: &str) -> Option<()> {
    if needle.is_empty() {
        return None;
    }
    if text_contains(&render_simple(body), needle) {
        Some(())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_context::{attach_turn_memory_context, build_turn_memory_context};
    use crate::memory_controls::{self, UserPreferenceInput};
    use semi_os_protocol::{EnvelopeContext, RequestId};
    use semi_os_storage::{MemoryMutability, NewMemory};

    fn text_request(text: &str) -> Envelope {
        Envelope::Request {
            protocol_version: 1,
            request_id: RequestId("req_corr".into()),
            kind: "voice.text.submit".into(),
            payload: serde_json::json!({
                "sessionId": "session_corr",
                "taskId": "task_corr",
                "cwd": "/tmp",
                "text": text
            }),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        }
    }

    fn seed_verbose_preference(storage: &mut Storage, now: i64) {
        memory_controls::create_user_preference(
            storage,
            &UserPreferenceInput {
                key: "详略".into(),
                value: "详细".into(),
            },
            now,
        )
        .unwrap();
    }

    #[test]
    fn recognizes_future_short_answers_and_replacements() {
        let recognized = recognize_explicit_correction("以后用简短回答").unwrap();
        assert_eq!(
            recognized.body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "简短".into(),
            }
        );
        let remembered = recognize_explicit_correction("请记住语气要活泼").unwrap();
        assert_eq!(
            remembered.body,
            MemoryBody::Preference {
                key: "语气".into(),
                value: "活泼".into(),
            }
        );
        let replaced = recognize_explicit_correction("不是详细，是简短").unwrap();
        assert_eq!(
            replaced.body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "简短".into(),
            }
        );
        assert_eq!(replaced.dismissed.as_deref(), Some("详细"));
        let english = recognize_explicit_correction("from now on use short answers").unwrap();
        assert_eq!(
            english.body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "简短".into(),
            }
        );
        let fact = recognize_explicit_correction("不是 vim，是 helix").unwrap();
        assert_eq!(
            fact.body,
            MemoryBody::ProjectFact {
                fact: "helix".into(),
            }
        );
        assert_eq!(fact.dismissed.as_deref(), Some("vim"));
        assert!(recognize_explicit_correction("你好，帮我查一下天气").is_none());
        assert!(recognize_explicit_correction("以后都这样").is_none());
        assert!(recognize_explicit_correction("我以后再告诉你").is_none());
    }

    #[test]
    fn writes_user_correction_and_hides_old_preference_from_next_pack() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_verbose_preference(&mut storage, 10);
        let before = storage
            .list_memories(&MemoryQuery {
                user_id: Some(CLIENT_USER_ID.into()),
                ..MemoryQuery::default()
            })
            .unwrap();
        let old = before
            .iter()
            .find(|record| matches!(&record.body, MemoryBody::Preference { key, value } if key == "详略" && value == "详细"))
            .cloned()
            .expect("seeded preference");
        assert_eq!(old.author, MemoryAuthor::User);

        let first_context = build_turn_memory_context(&storage)
            .unwrap()
            .expect("old preference should reach the pack");
        assert!(first_context.contains("详细"));
        assert!(!first_context.contains("简短"));

        let outcome =
            apply_explicit_correction(&mut storage, "以后用简短回答", "turn_demo", 20).unwrap();
        let CorrectionOutcome::Stored {
            memory_id,
            author,
            link,
            ..
        } = outcome
        else {
            panic!("explicit correction should be stored");
        };
        assert_eq!(author, MemoryAuthor::User);
        let stored = storage.load_memory(&memory_id).unwrap().unwrap();
        assert_eq!(stored.author, MemoryAuthor::User);
        assert_eq!(stored.mutability, MemoryMutability::UserReadonly);
        assert_eq!(
            stored.body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "简短".into(),
            }
        );
        let link = link.expect("old preference should be superseded");
        assert_eq!(link.relation, MemoryRelation::Supersedes);
        assert_eq!(link.from_memory_id, memory_id);
        assert_eq!(link.to_memory_id, old.memory_id);
        let old_after = storage.load_memory(&old.memory_id).unwrap().unwrap();
        assert_eq!(old_after.body, old.body);
        assert_eq!(old_after.updated_at_ms, old.updated_at_ms);
        assert_eq!(old_after.author, MemoryAuthor::User);

        let next = build_turn_memory_context(&storage)
            .unwrap()
            .expect("updated preference should reach the next pack");
        assert!(next.contains("简短"));
        assert!(!next.contains("详细"));
    }

    #[test]
    fn same_turn_text_submit_writes_then_injects_new_preference() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_verbose_preference(&mut storage, 11);
        let mut envelope = text_request("以后用简短回答，以后都这样");
        assert!(apply_turn_explicit_corrections(&mut storage, &envelope, 21).unwrap());
        assert!(attach_turn_memory_context(&mut storage, &mut envelope).unwrap());
        let Envelope::Request { payload, .. } = &envelope else {
            panic!("request should stay a request");
        };
        let context = payload["memoryContext"].as_str().unwrap();
        assert!(context.contains("简短"));
        assert!(!context.contains("详细"));
    }

    #[test]
    fn restoration_after_supersede_writes_a_new_user_row() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_verbose_preference(&mut storage, 12);
        apply_explicit_correction(&mut storage, "以后用简短回答", "turn_a", 22).unwrap();
        let restored =
            apply_explicit_correction(&mut storage, "以后用详细回答", "turn_b", 23).unwrap();
        let CorrectionOutcome::Stored {
            memory_id, link, ..
        } = restored
        else {
            panic!("restoring the previous value should write a new row");
        };
        let link = link.expect("latest short preference should be superseded");
        assert_eq!(link.relation, MemoryRelation::Supersedes);
        assert_eq!(
            storage.load_memory(&memory_id).unwrap().unwrap().body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "详细".into(),
            }
        );
        let next = build_turn_memory_context(&storage).unwrap().unwrap();
        assert!(next.contains("详细"));
        assert!(!next.contains("简短"));
    }

    #[test]
    fn replacement_can_contradict_a_non_preference_fact() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage
            .create_memory(
                MemoryActor::Agent,
                &NewMemory {
                    memory_id: "fact_editor".into(),
                    body: MemoryBody::ProjectFact {
                        fact: "编辑器使用 vim".into(),
                    },
                    scope: MemoryScope {
                        user_id: Some(CLIENT_USER_ID.into()),
                        ..MemoryScope::default()
                    },
                    sources: vec![NewMemorySource {
                        source_id: "src_fact_editor".into(),
                        kind: MemorySourceKind::ConversationTurn,
                        source_ref: "prior".into(),
                        note: None,
                    }],
                },
                13,
            )
            .unwrap();
        let outcome =
            apply_explicit_correction(&mut storage, "不是 vim，是 helix", "turn_fact", 24).unwrap();
        let CorrectionOutcome::Stored {
            memory_id,
            author,
            link,
            ..
        } = outcome
        else {
            panic!("fact replacement should be stored");
        };
        assert_eq!(author, MemoryAuthor::User);
        let link = link.expect("old fact should be linked");
        assert_eq!(link.to_memory_id, "fact_editor");
        assert!(matches!(
            link.relation,
            MemoryRelation::Supersedes | MemoryRelation::Contradicts
        ));
        let stored = storage.load_memory(&memory_id).unwrap().unwrap();
        assert_eq!(
            stored.body,
            MemoryBody::ProjectFact {
                fact: "helix".into(),
            }
        );
        let old = storage.load_memory("fact_editor").unwrap().unwrap();
        assert_eq!(
            old.body,
            MemoryBody::ProjectFact {
                fact: "编辑器使用 vim".into(),
            }
        );
        assert_eq!(old.author, MemoryAuthor::Agent);
        // supersede 后的事实同样要从基础包隐藏旧值，避免 vim/helix 冲突同时进入提示词。
        let next = build_turn_memory_context(&storage).unwrap().unwrap();
        assert!(next.contains("helix"));
        assert!(!next.contains("编辑器使用 vim"));
    }

    #[test]
    fn agent_cannot_overwrite_a_user_correction() {
        let mut storage = Storage::open_in_memory().unwrap();
        let outcome =
            apply_explicit_correction(&mut storage, "以后用简短回答", "turn_user", 25).unwrap();
        let CorrectionOutcome::Stored { memory_id, .. } = outcome else {
            panic!("user correction should be stored");
        };
        let before = storage.load_memory(&memory_id).unwrap().unwrap();
        let hijack = MemoryWriteCandidate {
            memory_id: memory_id.clone(),
            body: MemoryBody::Preference {
                key: "详略".into(),
                value: "详细".into(),
            },
            scope: MemoryScope {
                user_id: Some(CLIENT_USER_ID.into()),
                ..MemoryScope::default()
            },
            sources: vec![NewMemorySource {
                source_id: "src_agent_hijack".into(),
                kind: MemorySourceKind::ConversationTurn,
                source_ref: "agent".into(),
                note: Some("origin=conversation_turn".into()),
            }],
            confidence: 90,
            importance: 70,
            conflict: None,
        };
        assert!(storage
            .write_memory(MemoryActor::Agent, &hijack, 26)
            .is_err());
        assert_eq!(storage.load_memory(&memory_id).unwrap().unwrap(), before);

        let mut rival = hijack.clone();
        rival.memory_id = "pref_agent_verbose".into();
        let stored = storage
            .write_memory(MemoryActor::Agent, &rival, 27)
            .unwrap();
        let MemoryWriteOutcome::Stored { record, .. } = stored else {
            panic!("agent may add its own row");
        };
        assert_eq!(record.author, MemoryAuthor::Agent);
        assert_eq!(storage.load_memory(&memory_id).unwrap().unwrap(), before);
        let next = build_turn_memory_context(&storage).unwrap().unwrap();
        assert!(next.contains("简短"));
        assert!(!next.contains("详细"));
    }

    #[test]
    fn ordinary_turns_and_secrets_do_not_write() {
        let mut storage = Storage::open_in_memory().unwrap();
        assert_eq!(
            apply_explicit_correction(&mut storage, "帮我总结这段代码", "turn_plain", 28).unwrap(),
            CorrectionOutcome::Ignored
        );
        let secret = apply_explicit_correction(
            &mut storage,
            "请记住 password 是 hunter2",
            "turn_secret",
            29,
        )
        .unwrap();
        assert!(matches!(
            secret,
            CorrectionOutcome::Rejected(MemoryWriteRejection::Secret)
        ));
        assert!(storage
            .list_memories(&MemoryQuery {
                user_id: Some(CLIENT_USER_ID.into()),
                ..MemoryQuery::default()
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn casual_remember_sentences_do_not_write() {
        let mut storage = Storage::open_in_memory().unwrap();
        for text in [
            "记住这件事很重要",
            "记住别忘带伞",
            "记住我很重要",
            "别忘了记住带钥匙",
            "我只是记住了这个快捷键",
            "remember to buy milk",
            "i need to remember the meeting time",
        ] {
            assert_eq!(
                apply_explicit_correction(&mut storage, text, "turn_casual", 40).unwrap(),
                CorrectionOutcome::Ignored,
                "普通含「记住」但非明确纠正的句子不应落库：{text}"
            );
        }
        assert!(storage
            .list_memories(&MemoryQuery {
                user_id: Some(CLIENT_USER_ID.into()),
                ..MemoryQuery::default()
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn explicit_remember_forms_still_store() {
        let colon = recognize_explicit_correction("记住：以后用简短回答").unwrap();
        assert_eq!(
            colon.body,
            MemoryBody::Preference {
                key: "详略".into(),
                value: "简短".into(),
            }
        );
        let fact = recognize_explicit_correction("请记住我的编辑器是 helix").unwrap();
        assert_eq!(
            fact.body,
            MemoryBody::ProjectFact {
                fact: "我的编辑器是 helix".into(),
            }
        );
    }

    #[test]
    fn transcript_final_is_the_only_voice_event_hook() {
        let mut storage = Storage::open_in_memory().unwrap();
        seed_verbose_preference(&mut storage, 14);
        let event = Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_voice_corr".into()),
            kind: "voice.transcript.final".into(),
            payload: serde_json::json!({ "text": "以后用简短回答" }),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert!(apply_turn_explicit_corrections(&mut storage, &event, 30).unwrap());
        let partial = Envelope::Event {
            protocol_version: 1,
            request_id: RequestId("req_voice_corr".into()),
            kind: "voice.transcript.partial".into(),
            payload: serde_json::json!({ "text": "以后用简短回答" }),
            context: EnvelopeContext {
                task_id: None,
                task_run_id: None,
                trace_id: None,
            },
        };
        assert!(!apply_turn_explicit_corrections(&mut storage, &partial, 31).unwrap());
    }
}
