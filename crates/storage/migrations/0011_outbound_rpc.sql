CREATE TABLE outbound_rpc_receipts (
    request_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('not_sent', 'queued', 'sending', 'acknowledged', 'reconciliation')),
    response_kind TEXT,
    reconciliation_evidence TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;
