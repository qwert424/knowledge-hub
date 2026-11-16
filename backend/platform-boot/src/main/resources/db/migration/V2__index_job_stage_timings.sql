-- 索引阶段耗时与开销：前端"为什么这么慢"必须能回答
alter table index_job add column if not exists stage_timings jsonb not null default '{}'::jsonb;
alter table index_job add column if not exists token_count integer;
alter table index_job add column if not exists cost_usd numeric(12,6);

-- 会话级模型与策略快照：用户切换模型/知识库后，历史会话仍可解释
alter table conversation add column if not exists model varchar(64);
alter table conversation add column if not exists settings jsonb not null default '{}'::jsonb;

-- 消息级引用与检查点：支持"从某条重答"
alter table message add column if not exists parent_message_id uuid;