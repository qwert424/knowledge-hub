/**
 * 与 Java 后端 `/api/v1/**` 契约一一对应的类型定义。
 * 后端使用 Jackson 序列化 Java record，字段为 camelCase；
 * 引擎（RAG Engine）SSE 事件沿用 snake_case，由 chat 端点做归一化。
 */

/** 统一响应包裹：`{code,message,data,requestId}` */
export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
  requestId?: string | null;
}

/** 统一分页结构 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
}

/* ------------------------------- 认证 ------------------------------- */

export interface LoginRequest {
  /** 单租户部署可省略，后端默认 `default` */
  tenantId?: string;
  username: string;
  password: string;
}

export interface RegisterRequest {
  tenantId?: string;
  username: string;
  password: string;
  displayName?: string;
}

export interface AuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  groups?: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUserProfile;
}

export interface RefreshRequest {
  refreshToken: string;
}

/* ------------------------------ 知识库 ------------------------------ */

export type Visibility = 'private' | 'dept' | 'tenant' | 'public';
export type KbStatus = 'active' | 'archived';

export interface KbView {
  id: string;
  name: string;
  code: string;
  description?: string | null;
  visibility: Visibility;
  embeddingModel: string;
  embeddingDim: number;
  collectionName: string;
  chunkTemplate: string;
  graphEnabled: boolean;
  status: KbStatus | string;
  documentCount: number;
  readable: boolean;
  createdAt: string;
}

export interface CreateKbRequest {
  name: string;
  /** 留空由后端生成：编码只用于集合命名与接口引用 */
  code?: string;
  description?: string;
  visibility?: Visibility;
  embeddingModel?: string;
  embeddingDim?: number;
}

export interface UpdateKbRequest {
  name?: string;
  description?: string;
  visibility?: Visibility;
  graphEnabled?: boolean;
}

export type PrincipalType = 'user' | 'role' | 'group' | 'dept';
export type MemberPermission = 'read' | 'write' | 'manage';

export interface KbMemberRequest {
  principalType: PrincipalType;
  principalId: string;
  permission: MemberPermission;
}

export interface KbStats {
  documentCount?: number;
  chunkCount?: number;
  retrievalCount?: number;
  zeroResultRate?: number;
  storageBytes?: number;
  topQuestions?: Array<{ question: string; count: number }>;
  [key: string]: unknown;
}

export interface KbListQuery extends PageQuery {
  keyword?: string;
}

/* ------------------------------- 文档 ------------------------------- */

export type DocumentStatus = 'uploaded' | 'indexing' | 'active' | 'failed' | 'offline';

export interface DocumentView {
  id: string;
  kbId: string;
  title: string;
  sourceType: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  status: DocumentStatus | string;
  visibility: string;
  graphSelected: boolean;
  activeVersionId?: string | null;
  pendingVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** 文档标签（写入向量库切片字段，检索时用于收窄范围） */
  tags?: string[] | null;
  /** 飞书等外部来源的原始链接 */
  sourceUrl?: string | null;
}

export interface UploadIntentRequest {
  kbId: string;
  filename: string;
  sizeBytes: number;
  mimeType?: string;
}

/** 上传意图：`uploadUrl` 为 MinIO 预签名 PUT 地址 */
export interface UploadIntent {
  documentId: string;
  objectKey: string;
  uploadUrl: string;
  expiresIn: number;
}

export interface CommitDocumentRequest {
  sizeBytes?: number;
  contentHash?: string;
}

export interface DocumentVersionView {
  id: string;
  revision?: string | null;
  status: string;
  chunkCount: number;
  tokenCount: number;
  objectKey?: string | null;
  contentHash?: string | null;
  publishedAt?: string | null;
}

export interface ChunkView {
  id: string;
  chunkIndex: number;
  blockType?: string | null;
  /** 语义块类型：paragraph/table/code/image/heading/list/page（缺失时回落到 blockType） */
  kind?: string | null;
  chunkCount?: number | null;
  tableRowIndex?: number | null;
  blockParentId?: string | null;
  /** JSON 字符串数组 */
  titlePath?: string | null;
  tokenCount?: number | null;
  qualityFlags?: string | null;
  milvusPk?: string | null;
}

/**
 * 重索引结果：内容与切片/向量参数都没变时 skipped=true，不会再跑一遍 embedding。
 * force=true 才会无条件重建。
 */
export interface ReindexResult {
  jobId?: string | null;
  documentId?: string;
  skipped?: boolean;
  reason?: string;
}

/** 原文预览：`url` 为预签名下载地址，`kind` 决定前端如何渲染 */
export interface DocumentPreviewTarget {
  url: string;
  kind: string;
  filename: string;
}

/** 纯文本原文（后端截断到 200KB），`truncated` 为字符串布尔值 */
export interface DocumentTextContent {
  text: string;
  truncated: string;
}

export interface DocumentListQuery extends PageQuery {
  kbId?: string;
  status?: string;
  keyword?: string;
}

/* ----------------------------- 索引任务 ----------------------------- */

export type IndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface IndexJobView {
  id: string;
  documentId: string;
  versionId?: string | null;
  jobType: string;
  status: IndexJobStatus | string;
  stage?: string | null;
  progress: number;
  attempt: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  /** 各索引阶段的累计耗时（毫秒）JSON 字符串，键为阶段名 */
  stageTimings?: string | null;
  tokenCount?: number | null;
  costUsd?: number | null;
  /** 文档标题（后端按 documentId 反查），查不到时为空，前端回落显示 id */
  documentTitle?: string | null;
}

export interface IndexJobListQuery extends PageQuery {
  status?: string;
  documentId?: string;
}

/* ----------------------------- 检索策略 ----------------------------- */

export type ProfileStatus = 'draft' | 'published' | 'archived';

export interface RetrievalProfileView {
  id: string;
  name: string;
  version: number;
  /** 策略配置 JSON 字符串（后端以 String 存储 jsonb） */
  config: string;
  isDefault: boolean;
  status: ProfileStatus | string;
  updatedAt: string;
}

export interface CreateProfileRequest {
  name: string;
  config: string;
}

export interface UpdateProfileRequest {
  name?: string;
  config?: string;
}

export interface ProfileTestRequest {
  query: string;
  kbIds?: string[];
  topK?: number;
  /** 标签过滤：只召回带这些标签的切片（收窄条件，ACL 仍由后端票据决定） */
  tags?: string[];
}

export interface RetrievedChunk {
  chunk_id?: string;
  doc_id?: string;
  title?: string;
  title_path?: string[];
  text?: string;
  score?: number;
  source_url?: string;
  block_type?: string;
  /** page / heading / paragraph / table / code / image / list */
  kind?: string;
  chunk_count?: number;
  table_row_index?: number | null;
  /** 哪几路召回命中：dense / sparse / graph */
  matched_by?: string[];
  highlights?: number[][];
}

export interface RetrievalDebug {
  dense_ms?: number;
  sparse_ms?: number;
  rerank_ms?: number;
  filtered?: number;
  jev?: { choice?: string; confidence?: number; rationale?: string };
  answer_hint?: string;
  [key: string]: unknown;
}

/** 调试台返回为自由 JSON（后端 `JsonNode`） */
export interface RetrievalTestResult {
  chunks?: RetrievedChunk[];
  debug?: RetrievalDebug;
  answer_hint?: string;
  [key: string]: unknown;
}

export interface RetrievalTraceView {
  id: string;
  query: string;
  durationMs?: number | null;
  /** 埋点结果 JSON 字符串 */
  result?: string | null;
  createdAt: string;
}

/* ------------------------------ 对话 ------------------------------ */

export interface ConversationView {
  id: string;
  title?: string | null;
  /** JSON 数组字符串，例如 `["kb_1","kb_2"]` */
  kbIds: string;
  profileId?: string | null;
  messageCount: number;
  /** 会话级模型别名；null 表示跟随默认 */
  model?: string | null;
  updatedAt: string;
}

export interface CreateSessionRequest {
  kbIds: string[];
  profileId?: string;
  title?: string;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | string;
  content: string;
  status: 'streaming' | 'completed' | 'stopped' | 'failed' | string;
  model?: string | null;
  createdAt: string;
  citations?: ChatCitation[];
  /** 该回答对应的提问；时间旅行按它回溯 */
  parentMessageId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  /** 思考链步骤（服务端落库），刷新后仍可展开查看 */
  steps?: string[];
}

/** 管理端额度行（quota 表 + 本月用量） */
export interface ChatQuotaRow {
  subject_type: string;
  subject_id: string;
  /** 后端解析出的可读名称（用户显示名 / 角色名 / 组名） */
  subject_label?: string | null;
  limit_tokens: number;
  limit_requests: number;
  tokens_used: number;
  requests_used: number;
  updated_at?: string | null;
}

/** 当月用量与配额；quota<=0 表示不限 */
export interface ChatUsageQuota {  period: string;
  messagesUsed: number;
  messageQuota: number;
  tokensUsed: number;
  tokenQuota: number;
  tokensRemaining: number;
  questionsThisMonth: number;
  unlimited: boolean;
}

export interface FeedbackRequest {
  /** `up` | `down` */
  rating: 'up' | 'down' | string;
  comment?: string;
}

export interface ChatCitation {
  chunkId?: string;
  docId?: string;
  title?: string;
  url?: string;
  snippet?: string;
  score?: number;
  index?: number;
}

export interface ChatUsage {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ChatStreamEvent =
  | { event: 'start'; data: { messageId?: string } }
  | { event: 'status'; data: { stage?: string; question?: string; options?: string[]; detail?: string } }
  | { event: 'tool'; data: { name?: string; arguments?: string } }
  | { event: 'token'; data: { delta: string } }
  | { event: 'citation'; data: ChatCitation }
  /** 提示类事件（例如自动移除了不可用的知识库）：不打断生成，只做说明 */
  | { event: 'notice'; data: { level?: string; message: string } }
  | { event: 'error'; data: { code: string; message: string; retryable?: boolean } }
  | { event: 'done'; data: { messageId?: string; usage?: ChatUsage; citationCount?: number; stopped?: boolean } }
  | { event: 'unknown'; data: unknown };

/* --------------------------- 用户 / 权限 --------------------------- */

export type UserStatus = 'active' | 'disabled';

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  status: UserStatus | string;
  roles: string[];
  lastLoginAt?: string | null;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  displayName: string;
  email?: string;
  roles?: string[];
}

export interface UpdateUserRequest {
  displayName?: string;
  email?: string;
  status?: string;
}

export interface RoleView {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  builtin: boolean;
  permissions: string[];
}

export interface CreateRoleRequest {
  code: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface GroupView {
  id: string;
  code: string;
  name: string;
  memberCount: number;
}

export interface CreateGroupRequest {
  code: string;
  name: string;
}

export interface PermissionDef {
  code: string;
  name: string;
  module: string;
}

/* ------------------------------ 审计 ------------------------------ */

export interface AuditLogRow {
  id: number | string;
  tenantId?: string;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  before?: string | null;
  after?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result?: string | null;
  errorCode?: string | null;
  requestId?: string | null;
  createdAt: string;
}

export interface AuditLogQuery extends PageQuery {
  action?: string;
  actorName?: string;
}

/* ------------------------------ 指标 ------------------------------ */

export interface MetricsOverview {
  knowledgeBases?: number;
  documents?: number;
  chunks?: number;
  conversations?: number;
  messages?: number;
  runningJobs?: number;
  failedJobs?: number;
  today?: {
    conversations?: number;
    messages?: number;
    tokens?: number;
    costUsd?: number;
    indexedDocuments?: number;
  };
  performance?: {
    avgMessageLatencyMs?: number;
    avgIndexDurationMs?: number;
  };
  [key: string]: unknown;
}

/** 单日趋势点：`/api/v1/metrics/trends` */
export interface MetricsTrendPoint {
  date: string;
  documents: number;
  conversations: number;
  messages: number;
  failedJobs: number;
  tokens: number;
}

export interface MetricsTrends {
  days: MetricsTrendPoint[];
}

/** 通知中心条目：只来自真实运维事件（索引失败 / 审计失败） */
export interface NotificationItem {
  id: string;
  kind: string;
  level: 'error' | 'warning' | 'info' | string;
  title: string;
  description?: string | null;
  occurredAt?: string | null;
  href?: string | null;
}

export interface NotificationCounts {
  total: number;
  errors: number;
  warnings: number;
  runningJobs: number;
}

export interface NotificationFeed {
  items: NotificationItem[];
  counts: NotificationCounts;
  windowDays: number;
}

/* ------------------------------ 图谱 ------------------------------ */

export interface GraphDocument {
  id: string;
  kbId: string;
  documentId: string;
  status: string;
  entityCount?: number | null;
  relationCount?: number | null;
  /** 抽取失败 / 跳过的原因，列表里直接展示 */
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface GraphQueryRequest {
  kbId: string;
  query: string;
  hops?: number;
}

export interface GraphSelectRequest {
  kbId: string;
  documentId: string;
}

/* ----------------------------- 数据源 ----------------------------- */

export interface DatasourceView {
  id: string;
  kbId: string;
  type: string;
  name: string;
  config?: string | null;
  status: string;
  lastSyncAt?: string | null;
}

export interface CreateDatasourceRequest {
  kbId: string;
  type: string;
  name: string;
  config?: Record<string, unknown>;
  secret?: string;
}

export interface SyncRun {
  id: string;
  datasourceId: string;
  status: string;
  stats?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
}

/* ------------------------------ 评测 ------------------------------ */

/** 后端实体：`caseCount` 需要前端按用例列表自行统计 */
export interface EvalDataset {
  id: string;
  /** 兼容旧字段：只绑一个库时等于 kbIds[0] */
  kbId?: string | null;
  /** 绑定的知识库（可多个），空数组 = 不限库 */
  kbIds?: string[];
  name: string;
  description?: string | null;
  caseCount?: number;
  /** 最近一次运行的状态与分数（列表里直接能看见效果） */
  lastRunStatus?: string | null;
  lastRunMetrics?: string | null;
  lastRunAt?: string | null;
  createdAt?: string | null;
}

/** 一个评测样本 = 问题 + 期望答案/期望文档，用来对比检索与回答质量 */
export interface EvalCase {
  id: string;
  datasetId: string;
  question: string;
  expectedAnswer?: string | null;
  /** JSON 数组字符串（后端存 jsonb -> String） */
  expectedDocIds?: string | null;
  createdAt?: string | null;
}

/** `metrics` 为 JSON 字符串，页面按需解析后展示 */
export interface EvalRun {
  id: string;
  datasetId?: string | null;
  profileId?: string | null;
  status: string;
  metrics?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
}

export interface CreateEvalDatasetRequest {
  name: string;
  description?: string;
  /** 绑定的知识库（可多个）；留空表示不限库 */
  kbIds?: string[];
}

export interface CreateEvalCaseRequest {
  question: string;
  expectedAnswer?: string;
  expectedDocIds?: string[];
}

export interface CreateEvalRunRequest {
  datasetId?: string;
  /** 同一策略批量跑多个数据集 */
  datasetIds?: string[];
  profileId?: string;
}

/* ------------------------------ 集成 ------------------------------ */

export interface IntegrationHealthItem {
  name?: string;
  status?: string;
  latencyMs?: number | null;
  detail?: string | null;
  /** 组件的接入地址（例如 Nacos / 网关 / 引擎），便于定位问题 */
  endpoint?: string | null;
  [key: string]: unknown;
}

/** `/api/v1/integrations/health` 返回结构未冻结，前端按通用结构渲染 */
export interface IntegrationsHealth {
  status?: string;
  checkedAt?: string;
  components?: Record<string, unknown>;
  items?: IntegrationHealthItem[];
  [key: string]: unknown;
}

/** 网关模型模式：embedding / chat / rerank / image */
export type GatewayModelMode = 'embedding' | 'chat' | 'rerank' | 'image' | string;

/** `/api/v1/integrations/models`：模型清单只来自 LiteLLM 网关，控制台不允许手输模型名 */
export interface GatewayModel {
  id: string;
  mode?: GatewayModelMode;
  dimensions?: number | null;
}

export interface GatewayModelCatalog {
  models: GatewayModel[];
  source?: string;
}

/** `/api/v1/integrations/nacos-config`：只读配置快照，`raw` 已在展示层做脱敏 */
export interface NacosConfigView {
  server?: string;
  namespace?: string;
  group?: string;
  dataId?: string;
  source?: string;
  available?: boolean;
  hint?: string;
  highlights?: Record<string, unknown> | null;
  raw?: string | null;
}

/** `/api/v1/integrations/langfuse` */
export interface LangfuseInfo {
  host?: string;
  health?: unknown;
  embedUrl?: string;
}
