-- 评测回收站：数据集与运行记录也走软删除，误删可从回收站恢复。
-- 与知识库/检索策略同一套语义：界面的「删除」= 进回收站，「彻底删除」才真删。
ALTER TABLE eval_dataset ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE eval_run ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_eval_dataset_deleted
    ON eval_dataset (tenant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_eval_run_deleted
    ON eval_run (tenant_id, deleted_at);
