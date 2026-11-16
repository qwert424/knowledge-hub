-- Knowledge Hub core schema (PostgreSQL 17)
create extension if not exists "pgcrypto";

create table tenant (
    id          varchar(64) primary key,
    code        varchar(64)  not null unique,
    name        varchar(128) not null,
    status      varchar(16)  not null default 'active',
    created_at  timestamptz  not null default now()
);

create table app_user (
    id             uuid primary key,
    tenant_id      varchar(64) not null,
    username       varchar(64) not null,
    password_hash  varchar(128),
    display_name   varchar(128) not null,
    email          varchar(256),
    phone          varchar(32),
    avatar_url     text,
    status         varchar(16) not null default 'active',
    last_login_at  timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    deleted_at     timestamptz
);
create unique index uk_app_user_username on app_user (tenant_id, username) where deleted_at is null;
create index idx_app_user_tenant on app_user (tenant_id, status);

create table role (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    code        varchar(64) not null,
    name        varchar(128) not null,
    description text,
    builtin     boolean not null default false,
    created_at  timestamptz not null default now()
);
create unique index uk_role_code on role (tenant_id, code);

create table permission (
    code        varchar(64) primary key,
    name        varchar(128) not null,
    module      varchar(64) not null
);

create table role_permission (
    tenant_id     varchar(64) not null,
    role_id       uuid not null,
    permission_code varchar(64) not null,
    primary key (role_id, permission_code)
);

create table user_role (
    tenant_id varchar(64) not null,
    user_id   uuid not null,
    role_id   uuid not null,
    primary key (user_id, role_id)
);

create table user_group (
    id         uuid primary key,
    tenant_id  varchar(64) not null,
    code       varchar(64) not null,
    name       varchar(128) not null,
    created_at timestamptz not null default now()
);
create unique index uk_user_group_code on user_group (tenant_id, code);

create table user_group_member (
    tenant_id varchar(64) not null,
    group_id  uuid not null,
    user_id   uuid not null,
    primary key (group_id, user_id)
);

create table user_identity (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    user_id     uuid not null,
    provider    varchar(32) not null,
    external_id varchar(128) not null,
    union_id    varchar(128),
    created_at  timestamptz not null default now()
);
create unique index uk_user_identity on user_identity (tenant_id, provider, external_id);
create index idx_user_identity_union on user_identity (tenant_id, provider, union_id);

create table knowledge_base (
    id                 uuid primary key,
    tenant_id          varchar(64) not null,
    name               varchar(128) not null,
    code               varchar(64) not null,
    description        text,
    visibility         varchar(16) not null default 'private',
    embedding_model    varchar(64) not null default 'text-embedding-v4',
    embedding_dim      int not null default 1024,
    collection_name    varchar(128) not null,
    default_profile_id uuid,
    chunk_template     varchar(64) not null default 'general',
    graph_enabled      boolean not null default false,
    status             varchar(16) not null default 'active',
    created_by         uuid,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    deleted_at         timestamptz
);
create unique index uk_kb_code on knowledge_base (tenant_id, code) where deleted_at is null;

create table kb_member (
    id             uuid primary key,
    tenant_id      varchar(64) not null,
    kb_id          uuid not null,
    principal_type varchar(16) not null,
    principal_id   varchar(64) not null,
    permission     varchar(16) not null default 'read',
    created_at     timestamptz not null default now()
);
create unique index uk_kb_member on kb_member (kb_id, principal_type, principal_id);

create table document (
    id                uuid primary key,
    tenant_id         varchar(64) not null,
    kb_id             uuid not null,
    title             varchar(512) not null,
    source_type       varchar(32) not null,
    source_ref        varchar(1024),
    source_url        text,
    mime_type         varchar(128),
    size_bytes        bigint,
    content_hash      varchar(64),
    active_version_id uuid,
    visibility        varchar(16) not null default 'inherit',
    acl_mode          varchar(16) not null default 'inherit',
    status            varchar(24) not null default 'uploaded',
    graph_selected    boolean not null default false,
    owner_id          uuid,
    metadata          jsonb not null default '{}'::jsonb,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    deleted_at        timestamptz
);
create index idx_document_kb on document (tenant_id, kb_id, status);

create table document_version (
    id                 uuid primary key,
    tenant_id          varchar(64) not null,
    document_id        uuid not null,
    revision           varchar(128),
    content_hash       varchar(64) not null,
    parser             varchar(64),
    chunk_template     varchar(64),
    object_key         text,
    block_snapshot_key text,
    chunk_snapshot_key text,
    chunk_count        int not null default 0,
    token_count        int not null default 0,
    status             varchar(24) not null default 'staging',
    published_at       timestamptz,
    created_at         timestamptz not null default now()
);
create index idx_document_version on document_version (tenant_id, document_id, created_at desc);

create table chunk_meta (
    id              uuid primary key,
    tenant_id       varchar(64) not null,
    kb_id           uuid not null,
    document_id     uuid not null,
    version_id      uuid not null,
    chunk_index     int not null,
    parent_chunk_id uuid,
    block_id        varchar(64),
    block_type      varchar(32),
    title_path      jsonb,
    content_hash    varchar(64),
    token_count     int,
    quality_flags   text,
    enabled         boolean not null default true,
    milvus_pk       varchar(64),
    created_at      timestamptz not null default now()
);
create index idx_chunk_doc on chunk_meta (tenant_id, document_id, version_id, chunk_index);

create table index_job (
    id            uuid primary key,
    tenant_id     varchar(64) not null,
    document_id   uuid not null,
    version_id    uuid,
    job_type      varchar(32) not null,
    status        varchar(24) not null default 'queued',
    stage         varchar(32),
    progress      int not null default 0,
    attempt       int not null default 0,
    max_attempts  int not null default 3,
    error_code    varchar(64),
    error_message text,
    payload       jsonb not null default '{}'::jsonb,
    started_at    timestamptz,
    finished_at   timestamptz,
    trace_id      varchar(64),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index idx_index_job_status on index_job (tenant_id, status, created_at desc);
create index idx_index_job_doc on index_job (tenant_id, document_id);

create table outbox_event (
    id          bigserial primary key,
    tenant_id   varchar(64) not null,
    topic       varchar(64) not null,
    payload     jsonb not null,
    status      varchar(16) not null default 'pending',
    retry_count int not null default 0,
    next_at     timestamptz not null default now(),
    created_at  timestamptz not null default now()
);
create index idx_outbox_pending on outbox_event (status, next_at);

create table retrieval_profile (
    id           uuid primary key,
    tenant_id    varchar(64) not null,
    name         varchar(128) not null,
    version      int not null default 1,
    config       jsonb not null default '{}'::jsonb,
    is_default   boolean not null default false,
    status       varchar(16) not null default 'draft',
    published_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);
create index idx_profile_tenant on retrieval_profile (tenant_id, status);

create table retrieval_trace (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    profile_id  uuid,
    query       text not null,
    kb_ids      jsonb not null default '[]'::jsonb,
    request     jsonb,
    result      jsonb,
    duration_ms int,
    created_by  uuid,
    created_at  timestamptz not null default now()
);
create index idx_trace_tenant on retrieval_trace (tenant_id, created_at desc);

create table conversation (
    id              uuid primary key,
    tenant_id       varchar(64) not null,
    user_id         uuid not null,
    agent_key       varchar(64) not null default 'main_agent',
    kb_ids          jsonb not null default '[]'::jsonb,
    profile_id      uuid,
    title           varchar(256),
    source          varchar(16) not null default 'web',
    external_id     varchar(128),
    message_count   int not null default 0,
    last_message_at timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index idx_conversation_user on conversation (tenant_id, user_id, updated_at desc);

create table message (
    id             uuid primary key,
    tenant_id      varchar(64) not null,
    conversation_id uuid not null,
    role           varchar(16) not null,
    content        text,
    content_format varchar(16) not null default 'markdown',
    status         varchar(16) not null default 'completed',
    model          varchar(64),
    input_tokens   int,
    output_tokens  int,
    cost_usd       numeric(12,6),
    latency_ms     int,
    trace_id       varchar(64),
    request_id     varchar(64),
    created_at     timestamptz not null default now()
);
create index idx_message_conv on message (tenant_id, conversation_id, created_at);

create table message_citation (
    id         uuid primary key,
    tenant_id  varchar(64) not null,
    message_id uuid not null,
    chunk_id   varchar(64),
    doc_id     varchar(64),
    title      varchar(512),
    url        text,
    snippet    text,
    score      double precision,
    idx        int not null default 0
);
create index idx_citation_message on message_citation (tenant_id, message_id);

create table message_feedback (
    id         uuid primary key,
    tenant_id  varchar(64) not null,
    message_id uuid not null,
    user_id    uuid not null,
    rating     varchar(16) not null,
    comment    text,
    created_at timestamptz not null default now()
);

create table audit_log (
    id            bigserial primary key,
    tenant_id     varchar(64) not null,
    actor_id      uuid,
    actor_name    varchar(128),
    action        varchar(64) not null,
    resource_type varchar(64) not null,
    resource_id   varchar(128),
    before        text,
    after         text,
    ip            varchar(64),
    user_agent    text,
    result        varchar(16) not null,
    error_code    varchar(64),
    request_id    varchar(64),
    created_at    timestamptz not null default now()
);
create index idx_audit_tenant on audit_log (tenant_id, created_at desc);
create index idx_audit_actor on audit_log (tenant_id, actor_id, created_at desc);

create table datasource (
    id           uuid primary key,
    tenant_id    varchar(64) not null,
    kb_id        uuid not null,
    type         varchar(32) not null,
    name         varchar(128) not null,
    config       jsonb not null default '{}'::jsonb,
    secret_enc   text,
    status       varchar(16) not null default 'active',
    last_sync_at timestamptz,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table sync_run (
    id            uuid primary key,
    tenant_id     varchar(64) not null,
    datasource_id uuid not null,
    status        varchar(16) not null default 'running',
    stats         jsonb not null default '{}'::jsonb,
    error_message text,
    started_at    timestamptz,
    finished_at   timestamptz,
    created_at    timestamptz not null default now()
);
create index idx_sync_run_ds on sync_run (tenant_id, datasource_id, created_at desc);

create table eval_dataset (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    kb_id       uuid,
    name        varchar(128) not null,
    description text,
    created_at  timestamptz not null default now()
);

create table eval_case (
    id                uuid primary key,
    tenant_id         varchar(64) not null,
    dataset_id        uuid not null,
    question          text not null,
    expected_answer   text,
    expected_doc_ids  jsonb not null default '[]'::jsonb,
    created_at        timestamptz not null default now()
);
create index idx_eval_case_dataset on eval_case (tenant_id, dataset_id);

create table eval_run (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    dataset_id  uuid not null,
    profile_id  uuid,
    status      varchar(16) not null default 'queued',
    metrics     jsonb not null default '{}'::jsonb,
    started_at  timestamptz,
    finished_at timestamptz,
    created_at  timestamptz not null default now()
);

create table graph_document (
    id             uuid primary key,
    tenant_id      varchar(64) not null,
    kb_id          uuid not null,
    document_id    uuid not null,
    status         varchar(24) not null default 'selected',
    entity_count   int not null default 0,
    relation_count int not null default 0,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create unique index uk_graph_document on graph_document (tenant_id, document_id);

create table quota (
    id             uuid primary key,
    tenant_id      varchar(64) not null,
    subject_type   varchar(16) not null,
    subject_id     varchar(64) not null,
    period         varchar(16) not null,
    tokens_used    bigint not null default 0,
    requests_used  bigint not null default 0,
    limit_tokens   bigint not null default 5000000,
    limit_requests bigint not null default 100000,
    updated_at     timestamptz not null default now()
);
create unique index uk_quota on quota (tenant_id, subject_type, subject_id, period);

create table decision_log (
    id          uuid primary key,
    tenant_id   varchar(64) not null,
    scene       varchar(32) not null,
    input_digest varchar(128),
    options     jsonb not null default '[]'::jsonb,
    choice      varchar(128),
    confidence  double precision,
    degraded    boolean not null default false,
    rationale   text,
    model       varchar(64),
    latency_ms  int,
    created_at  timestamptz not null default now()
);
create index idx_decision_scene on decision_log (tenant_id, scene, created_at desc);