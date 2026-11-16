import type { ApiClient } from '../http';
import type { GatewayModel, IntegrationsHealth, LangfuseInfo, NacosConfigView } from '../types';

interface RawModelEntry {
  id?: unknown;
  mode?: unknown;
  dimensions?: unknown;
}

function toGatewayModel(entry: RawModelEntry): GatewayModel {
  return {
    id: String(entry.id ?? ''),
    mode: typeof entry.mode === 'string' ? entry.mode : undefined,
    dimensions: typeof entry.dimensions === 'number' ? entry.dimensions : null,
  };
}

export function createIntegrationApi(client: ApiClient) {
  return {
    health: () => client.request<IntegrationsHealth>('/api/v1/integrations/health', { timeoutMs: 15_000 }),
    /** 网关模型清单（含 mode，供控制台按用途过滤，禁止手输模型名） */
    models: async (): Promise<GatewayModel[]> => {
      const payload = await client.request<
        { models?: RawModelEntry[]; source?: string } | RawModelEntry[]
      >('/api/v1/integrations/models', { timeoutMs: 15_000 });
      const entries = Array.isArray(payload) ? payload : (payload.models ?? []);
      return entries.map(toGatewayModel).filter((model) => model.id.length > 0);
    },
    syncModels: () =>
      client.request<Record<string, unknown>>('/api/v1/integrations/models/sync', { method: 'POST' }),
    /** Nacos 配置只读快照（含 highlights 与 raw） */
    nacosConfig: () =>
      client.request<NacosConfigView>('/api/v1/integrations/nacos-config', { timeoutMs: 20_000 }),
    langfuse: () => client.request<LangfuseInfo>('/api/v1/integrations/langfuse', { timeoutMs: 15_000 }),

    // ---- 平台集成控制台：Nacos（Agent/Prompt/Skill）/ 网关 / Langfuse 调用记录 ----
    agents: () =>
      client.request<PlatformAgent[]>('/api/v1/admin/platform/agents', { timeoutMs: 20_000 }),
    agent: (name: string) =>
      client.request<PlatformAgentDetail>(`/api/v1/admin/platform/agents/${encodeURIComponent(name)}`, {
        timeoutMs: 20_000,
      }),
    saveAgent: (name: string, body: { description?: string; content?: string; instruction?: string }) =>
      client.request<{ name: string; version: string }>(
        `/api/v1/admin/platform/agents/${encodeURIComponent(name)}`,
        { method: 'PUT', body, timeoutMs: 30_000 },
      ),
    /** 上线 / 下线（Nacos enable 开关） */
    setAgentOnline: (name: string, online: boolean) =>
      client.request<{ name: string; enable: boolean }>(
        `/api/v1/admin/platform/agents/${encodeURIComponent(name)}/online`,
        { method: 'POST', body: { online }, timeoutMs: 20_000 },
      ),
    /** 发布已审核版本（latest 指向该版本，引擎下次加载即生效） */
    publishAgent: (name: string, version: string) =>
      client.request<{ name: string; version: string; published: boolean }>(
        `/api/v1/admin/platform/agents/${encodeURIComponent(name)}/publish`,
        { method: 'POST', body: { version }, timeoutMs: 25_000 },
      ),
    /** 切换 production / latest 标签：引擎读的是 production，发布后必须切过去才生效 */
    setAgentLabel: (name: string, label: string, version: string) =>
      client.request<{ name: string; label: string; version: string; previous: string; reloaded: boolean }>(
        `/api/v1/admin/platform/agents/${encodeURIComponent(name)}/label`,
        { method: 'POST', body: { label, version }, timeoutMs: 30_000 },
      ),
    prompts: () =>
      client.request<PlatformPromptRow[]>('/api/v1/admin/platform/prompts', { timeoutMs: 20_000 }),
    prompt: (key: string) =>
      client.request<PlatformPromptDetail>(`/api/v1/admin/platform/prompts/${encodeURIComponent(key)}`, {
        timeoutMs: 20_000,
      }),
    promptVersions: (key: string) =>
      client.request<PlatformVersionRow[]>(
        `/api/v1/admin/platform/prompts/${encodeURIComponent(key)}/versions`,
        { timeoutMs: 20_000 },
      ),
    /** 发布指定版本（对齐 Nacos 的发布动作） */
    publishPrompt: (key: string, version: string) =>
      client.request<{ key: string; version: string; published: boolean }>(
        `/api/v1/admin/platform/prompts/${encodeURIComponent(key)}/publish`,
        { method: 'POST', body: { version }, timeoutMs: 25_000 },
      ),
    /** 切换版本标签（production / latest） */
    setPromptLabel: (key: string, label: string, version: string) =>
      client.request<{ key: string; label: string; version: string; switched: boolean }>(
        `/api/v1/admin/platform/prompts/${encodeURIComponent(key)}/label`,
        { method: 'POST', body: { label, version }, timeoutMs: 25_000 },
      ),
    savePrompt: (key: string, body: { template: string; description?: string }) =>
      client.request<{ key: string; saved: boolean }>(
        `/api/v1/admin/platform/prompts/${encodeURIComponent(key)}`,
        { method: 'PUT', body, timeoutMs: 30_000 },
      ),
    skills: () =>
      client.request<PlatformSkill[]>('/api/v1/admin/platform/skills', { timeoutMs: 20_000 }),
    gatewayModels: () =>
      client.request<PlatformGatewayModel[]>('/api/v1/admin/platform/gateway/models', { timeoutMs: 20_000 }),
    gatewayKeys: () =>
      client.request<PlatformGatewayKey[]>('/api/v1/admin/platform/gateway/keys', { timeoutMs: 20_000 }),
    /** 上游供应商凭证（只读，值已掩码） */
    gatewayCredentials: () =>
      client.request<PlatformGatewayCredential[]>('/api/v1/admin/platform/gateway/credentials', {
        timeoutMs: 20_000,
      }),
    /** 调用成本：按模型 + 按天（逐请求明细在 LiteLLM UI 里） */
    gatewaySpend: (days = 14) =>
      client.request<{
        byModel: { model: string; spend: number }[];
        daily: { date: string; spend: number; models: { model: string; spend: number }[] }[];
      }>(`/api/v1/admin/platform/gateway/spend?days=${days}`, { timeoutMs: 25_000 }),
    langfuseTraces: (limit = 20) =>
      client.request<{
        host: string;
        configured: boolean;
        observations: PlatformObservation[];
      }>(`/api/v1/admin/platform/langfuse/traces?limit=${limit}`, { timeoutMs: 25_000 }),

    // ---- 管理端：全租户会话审计（看别人的问答与引用，并可沉淀评测用例） ----
    adminConversations: (params: { page?: number; pageSize?: number; keyword?: string; userId?: string } = {}) =>
      client.request<{ items: AdminConversationRow[]; total: number; page: number; pageSize: number }>(
        `/api/v1/admin/conversations?page=${params.page ?? 1}&pageSize=${params.pageSize ?? 20}`
          + (params.keyword ? `&keyword=${encodeURIComponent(params.keyword)}` : '')
          + (params.userId ? `&userId=${encodeURIComponent(params.userId)}` : ''),
        { timeoutMs: 20_000 },
      ),
    adminConversationMessages: (id: string) =>
      client.request<AdminConversationMessage[]>(
        `/api/v1/admin/conversations/${encodeURIComponent(id)}/messages`,
        { timeoutMs: 20_000 },
      ),

    /** 既有 RAG 栈的 rag_config（切片 / 向量 / 检索参数），知识库表单的默认值来源 */
    ragConfig: () =>
      client.request<{
        dataId: string;
        group: string;
        content: string;
        parsed: Record<string, unknown>;
        defaults: Record<string, unknown>;
      }>('/api/v1/admin/platform/rag-config', { timeoutMs: 25_000 }),

    /** 把调试好的配置写回 Nacos 的 rag_config（对所有知识库生效） */
    publishRagConfig: (content: string) =>
      client.request<{ dataId: string; group: string; published: boolean }>(
        '/api/v1/admin/platform/rag-config',
        { method: 'PUT', body: { content }, timeoutMs: 30_000 },
      ),

    /** 结构化保存：只改指定字段，合并进现有 rag_config 后发布 */
    saveRagConfigStructured: (fields: Record<string, unknown>) =>
      client.request<{ dataId: string; group: string; published: boolean; content?: string }>(
        '/api/v1/admin/platform/rag-config/structured',
        { method: 'PUT', body: fields, timeoutMs: 30_000 },
      ),

    /** 把一条已发布检索策略的召回参数同步进 rag_config（其它区块保持原样） */
    ragConfigFromProfile: (profileId: string) =>
      client.request<{ published: boolean; content?: string; reloaded?: boolean }>(
        '/api/v1/admin/platform/rag-config/from-profile',
        { method: 'POST', body: { profileId }, timeoutMs: 40_000 },
      ),

    /** 引擎配置（Nacos knowledge-hub.yaml）：中间件开关 + 聊天/JEV 模型别名 */
    agentConfig: () =>
      client.request<{
        dataId: string;
        group: string;
        content: string;
        switches: { plan: boolean; review: boolean; securityScan: boolean };
        models?: { chat: string; jev: string };
        agentName?: string;
        agentLabel?: string;
      }>('/api/v1/admin/platform/agent-config', { timeoutMs: 25_000 }),

    /** 保存中间件开关与模型别名：只合并这些字段，发布后让引擎 reload 立即生效 */
    saveAgentSwitches: (switches: {
      plan?: boolean;
      review?: boolean;
      securityScan?: boolean;
      /** llm.chat_model */
      chatModel?: string;
      /** jev.model：JEV 受限选择决策用的小模型 */
      jevModel?: string;
    }) =>
      client.request<{ published: boolean; reloaded: boolean; content?: string }>(
        '/api/v1/admin/platform/agent-config/switches',
        { method: 'PUT', body: switches, timeoutMs: 30_000 },
      ),

    /** Nacos 控制台地址（Agent 审核/上线、版本切换在 Nacos 里完成） */
    nacosConsoleUrl: () =>
      client.request<{ baseUrl: string; namespace: string }>('/api/v1/admin/platform/nacos-console', {
        timeoutMs: 10_000,
      }),

    /** 各平台入口（Nacos / LiteLLM / Langfuse），地址来自 .env，后台只负责跳转 */
    links: () =>
      client.request<{ name: string; url: string; description: string }[]>(
        '/api/v1/admin/platform/links',
        { timeoutMs: 10_000 },
      ),

    /** 把一条真实问答沉淀成评测用例 */
    addEvalCase: (datasetId: string, cases: { question: string; expectedAnswer?: string; expectedDocIds?: string[] }[]) =>
      client.request<{ added: number }>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/cases`, {
        method: 'POST',
        body: cases,
      }),
  };
}

export interface AdminConversationRow {
  id: string;
  title: string;
  userId: string;
  owner: string;
  kbIds: string | null;
  model: string | null;
  messageCount: number | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface AdminConversationMessage {
  id: string;
  role: string;
  content: string;
  status: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  citations: { chunkId: string; docId: string; title: string; snippet: string; score: number }[];
}

export interface PlatformVersionRow {
  version: string;
  /** online / reviewed / draft */
  status: string;
  author: string;
  updateTime: number;
  /** 审核流水线结论（APPROVED 等） */
  pipelineStatus?: string;
}

export interface PlatformAgent {
  name: string;
  description: string;
  enable: boolean;
  /** 生产标签指向的版本（product / production，缺失时回落到 latest） */
  version: string;
  latestVersion?: string;
  reviewingVersion?: string;
  onlineCount: number;
  updateTime: number;
}

export interface PlatformAgentDetail {
  name: string;
  description: string;
  content: string;
  instruction: string;
  version: string;
  latestVersion?: string;
  productVersion?: string;
  labels?: Record<string, string>;
  versions?: PlatformVersionRow[];
  editingVersion?: string;
  reviewingVersion?: string;
  enable: boolean;
  onlineCount?: number;
  linkPrompts: string[];
}

export interface PlatformPromptRow {
  key: string;
  description: string;
  version: string;
  latestVersion?: string;
  reviewingVersion?: string;
  editingVersion?: string;
  onlineCount?: number;
  updateTime: number;
}

export interface PlatformPromptDetail {
  key: string;
  version: string;
  template: string;
  description: string;
  /** 线上正在用的版本（production 标签指向的版本） */
  productionVersion?: string;
  latestVersion?: string;
  labels?: Record<string, string>;
  versions?: PlatformVersionRow[];
}

export interface PlatformSkill {
  name: string;
  description: string;
  version: string;
}

export interface PlatformGatewayModel {
  id: string;
  provider: string;
  upstream: string;
  upstreamModel: string;
  mode: string;
  maxTokens: number;
  apiBase?: string;
  credential?: string;
}

export interface PlatformGatewayKey {
  key: string;
  keyName?: string;
  alias: string;
  spend: number;
  maxBudget: number;
  models?: string[];
  userId?: string;
}

/** 上游供应商凭证（LiteLLM UI 的 Configured credentials），值保持掩码 */
export interface PlatformGatewayCredential {
  name: string;
  provider: string;
  apiBase: string;
  apiKey: string;
  createdAt?: string;
}

export interface PlatformObservation {
  id: string;
  traceId: string;
  parentObservationId?: string;
  projectId?: string;
  type: string;
  name: string;
  model: string;
  startTime: string;
  latency: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  level: string;
}

export type IntegrationApi = ReturnType<typeof createIntegrationApi>;
