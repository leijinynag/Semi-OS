CREATE TABLE conversation_turns (
    request_id TEXT PRIMARY KEY NOT NULL,
    conversation_json TEXT NOT NULL CHECK(json_valid(conversation_json)),
    updated_at_ms INTEGER NOT NULL
) STRICT;
