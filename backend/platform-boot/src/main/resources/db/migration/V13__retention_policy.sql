-- 数据保留策略：审计 180 天、对话 90 天，按天自动清理。
-- 之前库只增不减，跑几个月就会拖慢审计/会话列表。
CREATE TABLE IF NOT EXISTS retention_policy (
    id             uuid PRIMARY KEY,
    tenant_id      varchar(64) NOT NULL DEFAULT '*',
    name           varchar(64) NOT NULL,
    target         varchar(32) NOT NULL,
    retention_days integer     NOT NULL,
    enabled        boolean     NOT NULL DEFAULT true,
    cron           varchar(64) NOT NULL,
    last_run_at    timestamptz,
    last_deleted   integer,
    last_status    varchar(16),
    last_message   text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_retention_target ON retention_policy (tenant_id, target);

INSERT INTO retention_policy (id, tenant_id, name, target, retention_days, enabled, cron)
VALUES ('0193a000-0000-7000-8000-000000000101', '*', '审计日志保留 180 天', 'audit_log', 180, true, '0 30 3 * * *')
ON CONFLICT (tenant_id, target) DO NOTHING;

INSERT INTO retention_policy (id, tenant_id, name, target, retention_days, enabled, cron)
VALUES ('0193a000-0000-7000-8000-000000000102', '*', '会话消息保留 90 天', 'chat_message', 90, true, '0 40 3 * * *')
ON CONFLICT (tenant_id, target) DO NOTHING;
