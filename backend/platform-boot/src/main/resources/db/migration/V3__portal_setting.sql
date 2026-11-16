-- 用户端可配置项（推荐问题等）：不再写死在前端，按租户维护
create table if not exists portal_setting (
    tenant_id   varchar(64)  not null,
    setting_key varchar(64)  not null,
    value       jsonb        not null default '[]'::jsonb,
    updated_at  timestamptz  not null default now(),
    primary key (tenant_id, setting_key)
);
