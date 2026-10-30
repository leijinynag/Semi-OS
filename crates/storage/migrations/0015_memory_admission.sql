-- 自动写入流水线附带的置信度与重要度。
-- 不改 memories 的层、作者、可变更性或正文；缺失行表示这条记录不是流水线写入的。
-- 检索和基础包用它挑选高置信 L2。具体 token 预算仍由调用方传入，不写进表里。

CREATE TABLE memory_admission (
    memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100)
) STRICT;
