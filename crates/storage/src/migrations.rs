use crate::{StorageError, StorageResult};
use rusqlite::{params, Connection, TransactionBehavior};

const MIGRATIONS: &[(i64, &str, &str)] = &[(
    1,
    "core task runtime",
    include_str!("../migrations/0001_core.sql"),
)];

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
