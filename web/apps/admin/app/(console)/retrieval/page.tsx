'use client';

import type { RetrievalProfileView, RetrievalTestResult, RetrievedChunk } from '@kh/api-client';
import { QuestionCircleOutlined } from '@ant-design/icons';
import {
  EmptyState,
  ErrorState,
  JsonView,
  PageHeader,
  StatusTag,
  formatDate,
  formatDuration,
} from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { JsonEditor, isJsonValid } from '@/components/JsonEditor';
import { InfoNote } from '@/components/InfoNote';
import { useApi } from '@/lib/providers';
import { useKbOptions } from '@/lib/useKbOptions';

/**
 * 策略配置的默认值：直接用后端归一化后回给界面那份（`ragConfig.defaults`）。
 * 这样抽屉里的「与 Nacos 比对」和「用 Nacos 当前值填充」比的是同一份数据，
 * 不会出现"填充完保存、再打开还是提示不一致"。
 */
function nacosConfigJson(parsed: Record<string, unknown> | undefined): string {
  const engine = engineConfigFromParsed(parsed);
  if (Object.keys(engine).length === 0) {
    return FALLBACK_CONFIG;
  }
  return JSON.stringify(engine, null, 2);
}

const FALLBACK_CONFIG = `{
  "dense_top_k": 20,
  "sparse_top_k": 20,
  "top_k": 8,
  "fusion": "rrf",
  "rerank": { "enabled": false, "model": "", "top_n": 8 },
  "dense_weight": 0.6,
  "sparse_weight": 0.4,
  "fusion_k": 60,
  "graph": { "enabled": true, "hops": 2 },
  "jev": { "routerEnabled": true, "judgeEnabled": true, "minConfidence": 0.55 },
  "timeout_ms": 8000
}`;

/** 库里存的可能是单行 JSON：展示/编辑前统一格式化，避免"新建好看、编辑挤成一团" */
function prettyJson(raw?: string | null): string {
  const text = (raw ?? '').trim();
  if (!text) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

interface DebugFormValues {
  query: string;
  kbIds?: string[];
  topK?: number;
  tags?: string[];
}

/** rag_config 的结构化视图：和 Nacos 双向同步（读出来填充，改完合并发布） */
interface RagStructuredValues {
  embeddingModel?: string;
  dimensions?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  fetchK?: number;
  topK?: number;
  rerankModel?: string;
  vlModel?: string;
  indexType?: string;
  metricType?: string;
  // 检索参数：和 rag_config 里 retrieval.* 同名，也就是策略 JSON 里那几个键
  denseTopK?: number;
  sparseTopK?: number;
  retrievalTopK?: number;
  fusion?: string;
  rerankEnabled?: boolean;
  fusionK?: number;
  denseWeight?: number;
  sparseWeight?: number;
  rerankTopN?: number;
  graphEnabled?: boolean;
  graphHops?: number;
  jevMinConfidence?: number;
  timeoutMs?: number;
}

/** rag_config 表单字段的中文名，用于「本次改动」对照 */
const RAG_FIELD_LABELS: Record<string, string> = {
  embeddingModel: 'Embedding 模型',
  dimensions: '维度',
  chunkSize: '切片长度',
  chunkOverlap: '重叠',
  fetchK: '召回 fetch_k',
  topK: '最终 k',
  rerankModel: 'Rerank 模型',
  vlModel: '图片理解模型',
  indexType: '索引类型',
  metricType: '距离度量',
  denseTopK: '稠密召回',
  sparseTopK: '稀疏召回',
  retrievalTopK: '最终输出 k',
  fusion: '融合策略',
  fusionK: '融合基数 k',
  denseWeight: '稠密权重',
  sparseWeight: '稀疏权重',
  rerankTopN: '重排保留数',
  graphEnabled: '图检索开关',
  graphHops: '图跳数',
  jevMinConfidence: 'JEV 置信度',
  timeoutMs: '检索超时(ms)',
};

/** 按语义比较两个配置值：对象/数组比内容，不比 key 顺序 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  if (left === undefined || left === null || left === '') {
    // 空值之间等价：`undefined` / `null` / `''` 都表示"没配"
    return right === undefined || right === null || right === '';
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** 把配置值压成一行短文本用于对照展示 */
function brief(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 46 ? `${text.slice(0, 46)}…` : text;
}

/**
 * 把 Nacos rag_config 的原始 YAML 摊平成**引擎实际读的那套扁平键**
 * （dense_top_k / sparse_top_k / top_k / rerank / graph / jev / timeout_ms）。
 * 策略 JSON 用的是同一套键，这样两边才可比——拿表单字段名（chunkSize / fetchK…）去比
 * 只会得到"每个字段都不一致"的假告警。
 */
function engineConfigFromParsed(parsed: Record<string, unknown> | undefined): Record<string, unknown> {
  const root = (parsed ?? {}) as Record<string, any>;
  const retrieval = (root.retrieval ?? {}) as Record<string, any>;
  const dense = (retrieval.dense ?? {}) as Record<string, any>;
  const sparse = (retrieval.sparse ?? {}) as Record<string, any>;
  const fusion = (retrieval.fusion ?? {}) as Record<string, any>;
  const rerank = (retrieval.rerank ?? {}) as Record<string, any>;
  const graph = (retrieval.graph ?? {}) as Record<string, any>;
  const jev = (root.jev ?? {}) as Record<string, any>;
  const retriever = (root.retriever ?? {}) as Record<string, any>;
  const rerankerParams = ((retriever.reranker ?? {}) as Record<string, any>).params ?? {};
  const engine: Record<string, unknown> = {
    dense_top_k: dense.top_k ?? retriever.dense_top_k ?? 20,
    sparse_top_k: sparse.top_k ?? retriever.sparse_top_k ?? 20,
    top_k: retriever.k ?? retrieval.top_k ?? 8,
    fusion: fusion.strategy ?? 'rrf',
    rerank: {
      enabled: Boolean(rerank.enabled ?? rerankerParams.enabled),
      model: rerankerParams.model_name ?? rerank.model ?? '',
      top_n: rerank.top_n ?? 8,
    },
  };
  if (graph.hops !== undefined || graph.enabled !== undefined) {
    engine.graph = { enabled: Boolean(graph.enabled), hops: graph.hops ?? 2 };
  }
  if (jev.min_confidence !== undefined || jev.scenes !== undefined) {
    engine.jev = {
      routerEnabled: jev.scenes?.router ?? true,
      judgeEnabled: jev.scenes?.judge ?? true,
      minConfidence: jev.min_confidence ?? 0.55,
    };
  }
  if (root.timeout_ms !== undefined) {
    engine.timeout_ms = root.timeout_ms;
  }
  return engine;
}

/** 策略列表的「配置摘要」：把 JSON 变成一句人话，别直接把原始 JSON 塞进表格 */
function summariseProfileConfig(raw: string | undefined): string {
  if (!raw) {
    return '空配置';
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch {
    return raw.replace(/\s+/g, ' ').slice(0, 80);
  }
  const dense = parsed.dense_top_k ?? parsed.dense?.topK ?? 20;
  const sparse = parsed.sparse_top_k ?? parsed.sparse?.topK ?? 20;
  const topK = parsed.top_k ?? parsed.dense?.topK ?? 8;
  const fusion = typeof parsed.fusion === 'string' ? parsed.fusion : (parsed.fusion?.strategy ?? 'rrf');
  const rerank = parsed.rerank ?? {};
  const graph = parsed.graph ?? {};
  const jev = parsed.jev ?? {};
  const parts = [
    `稠密 ${dense}`,
    `稀疏 ${sparse}`,
    `输出 ${topK}`,
    String(fusion).toUpperCase(),
    rerank.enabled ? `重排 ${rerank.top_n ?? rerank.topN ?? 8}` : '重排关',
    graph.enabled ? `图 ${graph.hops ?? 2} 跳` : '图关',
    jev.judgeEnabled === false ? 'JEV 仅路由' : 'JEV 路由+判定',
  ];
  return parts.join(' · ');
}

export default function RetrievalPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { options: kbOptions } = useKbOptions();

  const [editing, setEditing] = useState<RetrievalProfileView | null>(null);
  /** 已发布策略不允许改，但总得能看看它配了什么：这个状态就是只读查看 */
  const [viewing, setViewing] = useState<RetrievalProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const [formConfig, setFormConfig] = useState(FALLBACK_CONFIG);
  const [debugProfileId, setDebugProfileId] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<RetrievalTestResult | null>(null);
  const [testError, setTestError] = useState<Error | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [tab, setTab] = useState<'config' | 'debug'>('config');
  const [selectedTraces, setSelectedTraces] = useState<string[]>([]);
  const [debugForm] = Form.useForm<DebugFormValues>();
  const [profileForm] = Form.useForm<{ name: string }>();

  /** Nacos 里的 rag_config（引擎实际读取的切分与检索参数），可编辑后发布 */
  const [ragDraft, setRagDraft] = useState('');
  /** YAML 原文默认只读，避免"两个保存按钮"互相打架 */
  const [yamlEditing, setYamlEditing] = useState(false);
  const ragConfig = useQuery({
    queryKey: ['rag-config'],
    queryFn: () => api.integrations.ragConfig(),
    retry: false,
  });
  const publishRag = useMutation({
    mutationFn: (content: string) => api.integrations.publishRagConfig(content),
    onSuccess: () => {
      message.success('已发布到 Nacos 的 rag_config');
      setRagDraft('');
      setYamlEditing(false);
      void ragConfig.refetch();
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });

  const [ragForm] = Form.useForm<RagStructuredValues>();
  const fusionValue = Form.useWatch('fusion', ragForm) as string | undefined;
  const rerankValue = Form.useWatch('rerankEnabled', ragForm) as boolean | undefined;
  const graphValue = Form.useWatch('graphEnabled', ragForm) as boolean | undefined;
  const fusionMode = String(fusionValue || '').toLowerCase() === 'model';
  const weightedMode = String(fusionValue || '').toLowerCase() === 'weighted';
  const fusionEmpty = !String(fusionValue || '').trim();
  const rrfMode = !fusionEmpty && !fusionMode && !weightedMode;
  // 重排开关已去掉：只有「模型模式」才会重排，rrf / 权重不再露出重排字段
  const rerankOn = fusionMode;
  void rerankValue;
  const graphOn = Boolean(graphValue);
  /** 引擎自身配置：聊天模型与 JEV 决策模型（knowledge-hub.yaml），改了要让引擎 reload */
  const engineConfig = useQuery({
    queryKey: ['agent-config'],
    queryFn: () => api.integrations.agentConfig(),
    retry: false,
  });
  const [jevModel, setJevModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    const models = engineConfig.data?.models;
    if (!models) {
      return;
    }
    setJevModel(models.jev || undefined);
  }, [engineConfig.data]);
  /** 删除 = 进回收站；只有非发布状态才允许，避免把线上正在用的策略删掉 */
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.retrievalProfiles.softDelete(id),
    onSuccess: () => {
      message.success('已移入回收站，可在回收站恢复');
      invalidate();
      void trashed.refetch();
    },
    onError: (error: Error) => message.error(error.message || '删除失败'),
  });
  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.retrievalProfiles.restore(id),
    onSuccess: () => {
      message.success('已恢复');
      invalidate();
      void trashed.refetch();
    },
    onError: (error: Error) => message.error(error.message || '恢复失败'),
  });
  const purgeMutation = useMutation({
    mutationFn: (id: string) => api.retrievalProfiles.purge(id),
    onSuccess: () => {
      message.success('已彻底删除');
      void trashed.refetch();
    },
    onError: (error: Error) => message.error(error.message || '删除失败'),
  });
  const purgeAllMutation = useMutation({
    mutationFn: () => api.retrievalProfiles.purgeAllDeleted(),
    onSuccess: (result) => {
      message.success(`已清空回收站（${result.purged} 条）`);
      void trashed.refetch();
    },
    onError: (error: Error) => message.error(error.message || '清空失败'),
  });
  const deleteTracesMutation = useMutation({
    mutationFn: (ids: string[]) => api.retrievalProfiles.deleteTraces(ids),
    onSuccess: (result) => {
      message.success(`已删除 ${result.deleted} 条调试记录`);
      setSelectedTraces([]);
      void queryClient.invalidateQueries({ queryKey: ['retrieval-traces'] });
    },
    onError: (error: Error) => message.error(error.message || '删除失败'),
  });
  /** 网关模型清单：Embedding / Rerank / 视觉模型都从这里选，不让人手写名字 */
  const gatewayModels = useQuery({
    queryKey: ['gateway-models'],
    queryFn: () => api.integrations.gatewayModels(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const byMode = (mode: string) =>
    (gatewayModels.data ?? [])
      .filter((model) => model.mode === mode)
      .map((model) => ({ value: model.id, label: model.id }));
  const embeddingOptions = byMode('embedding');
  const rerankOptions = byMode('rerank');
  const vlOptions = [...byMode('image'), ...byMode('vision')];
  /** JEV 决策模型：只列网关里 jev-* 的专用别名，不把聊天模型混进来 */
  const jevModelOptions = byMode('chat').filter((option) => /^jev[-_.]/i.test(String(option.value)));
  const saveStructured = useMutation({
    // 决策模型和切分/检索参数一起提交：一个「保存并发布」写两处（rag_config + knowledge-hub.yaml）
    mutationFn: (values: RagStructuredValues) =>
      api.integrations.saveRagConfigStructured({ ...values, jevModel }),
    onSuccess: (result) => {
      const reloaded = (result as { reloaded?: boolean }).reloaded;
      message.success(
        reloaded
          ? '已合并并发布到 Nacos，引擎已重新加载'
          : '已合并并发布到 Nacos；引擎 reload 未确认，下次加载配置时生效',
      );
      setRagDraft('');
      setYamlEditing(false);
      void ragConfig.refetch();
      void engineConfig.refetch();
    },
    onError: (error: Error) => message.error(error.message || '保存失败'),
  });

  // 读到 rag_config 后把默认值灌进结构化表单（改了就等用户点保存）
  useEffect(() => {
    const defaults = ragConfig.data?.defaults;
    if (!defaults) {
      return;
    }
    ragForm.setFieldsValue({
      embeddingModel: defaults.embeddingModel as string | undefined,
      dimensions: defaults.dimensions as number | undefined,
      chunkSize: defaults.chunkSize as number | undefined,
      chunkOverlap: defaults.chunkOverlap as number | undefined,
      fetchK: defaults.fetchK as number | undefined,
      topK: defaults.topK as number | undefined,
      rerankModel: defaults.rerankModel as string | undefined,
      vlModel: defaults.vlModel as string | undefined,
      indexType: defaults.indexType as string | undefined,
      metricType: defaults.metricType as string | undefined,
      denseTopK: defaults.denseTopK as number | undefined,
      sparseTopK: defaults.sparseTopK as number | undefined,
      retrievalTopK: defaults.retrievalTopK as number | undefined,
      fusion: defaults.fusion as string | undefined,
      fusionK: defaults.fusionK as number | undefined,
      denseWeight: defaults.denseWeight as number | undefined,
      sparseWeight: defaults.sparseWeight as number | undefined,
      rerankEnabled: defaults.rerankEnabled as boolean | undefined,
      rerankTopN: defaults.rerankTopN as number | undefined,
      graphEnabled: defaults.graphEnabled as boolean | undefined,
      graphHops: defaults.graphHops as number | undefined,
      jevMinConfidence: defaults.jevMinConfidence as number | undefined,
      timeoutMs: defaults.timeoutMs as number | undefined,
    });
  }, [ragConfig.data, ragForm]);

  const profiles = useQuery({
    queryKey: ['retrieval-profiles'],
    queryFn: api.retrievalProfiles.list,
  });
  /** 回收站：软删除的策略，可恢复或彻底删除 */
  const trashed = useQuery({
    queryKey: ['retrieval-profiles', 'deleted'],
    queryFn: api.retrievalProfiles.listDeleted,
    enabled: trashOpen,
  });

  const traces = useQuery({
    queryKey: ['retrieval-traces'],
    queryFn: () => api.retrievalProfiles.traces(20),
  });

  /** 文档上已有的标签：调试时直接挑，不用凭记忆手输 */
  const taggedDocs = useQuery({
    queryKey: ['documents', 'tag-options'],
    queryFn: () => api.documents.list({ page: 1, pageSize: 200 }),
    staleTime: 60_000,
  });
  const tagOptions = Array.from(
    new Set((taggedDocs.data?.items ?? []).flatMap((doc) => doc.tags ?? [])),
  ).map((tag) => ({ value: tag, label: tag }));

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['retrieval-profiles'] });

  /**
   * 策略 JSON vs Nacos rag_config：只比「引擎真正读的扁平键」，并且按语义比
   * （对象比内容不比 key 顺序）。之前用 JSON 字符串直接比，
   * `{enabled,model,top_n}` 和 `{model,top_n,enabled}` 会被判成不同，
   * 于是"点了用 Nacos 值填充、保存后还是提示不一致"。
   */
  const profileDiff = useMemo(() => {
    const engineConfig = engineConfigFromParsed(ragConfig.data?.parsed as Record<string, unknown> | undefined);
    let draftConfig: Record<string, unknown> = {};
    try {
      draftConfig = JSON.parse(formConfig) as Record<string, unknown>;
    } catch {
      return [];
    }
    const rows: { key: string; engine: string; profile: string }[] = [];
    for (const key of Object.keys(engineConfig)) {
      const left = engineConfig[key];
      const right = draftConfig[key];
      if (!sameValue(left, right)) {
        rows.push({ key, engine: brief(left), profile: brief(right) });
      }
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }, [formConfig, ragConfig.data]);

  /**
   * rag_config 的「本次改动」：把表单当前值和 Nacos 里的默认值逐字段比。
   * 以前是靠一个「合并并发布」按钮盲发，用户不知道到底改了什么、有没有同步。
   */
  const ragValues = Form.useWatch([], ragForm) as RagStructuredValues | undefined;
  const ragChanges = useMemo(() => {
    const defaults = (ragConfig.data?.defaults ?? {}) as Record<string, unknown>;
    const values = (ragValues ?? {}) as Record<string, unknown>;
    const rows: { label: string; before: string; after: string }[] = [];
    // 表单还没填充时 useWatch 返回空对象：此时不能拿"空"去比，否则一进页面就报
    // 十处"不一致"。只要有任意一个字段有值才算填好了。
    const filled = Object.keys(RAG_FIELD_LABELS).some((key) => values[key] !== undefined && values[key] !== null);
    if (!filled) {
      return rows;
    }
    for (const [key, label] of Object.entries(RAG_FIELD_LABELS)) {
      const before = defaults[key];
      const after = values[key];
      const left = before === undefined || before === null ? '' : String(before);
      const right = after === undefined || after === null ? '' : String(after);
      if (left !== right) {
        rows.push({ label, before: left, after: right });
      }
    }
    return rows;
  }, [ragConfig.data, ragValues]);

  /**
   * 从已发布策略导入：**只填表单**，不直接发布。
   * 这样下方「本次改动」会先把差异摆出来，确认没问题再点「保存并发布」。
   */
  const importFromProfile = (profileId: string) => {
    const profile = (profiles.data ?? []).find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(profile.config) as Record<string, any>;
    } catch {
      message.error('这条策略的配置不是合法 JSON');
      return;
    }
    const rerank = (config.rerank ?? {}) as Record<string, any>;
    const graph = (config.graph ?? {}) as Record<string, any>;
    const jev = (config.jev ?? {}) as Record<string, any>;
    ragForm.setFieldsValue({
      denseTopK: config.dense_top_k ?? config.dense?.topK,
      sparseTopK: config.sparse_top_k ?? config.sparse?.topK,
      retrievalTopK: config.top_k ?? config.dense?.topK,
      fusion: typeof config.fusion === 'string' ? config.fusion : config.fusion?.strategy,
      rerankEnabled: rerank.enabled,
      rerankTopN: rerank.top_n ?? rerank.topN,
      graphEnabled: graph.enabled,
      graphHops: graph.hops,
      jevMinConfidence: jev.minConfidence ?? jev.min_confidence,
      timeoutMs: config.timeout_ms,
    } as RagStructuredValues);
    message.success('已把策略参数填入表单，确认下方「本次改动」后再保存并发布');
  };

  const saveMutation = useMutation({    mutationFn: async (values: { name: string; config: string }) => {
      if (editing) {
        return api.retrievalProfiles.update(editing.id, values);
      }
      return api.retrievalProfiles.create(values);
    },
    onSuccess: (profile) => {
      message.success(editing ? '策略已更新' : '策略已创建');
      setCreating(false);
      setEditing(null);
      invalidate();
      setDebugProfileId(profile.id);
    },
    onError: (error: Error) => message.error(error.message),
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) => api.retrievalProfiles.publish(id),
    onSuccess: () => {
      message.success('策略已发布，新的会话将使用该版本');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const disableMutation = useMutation({
    mutationFn: (id: string) => api.retrievalProfiles.disable(id),
    onSuccess: () => {
      message.success('策略已停用');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: (values: DebugFormValues & { profileId: string }) =>
      api.retrievalProfiles.test(values.profileId, {
        query: values.query,
        kbIds: values.kbIds,
        topK: values.topK,
        tags: values.tags,
      }),
    onMutate: () => {
      setTestError(null);
      setTestResult(null);
    },
    onSuccess: (result) => {
      setTestResult(result);
      void queryClient.invalidateQueries({ queryKey: ['retrieval-traces'] });
    },
    onError: (error: Error) => setTestError(error),
  });

  const openCreate = () => {
    setEditing(null);
    // 新策略默认取 Nacos rag_config 当前生效值，避免"新建一条和线上不一致的策略"
    setFormConfig(nacosConfigJson(ragConfig.data?.parsed as Record<string, unknown> | undefined));
    setCreating(true);
  };

  /** 只读查看：同样把配置格式化后填进编辑器，只是不给保存按钮 */
  const openView = (profile: RetrievalProfileView) => {
    setCreating(false);
    setEditing(null);
    setViewing(profile);
    setFormConfig(prettyJson(profile.config) || FALLBACK_CONFIG);
    profileForm.setFieldsValue({ name: profile.name });
  };

  const openEdit = (profile: RetrievalProfileView) => {
    setCreating(false);
    setEditing(profile);
    // 编辑时也格式化：之前把库里存的单行 JSON 原样塞进编辑器，挤成一团看不清
    setFormConfig(prettyJson(profile.config) || FALLBACK_CONFIG);
  };

  useEffect(() => {
    profileForm.setFieldsValue({ name: editing?.name ?? '' });
  }, [editing, profileForm, creating]);

  const profileColumns: ColumnsType<RetrievalProfileView> = [
    {
      title: '策略名称',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            v{record.version} · {formatDate(record.updatedAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (value: string) => <StatusTag kind="profile" status={value} />,
    },
    {
      title: '配置摘要',
      dataIndex: 'config',
      key: 'config',
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {summariseProfileConfig(value)}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, record) => (
        <Space size={2}>
          {/* 只有已发布不能改（线上正在用）；但要能查看它配了什么 */}
          {record.status === 'published' ? (
            <Button size="small" type="link" onClick={() => openView(record)}>
              查看
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          )}
          {record.status === 'published' ? null : (
            <Button
              size="small"
              type="link"
              loading={publishMutation.isPending && publishMutation.variables === record.id}
              onClick={() => publishMutation.mutate(record.id)}
            >
              发布
            </Button>
          )}
          {record.status === 'published' ? (
            <Popconfirm
              title="停用这条策略？"
              description="停用后新会话不再使用它；至少要保留一条已发布策略。"
              okText="停用"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => disableMutation.mutate(record.id)}
            >
              <Button
                size="small"
                type="link"
                danger
                loading={disableMutation.isPending && disableMutation.variables === record.id}
              >
                停用
              </Button>
            </Popconfirm>
          ) : (
            <Popconfirm
              title="移入回收站？"
              description="回收站里可以恢复；彻底删除才会真正移除。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteMutation.mutate(record.id)}
            >
              <Button
                size="small"
                type="link"
                danger
                loading={deleteMutation.isPending && deleteMutation.variables === record.id}
              >
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="检索策略与调试"
        description="策略版本化管理，发布后生效；调试台走真实检索链路并回显召回与耗时"
        extra={
          <Space>
            <Button onClick={() => void profiles.refetch()} loading={profiles.isFetching}>
              刷新
            </Button>
            <Button type="primary" onClick={openCreate}>
              新建策略
            </Button>
          </Space>
        }
      />

      {/* 配置和调试是两件事：一个改参数、一个验证参数，混在一屏里只会互相干扰 */}
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as 'config' | 'debug')}
        items={[
          { key: 'config', label: '策略与配置' },
          { key: 'debug', label: '调试台与 Trace' },
        ]}
        style={{ marginBottom: 4 }}
      />

      {tab === 'config' ? (
        <>
      <Card
        title="策略列表"
        styles={{ body: { paddingTop: 8 } }}
        extra={
          <Button size="small" onClick={() => setTrashOpen(true)}>
            回收站{trashed.data && trashed.data.length > 0 ? `（${trashed.data.length}）` : ''}
          </Button>
        }
      >
        {profiles.error ? (
          <ErrorState error={profiles.error} title="策略加载失败" onRetry={() => void profiles.refetch()} />
        ) : null}
        <Table<RetrievalProfileView>
          rowKey="id"
          size="middle"
          loading={profiles.isLoading}
          columns={profileColumns}
          dataSource={profiles.data ?? []}
          pagination={false}
          scroll={{ x: 1000 }}
          locale={{ emptyText: <EmptyState title="暂无检索策略" description="创建策略并发布后可在会话中选用" /> }}
        />
      </Card>

      <Card
        title="Nacos rag_config（引擎实际读取的切分与检索参数）"
        style={{ marginTop: 16 }}
        styles={{ body: { paddingTop: 12 } }}
        extra={
          <Space size={8}>
            <Tag>{ragConfig.data ? `${ragConfig.data.dataId} / ${ragConfig.data.group}` : '未读取'}</Tag>
            <Select
              size="small"
              style={{ width: 220 }}
              placeholder="从已发布策略导入"
              value={undefined}
              loading={profiles.isLoading}
              options={(profiles.data ?? [])
                .filter((profile) => profile.status === 'published')
                .map((profile) => ({ label: profile.name, value: profile.id }))}
              onSelect={(value) => importFromProfile(String(value))}
            />
            <Button
              size="small"
              loading={ragConfig.isFetching}
              onClick={() => {
                void ragConfig.refetch();
                void engineConfig.refetch();
              }}
            >
              重新获取
            </Button>
            <Button
              size="small"
              type="primary"
              loading={saveStructured.isPending}
              disabled={ragChanges.length === 0}
              onClick={() => ragForm.submit()}
            >
              保存并发布
            </Button>
          </Space>
        }
      >
        <Form<RagStructuredValues>
          form={ragForm}
          layout="vertical"
          onFinish={(values) => saveStructured.mutate(values)}
        >
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item
                label="Embedding 模型"
                name="embeddingModel"
                tooltip="来自网关（mode=embedding），所有向量化都走这个模型"
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder={gatewayModels.isLoading ? '读取网关…' : '选择向量模型'}
                  options={embeddingOptions}
                  notFoundContent="网关里没有向量模型"
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="维度" name="dimensions">
                <InputNumber min={128} max={4096} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="切片长度" name="chunkSize">
                <InputNumber min={100} max={4000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="重叠" name="chunkOverlap">
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="召回 fetch_k" name="fetchK">
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="最终 k" name="topK">
                <InputNumber min={1} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item
                label="图片理解模型（VL）"
                name="vlModel"
                tooltip="飞书文档里的图片用它生成描述，描述会进切片参与检索"
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder={gatewayModels.isLoading ? '读取网关…' : '选择图像/视觉模型'}
                  options={vlOptions}
                  notFoundContent="网关里没有图像模型"
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="索引类型" name="indexType">
                <Select
                  allowClear
                  options={['HNSW', 'IVF_FLAT', 'AUTOINDEX'].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="距离度量" name="metricType">
                <Select
                  allowClear
                  options={['COSINE', 'IP', 'L2'].map((value) => ({ label: value, value }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item
                label="稠密召回 top_k"
                name="denseTopK"
                tooltip="向量近邻召回多少条，对应 rag_config 的 retrieval.dense.top_k"
              >
                <InputNumber min={1} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item
                label="稀疏召回 top_k"
                name="sparseTopK"
                tooltip="BM25 召回多少条，对应 retrieval.sparse.top_k"
              >
                <InputNumber min={1} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item
                label="最终输出 k"
                name="retrievalTopK"
                tooltip="融合/重排后给模型多少条，对应 retrieval.top_k"
              >
                <InputNumber min={1} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item
                label="融合策略"
                name="fusion"
                tooltip="RRF：只看排名；权重：稠密/稀疏分数归一化后加权；模型模式：交给 Rerank 模型重新排序"
              >
                <Select
                  allowClear
                  options={[
                    { label: 'RRF（排名融合）', value: 'rrf' },
                    { label: '权重（稠密/稀疏加权）', value: 'weighted' },
                    { label: '模型模式（Rerank 模型重排）', value: 'model' },
                  ]}
                />
              </Form.Item>
            </Col>
            {rrfMode ? (
              <Col xs={12} md={4}>
                <Form.Item
                  label="融合基数 k"
                  name="fusionK"
                  tooltip="RRF 的 k：分数 = Σ 1/(k+排名+1)，默认 60，越大各路得分越接近"
                >
                  <InputNumber min={1} max={200} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            ) : null}
            {fusionMode ? (
              <>
                <Col xs={12} md={4}>
                  <Form.Item
                    label="重排模型"
                    name="rerankModel"
                    tooltip="模型模式下用哪个 Rerank 模型给候选池重新排序"
                  >
                    <Select
                      allowClear
                      showSearch
                      options={rerankOptions}
                      placeholder={gatewayModels.isLoading ? '读取网关…' : '选择重排模型'}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={4}>
                  <Form.Item
                    label="重排保留数"
                    name="rerankTopN"
                    tooltip="模型模式下重排后保留多少条"
                  >
                    <InputNumber min={1} max={50} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              </>
            ) : (
              <>
                {weightedMode ? (
                  <>
                    <Col xs={12} md={4}>
                      <Form.Item label="稠密权重" name="denseWeight" tooltip="权重模式下稠密召回占多少">
                        <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={4}>
                      <Form.Item label="稀疏权重" name="sparseWeight" tooltip="权重模式下稀疏（BM25）召回占多少">
                        <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </>
                ) : null}

                {rerankOn ? (
                  <>
                    <Col xs={12} md={4}>
                      <Form.Item label="重排模型" name="rerankModel">
                        <Select
                          allowClear
                          showSearch
                          options={rerankOptions}
                          placeholder={gatewayModels.isLoading ? '读取网关…' : '选择重排模型'}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={4}>
                      <Form.Item label="重排保留数" name="rerankTopN">
                        <InputNumber min={1} max={50} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </>
                ) : null}
              </>
            )}
            <Col xs={12} md={4}>
              <Form.Item
                label="图检索开关"
                name="graphEnabled"
                valuePropName="checked"
                tooltip="开了才会在检索时走一跳子图；图谱页只管「抽不抽」"
              >
                <Switch />
              </Form.Item>
            </Col>
            {graphOn ? (
              <Col xs={12} md={4}>
                <Form.Item label="图跳数" name="graphHops">
                  <InputNumber min={1} max={4} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            ) : null}
            <Col xs={12} md={4}>
              <Form.Item label="JEV 置信度" name="jevMinConfidence">
                <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="检索超时(ms)" name="timeoutMs">
                <InputNumber min={1000} max={60000} step={500} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                label="JEV 决策模型 · jev.model"
                tooltip="只做「在候选项里选一个」的小决策，只列网关里 jev-* 的别名"
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder={gatewayModels.isLoading ? '读取网关…' : '沿用聊天模型'}
                  value={jevModel}
                  onChange={setJevModel}
                  options={jevModelOptions}
                  notFoundContent="网关里没有 jev-* 别名，先到 LiteLLM 加一个"
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <div style={{ marginTop: 4, marginBottom: 8 }}>
          <Space size={8} style={{ marginBottom: 4 }}>
            <Typography.Text strong style={{ fontSize: 12.5 }}>
              本次改动
            </Typography.Text>
            {ragChanges.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                还没改任何字段（上方表单与 Nacos 当前值一致）
              </Typography.Text>
            ) : (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {ragChanges.length} 个字段将被写入，其余区块原样保留
              </Typography.Text>
            )}
          </Space>
          {ragChanges.length > 0 ? (
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <tbody>
                {ragChanges.map((item) => (
                  <tr key={item.label} style={{ borderTop: '1px solid #f0f0f0' }}>
                    <td style={{ width: 150, padding: '3px 8px 3px 0', color: '#8c8c8c' }}>{item.label}</td>
                    <td style={{ padding: '3px 8px', color: '#8c8c8c', textDecoration: 'line-through' }}>
                      {item.before || '—'}
                    </td>
                    <td style={{ width: 16, textAlign: 'center', color: '#bfbfbf' }}>→</td>
                    <td style={{ padding: '3px 8px', fontWeight: 600 }}>{item.after || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'yaml',
              label: (
                <Space size={8}>
                  <Typography.Text style={{ fontSize: 12.5 }}>rag_config 原文（YAML）</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    图片解析、集合配置这类高级项在这里改
                  </Typography.Text>
                </Space>
              ),
              children: yamlEditing ? (
                <>
                  <Input.TextArea
                    value={ragDraft}
                    onChange={(event) => setRagDraft(event.target.value)}
                    autoSize={{ minRows: 14, maxRows: 26 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
                    placeholder="YAML 原文"
                  />
                  <Space size={8} style={{ marginTop: 8 }}>
                    <Button
                      size="small"
                      type="primary"
                      loading={publishRag.isPending}
                      onClick={() => publishRag.mutate(ragDraft || ragConfig.data?.content || '')}
                    >
                      发布 YAML
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setRagDraft('');
                        setYamlEditing(false);
                      }}
                    >
                      取消
                    </Button>
                  </Space>
                </>
              ) : (
                <>
                  <Input.TextArea
                    readOnly
                    value={ragConfig.data?.content ?? ''}
                    autoSize={{ minRows: 8, maxRows: 22 }}
                    style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
                    placeholder={ragConfig.isLoading ? '读取中…' : '没有读到 rag_config'}
                  />
                  <Button
                    size="small"
                    type="link"
                    style={{ marginTop: 4, paddingInline: 0 }}
                    disabled={!ragConfig.data?.content}
                    onClick={() => {
                      setRagDraft(ragConfig.data?.content ?? '');
                      setYamlEditing(true);
                    }}
                  >
                    直接编辑原文
                  </Button>
                </>
              ),
            },
          ]}
        />
      </Card>
        </>
      ) : (
        <>
      <Card
        title="调试台"
        style={{ marginTop: 4 }}
        styles={{ body: { paddingTop: 12 } }}
>
        <Form<DebugFormValues>
          form={debugForm}
          layout="vertical"
          onFinish={(values) => {
            if (!debugProfileId) {
              message.warning('先选一条策略再执行检索');
              return;
            }
            testMutation.mutate({ ...values, profileId: debugProfileId });
          }}
        >
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item label="策略" required style={{ marginBottom: 12 }}>
                <Select
                  placeholder="选择策略"
                  value={debugProfileId}
                  onChange={setDebugProfileId}
                  options={(profiles.data ?? []).map((profile) => ({
                    label: `${profile.name}（v${profile.version}）`,
                    value: profile.id,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="知识库" name="kbIds" style={{ marginBottom: 12 }}>
                <Select
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="默认用策略绑定的库"
                  options={kbOptions}
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={6}>
              <Form.Item label="标签过滤" name="tags" style={{ marginBottom: 12 }}>
                <Select
                  mode="tags"
                  placeholder="只召回带这些标签的切片"
                  tokenSeparators={[',', '，']}
                  options={tagOptions}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row>
            <Col span={24}>
              <Form.Item label="问题" name="query" rules={[{ required: true, message: '请输入问题' }]}>
                <Input.Search
                  placeholder="例如：一线城市住宿报销上限是多少？"
                  enterButton="执行检索"
                  loading={testMutation.isPending}
                  onSearch={() => debugForm.submit()}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {testError ? <ErrorState error={testError} title="检索失败" /> : null}

        {testResult ? (
          <div>
            <Space size={16} wrap style={{ marginBottom: 8 }}>
              <Typography.Text>
                召回 <Typography.Text strong>{testResult.chunks?.length ?? 0}</Typography.Text> 条
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                稠密 {formatDuration(testResult.debug?.dense_ms)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                稀疏 {formatDuration(testResult.debug?.sparse_ms)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Rerank {formatDuration(testResult.debug?.rerank_ms)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                总计 {formatDuration(testResult.debug?.total_ms as number | undefined)}
              </Typography.Text>
            </Space>

            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              「得分」是 RRF 融合分（第 1 名恒为 1/(60+1)≈0.0164），只表示排名先后，
              不是相似度也不是置信度，跨轮次不可比。想知道是哪一路召回命中的，看「来源」列。
            </Typography.Paragraph>

            {testResult.answer_hint ? (
              <Typography.Paragraph style={{ fontSize: 12.5 }}>
                <Typography.Text strong>答案提示：</Typography.Text>
                {testResult.answer_hint}
              </Typography.Paragraph>
            ) : null}

            <Table<RetrievedChunk>
              rowKey={(record, index) => record.chunk_id ?? `chunk-${index}`}
              size="small"
              pagination={false}
              dataSource={testResult.chunks ?? []}
              tableLayout="fixed"
              scroll={{ x: 900 }}
              locale={{ emptyText: <EmptyState title="没有命中切片" description="检查 ACL、知识库选择或阈值配置" /> }}
              columns={[
                {
                  title: '来源文档',
                  dataIndex: 'title',
                  key: 'title',
                  width: 210,
                  ellipsis: true,
                  render: (value: string | undefined, record) => (
                    <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
                      <Tooltip title={value}>
                        <Typography.Text strong ellipsis style={{ maxWidth: 200 }}>
                          {value ?? '无标题'}
                        </Typography.Text>
                      </Tooltip>
                      <Typography.Text type="secondary" style={{ fontSize: 11.5 }} ellipsis>
                        {record.title_path?.join(' / ') ?? ''}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '块类型',
                  dataIndex: 'kind',
                  key: 'kind',
                  width: 90,
                  render: (value?: string, record?: RetrievedChunk) => {
                    const kind = value || record?.block_type || 'paragraph';
                    const map: Record<string, { label: string; color: string }> = {
                      page: { label: '页面', color: 'default' },
                      heading: { label: '章节', color: 'geekblue' },
                      paragraph: { label: '正文', color: 'default' },
                      table: { label: '表格', color: 'gold' },
                      code: { label: '代码', color: 'purple' },
                      image: { label: '图片', color: 'magenta' },
                      list: { label: '列表', color: 'default' },
                    };
                    const meta = map[kind] ?? { label: kind, color: 'default' };
                    return <Tag color={meta.color}>{meta.label}</Tag>;
                  },
                },
                {
                  title: (
                    <Tooltip title="同一个切片被稠密和稀疏都召回了，就会显示两个标签；RRF 会把两路分数相加，排名更靠前">
                      <Space size={2}>
                        来源
                        <QuestionCircleOutlined style={{ fontSize: 11 }} />
                      </Space>
                    </Tooltip>
                  ),
                  dataIndex: 'matched_by',
                  key: 'matched_by',
                  width: 110,
                  render: (value?: string[]) => {
                    const map: Record<string, { label: string; color: string }> = {
                      dense: { label: '稠密', color: 'blue' },
                      sparse: { label: '稀疏', color: 'cyan' },
                      graph: { label: '图谱', color: 'gold' },
                    };
                    const lanes = value && value.length > 0 ? value : [];
                    if (lanes.length === 0) {
                      return <Typography.Text type="secondary" style={{ fontSize: 12 }}>-</Typography.Text>;
                    }
                    return (
                      <Space size={2} wrap>
                        {lanes.map((lane) => (
                          <Tag key={lane} color={map[lane]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                            {map[lane]?.label ?? lane}
                          </Tag>
                        ))}
                      </Space>
                    );
                  },
                },
                {
                  title: '得分',
                  dataIndex: 'score',
                  key: 'score',
                  width: 80,
                  align: 'right',
                  render: (value?: number) => (typeof value === 'number' ? value.toFixed(4) : '-'),
                },
                {
                  title: '片段',
                  dataIndex: 'text',
                  key: 'text',
                  render: (value?: string) => (
                    <Typography.Paragraph ellipsis={{ rows: 3, expandable: true }} style={{ marginBottom: 0, fontSize: 12.5 }}>
                      {value ?? ''}
                    </Typography.Paragraph>
                  ),
                },
              ]}
            />

            <Collapse
              size="small"
              ghost
              style={{ marginTop: 8 }}
              items={[
                {
                  key: 'debug',
                  label: <Typography.Text style={{ fontSize: 12.5 }}>调试埋点（原始返回）</Typography.Text>,
                  children: <JsonView value={testResult.debug ?? testResult} maxHeight={240} />,
                },
              ]}
            />
          </div>
        ) : (
          <EmptyState title="还没有执行过检索" description="选策略、填问题，回车即可看到召回与耗时" />
        )}
      </Card>

      <Card
        title="检索 Trace"
        style={{ marginTop: 16 }}
        styles={{ body: { paddingTop: 8 } }}
        extra={
          <Space size={8}>
            {selectedTraces.length > 0 ? (
              <Popconfirm
                title={`删除选中的 ${selectedTraces.length} 条调试记录？`}
                description="调试记录只是排查用的临时数据，删除后无法恢复。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteTracesMutation.mutate(selectedTraces)}
              >
                <Button size="small" danger loading={deleteTracesMutation.isPending}>
                  删除选中（{selectedTraces.length}）
                </Button>
              </Popconfirm>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                勾选可批量删除
              </Typography.Text>
            )}
            <Button size="small" onClick={() => void traces.refetch()} loading={traces.isFetching}>
              刷新
            </Button>
          </Space>
        }
      >
        {traces.error ? (
          <ErrorState error={traces.error} title="Trace 加载失败" onRetry={() => void traces.refetch()} />
        ) : null}
        <Tabs
          items={[
            {
              key: 'traces',
              label: `最近 ${traces.data?.length ?? 0} 条`,
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  loading={traces.isLoading}
                  dataSource={traces.data ?? []}
                  pagination={{ pageSize: 10 }}
                  rowSelection={{
                    selectedRowKeys: selectedTraces,
                    onChange: (keys) => setSelectedTraces(keys.map(String)),
                  }}
                  locale={{ emptyText: <EmptyState title="暂无检索 Trace" description="执行调试或线上检索后会产生记录" /> }}
                  expandable={{
                    expandedRowRender: (record) => <JsonView value={record.result} maxHeight={260} />,
                    rowExpandable: (record) => Boolean(record.result),
                  }}
                  columns={[
                    {
                      title: '查询',
                      dataIndex: 'query',
                      key: 'query',
                      render: (value: string) => <Typography.Text>{value}</Typography.Text>,
                    },
                    {
                      title: '耗时',
                      dataIndex: 'durationMs',
                      key: 'durationMs',
                      width: 110,
                      align: 'right',
                      render: (value?: number) => formatDuration(value),
                    },
                    {
                      title: '时间',
                      dataIndex: 'createdAt',
                      key: 'createdAt',
                      width: 170,
                      render: (value: string) => formatDate(value),
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 80,
                      render: (_, record) => (
                        <Popconfirm
                          title="删除这条调试记录？"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => deleteTracesMutation.mutate([record.id])}
                        >
                          <Button size="small" type="link" danger>
                            删除
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>
        </>
      )}

      <Modal
        title="回收站 · 检索策略"
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={
          <Space>
            <Popconfirm
              title="清空回收站？"
              description="回收站里的策略会被彻底删除，无法恢复。"
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => purgeAllMutation.mutate()}
            >
              <Button danger loading={purgeAllMutation.isPending}>
                清空回收站
              </Button>
            </Popconfirm>
            <Button onClick={() => setTrashOpen(false)}>关闭</Button>
          </Space>
        }
        width={720}
      >
        <Table
          rowKey="id"
          size="small"
          loading={trashed.isLoading}
          dataSource={trashed.data ?? []}
          pagination={false}
          locale={{ emptyText: <EmptyState title="回收站是空的" description="删除的检索策略会先放在这里" /> }}
          columns={[
            { title: '策略名称', dataIndex: 'name', key: 'name' },
            {
              title: '删除时间',
              dataIndex: 'deletedAt',
              key: 'deletedAt',
              width: 180,
              render: (value?: string) => formatDate(value),
            },
            {
              title: '操作',
              key: 'actions',
              width: 160,
              render: (_, record) => (
                <Space size={2}>
                  <Button
                    size="small"
                    type="link"
                    loading={restoreMutation.isPending && restoreMutation.variables === record.id}
                    onClick={() => restoreMutation.mutate(record.id)}
                  >
                    恢复
                  </Button>
                  <Popconfirm
                    title="彻底删除？"
                    description="这条策略会从数据库里移除，无法恢复。"
                    okText="彻底删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => purgeMutation.mutate(record.id)}
                  >
                    <Button size="small" type="link" danger>
                      彻底删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Drawer
        title={
          viewing
            ? `查看策略：${viewing.name}`
            : editing
              ? `编辑策略：${editing.name}`
              : '新建检索策略'
        }
        open={creating || Boolean(editing) || Boolean(viewing)}
        width={680}
        onClose={() => {
          setCreating(false);
          setEditing(null);
          setViewing(null);
        }}
        forceRender
        extra={
          <Space>
            <Button
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              取消
            </Button>
            {viewing ? null : (
              <Button
                type="primary"
                loading={saveMutation.isPending}
                disabled={!isJsonValid(formConfig)}
                onClick={() => {
                  profileForm
                    .validateFields()
                    .then((values: { name: string }) =>
                      saveMutation.mutate({ name: values.name, config: formConfig }),
                    )
                    .catch(() => message.warning('请填写策略名称'));
                }}
              >
                保存
              </Button>
            )}
          </Space>
        }
      >
        <Form layout="vertical" form={profileForm} initialValues={{ name: editing?.name }}>
          <Form.Item label="策略名称" name="name" rules={[{ required: true, message: '请输入策略名称' }]}>
            <Input placeholder="例如：制度问答 · 高召回" disabled={Boolean(viewing)} />
          </Form.Item>
        </Form>

        {/* 和 Nacos rag_config 的对比：这里只影响"选中这条策略时"的检索行为，
            但改完不告诉人差在哪，就会出现"界面上一套、引擎跑另一套"的错觉 */}
        <div style={{ marginBottom: 10 }}>
          {profileDiff.length === 0 ? (
            <Typography.Text type="success" style={{ fontSize: 12.5 }}>
              与 Nacos rag_config 当前值一致（引擎默认就是这套参数）
            </Typography.Text>
          ) : (
            <>
              <Space size={8} wrap>
                <Typography.Text type="warning" style={{ fontSize: 12.5 }}>
                  与 Nacos rag_config 当前值有 {profileDiff.length} 处不同：
                </Typography.Text>
                {viewing ? null : (
                  <Button
                    size="small"
                    type="link"
                    onClick={() =>
                      setFormConfig(
                        nacosConfigJson(ragConfig.data?.parsed as Record<string, unknown> | undefined),
                      )
                    }
                  >
                    用 Nacos 当前值填充
                  </Button>
                )}
              </Space>
              <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
                {profileDiff.map((item) => (
                  <Typography.Text key={item.key} type="secondary" style={{ fontSize: 12 }}>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {item.key}
                    </Typography.Text>
                    ：Nacos {item.engine || '—'} → 本策略 {item.profile || '—'}
                  </Typography.Text>
                ))}
              </div>
            </>
          )}
        </div>

        <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
          策略配置（JSON）
        </Typography.Text>
        <JsonEditor value={formConfig} onChange={setFormConfig} rows={22} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          默认值取自 Nacos rag_config（引擎当前生效参数）；这里只影响这条策略被选中时的检索行为。
        </Typography.Paragraph>
      </Drawer>
    </div>
  );
}
