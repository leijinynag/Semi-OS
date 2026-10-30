use crate::{StorageError, StorageResult};
use rusqlite::{params, Connection, TransactionBehavior};

const MIGRATIONS: &[(i64, &str, &str)] = &[
    // 新迁移只能追加在末尾，既有数据库版本不得重写。
    (
        1,
        "core task runtime",
        include_str!("../migrations/0001_core.sql"),
    ),
    (
        2,
        "research evidence",
        include_str!("../migrations/0002_research.sql"),
    ),
    (
        3,
        "voice conversations",
        include_str!("../migrations/0003_conversations.sql"),
    ),
    (
        4,
        "client sessions",
        include_str!("../migrations/0004_client_sessions.sql"),
    ),
    (
        5,
        "versioned collaboration workflows",
        include_str!("../migrations/0005_workflows.sql"),
    ),
    (
        6,
        "revision-bound workflow evidence",
        include_str!("../migrations/0006_workflow_evidence.sql"),
    ),
    (
        7,
        "explicit source branch application",
        include_str!("../migrations/0007_workflow_applications.sql"),
    ),
    (
        8,
        "durable background coordination",
        include_str!("../migrations/0008_workflow_background.sql"),
    ),
    (
        9,
        "structured delegate questions",
        include_str!("../migrations/0009_workflow_questions.sql"),
    ),
    (
        10,
        "durable rpc receipts",
        include_str!("../migrations/0010_rpc_receipts.sql"),
    ),
    (
        11,
        "outbound rpc delivery receipts",
        include_str!("../migrations/0011_outbound_rpc.sql"),
    ),
    (
        12,
        "controlled desktop action receipts",
        include_str!("../migrations/0012_desktop_actions.sql"),
    ),
    (
        13,
        "six layer memory",
        include_str!("../migrations/0013_memory_layers.sql"),
    ),
];

/// 在单个排他事务中依次执行迁移。
///
/// Migration 由 Rust Host 启动时执行；版本记录与 DDL 同时提交，避免应用崩溃
/// 后出现“表已创建但版本未更新”的半迁移状态。
pub(crate) fn migrate(connection: &mut Connection) -> StorageResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
        ) STRICT;",
    )?;

    for (version, name, sql) in MIGRATIONS {
        let already_applied = connection.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM schema_migrations WHERE version = ?1
            )",
            [version],
            |row| row.get::<_, bool>(0),
        )?;
        if already_applied {
            continue;
        }

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Exclusive)?;
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, name, applied_at_ms)
             VALUES (?1, ?2, unixepoch('subsec') * 1000)",
            params![version, name],
        )?;
        transaction.commit()?;
    }

    Ok(())
}

pub(crate) fn current_version(connection: &Connection) -> Result<i64, StorageError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::from)
}
