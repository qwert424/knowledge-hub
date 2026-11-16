-- 评测数据集支持绑定多个知识库（原 kb_id 单值保留做兼容）
alter table eval_dataset add column if not exists kb_ids jsonb not null default '[]'::jsonb;
