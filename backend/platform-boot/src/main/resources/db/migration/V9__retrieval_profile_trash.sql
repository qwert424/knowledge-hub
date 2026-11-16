-- 检索策略回收站：删除统一走软删除（deleted_at），列表与检索里都看不到，可恢复。
-- 和知识库保持同一套语义：界面上的「删除」= 进回收站，「彻底删除」才真删。
ALTER TABLE retrieval_profile ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_profile_deleted
    ON retrieval_profile (tenant_id, deleted_at);
