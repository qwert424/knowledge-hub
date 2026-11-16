-- 文档标签：写入向量库的 tags 字段，检索时按标签收窄范围（标签只做收窄，不能放大 ACL 授权）
alter table document add column if not exists tags jsonb not null default '[]'::jsonb;
create index if not exists idx_document_tags on document using gin (tags);

-- 菜单：管理端导航不再写死在代码里，租户可自行增删/排序/绑定权限码
create table if not exists menu_item (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    section     varchar(32) not null default '知识',
    menu_key    varchar(64) not null,
    label       varchar(64) not null,
    path        varchar(128) not null,
    permission  varchar(64),
    sort_order  int not null default 0,
    hidden      boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index if not exists uk_menu_item on menu_item (tenant_id, menu_key);
