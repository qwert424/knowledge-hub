'use client';

import type {
  PlatformAgent,
  PlatformAgentDetail,
  PlatformGatewayCredential,
  PlatformGatewayKey,
  PlatformGatewayModel,
  PlatformObservation,
  PlatformPromptDetail,
  PlatformPromptRow,
  PlatformSkill,
} from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, formatDateTime } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { InfoNote } from '@/components/InfoNote';
import { useApi } from '@/lib/providers';

/** Nacos 的版本状态枚举不统一（online/reviewing/IN_PROGRESS…）：这里统一成人话+颜色 */
const VERSION_STATUS_MAP: Record<string, { label: string; color: string }> = {
  online: { label: '已上线', color: 'green' },
  published: { label: '已发布', color: 'green' },
  reviewed: { label: '已审核', color: 'blue' },
  review: { label: '待审核', color: 'orange' },
  reviewing: { label: '待审核', color: 'orange' },
  IN_PROGRESS: { label: '审核中', color: 'blue' },
  draft: { label: '草稿', color: 'orange' },
  editing: { label: '编辑中', color: 'orange' },
  offline: { label: '已下线', color: 'default' },
  rejected: { label: '未通过', color: 'red' },
};

function VERSION_STATUS_TAG(value?: string | null) {
  const meta = (value && VERSION_STATUS_MAP[value]) || {
    label: value || '-',
    color: 'default',
  };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/**
 * Langfuse 观测按 traceId 折叠成树后的一行：父行是整条链路，子行是各步骤。
 */
type TraceRow = PlatformObservation & { key?: string; children?: TraceRow[] };

/**
 * 平台集成控制台。
 *
 * 平台的"智能"部分并不全在库里：Agent 定义、AGENTS.md 指令、Prompt、Skill 在 Nacos，
 * 模型与虚拟密钥在 LiteLLM，链路追踪在 Langfuse。这里把它们收进一个页面，
 * 管理员不用在三个控制台之间来回切。
 */
export default function PlatformPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [agentName, setAgentName] = useState<string | null>(null);
  const [promptKey, setPromptKey] = useState<string | null>(null);
  const [instructionDraft, setInstructionDraft] = useState<string | null>(null);
  const [contentDraft, setContentDraft] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);

  const agents = useQuery({ queryKey: ['platform-agents'], queryFn: () => api.integrations.agents() });
  const prompts = useQuery({ queryKey: ['platform-prompts'], queryFn: () => api.integrations.prompts() });
  const skills = useQuery({ queryKey: ['platform-skills'], queryFn: () => api.integrations.skills() });
  const gatewayModels = useQuery({
    queryKey: ['platform-gateway-models'],
    queryFn: () => api.integrations.gatewayModels(),
  });
  const gatewayKeys = useQuery({
    queryKey: ['platform-gateway-keys'],
    queryFn: () => api.integrations.gatewayKeys(),
  });
  const gatewayCredentials = useQuery({
    queryKey: ['platform-gateway-credentials'],
    queryFn: () => api.integrations.gatewayCredentials(),
    retry: false,
  });
  const nacosConsole = useQuery({
    queryKey: ['platform-nacos-console'],
    queryFn: () => api.integrations.nacosConsoleUrl(),
    staleTime: 10 * 60_000,
  });
  /** 三套外部平台入口（地址来自 .env，换环境不用改代码） */
  const platformLinks = useQuery({
    queryKey: ['platform-links'],
    queryFn: () => api.integrations.links(),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const ragConfig = useQuery({
    queryKey: ['platform-rag-config'],
    queryFn: () => api.integrations.ragConfig(),
  });

  /** 引擎中间件开关：读 Nacos 的 knowledge-hub.yaml，改完发布 + reload */
  const agentConfig = useQuery({
    queryKey: ['platform-agent-config'],
    queryFn: () => api.integrations.agentConfig(),
    retry: false,
  });
  const [switches, setSwitches] = useState({ plan: true, review: true, securityScan: true });
  useEffect(() => {
    const data = agentConfig.data?.switches;
    if (data) {
      setSwitches({ plan: data.plan, review: data.review, securityScan: data.securityScan });
    }
  }, [agentConfig.data]);
  const saveSwitches = useMutation({
    mutationFn: (values: { plan: boolean; review: boolean; securityScan: boolean }) =>
      api.integrations.saveAgentSwitches(values),
    onSuccess: (result) => {
      message.success(
        result.reloaded ? '已发布并让引擎重新加载' : '已发布到 Nacos；引擎没回 reload，下次配置刷新生效',
      );
      void agentConfig.refetch();
    },
    onError: (error: Error) => message.error(error.message || '保存失败'),
  });
  const [ragDraft, setRagDraft] = useState('');
  const publishRag = useMutation({
    mutationFn: (content: string) => api.integrations.publishRagConfig(content),
    onSuccess: () => {
      message.success('已发布到 Nacos 的 rag_config');
      void queryClient.invalidateQueries({ queryKey: ['platform-rag-config'] });
      void queryClient.invalidateQueries({ queryKey: ['rag-config'] });
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });
  const traces = useQuery({
    queryKey: ['platform-langfuse'],
    queryFn: () => api.integrations.langfuseTraces(100),
    refetchInterval: 30_000,
  });
  const spend = useQuery({
    queryKey: ['platform-gateway-spend'],
    queryFn: () => api.integrations.gatewaySpend(14),
    refetchInterval: 60_000,
    retry: false,
  });

  const agentDetail = useQuery({
    queryKey: ['platform-agent', agentName],
    queryFn: () => api.integrations.agent(agentName as string),
    enabled: Boolean(agentName),
  });

  const promptDetail = useQuery({
    queryKey: ['platform-prompt', promptKey],
    queryFn: () => api.integrations.prompt(promptKey as string),
    enabled: Boolean(promptKey),
  });

  const saveAgent = useMutation({
    mutationFn: (payload: { name: string; description?: string; content: string; instruction: string }) =>
      api.integrations.saveAgent(payload.name, {
        description: payload.description,
        content: payload.content,
        instruction: payload.instruction,
      }),
    onSuccess: (result) => {
      message.success(`已发布 ${result.name} ${result.version}`);
      void queryClient.invalidateQueries({ queryKey: ['platform-agents'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-agent'] });
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });

  const savePrompt = useMutation({    mutationFn: (payload: { key: string; template: string; description?: string }) =>
      api.integrations.savePrompt(payload.key, {
        template: payload.template,
        description: payload.description,
      }),
    onSuccess: () => {
      message.success('Prompt 已发布新版本');
      void queryClient.invalidateQueries({ queryKey: ['platform-prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-prompt'] });
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });

  /** Nacos 的发布：把某个已审核版本推成 latest，引擎下一次加载即生效 */
  const publishAgentVersion = useMutation({
    mutationFn: (payload: { name: string; version: string }) =>
      api.integrations.publishAgent(payload.name, payload.version),
    onSuccess: (result) => {
      message.success(`已发布 ${result.name} ${result.version}，引擎下次加载生效`);
      void queryClient.invalidateQueries({ queryKey: ['platform-agents'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-agent'] });
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });

  /** 切换 Agent 的 production 标签：只在版本已发布（online）后可用 */
  const setAgentLabel = useMutation({
    mutationFn: (payload: { name: string; version: string }) =>
      api.integrations.setAgentLabel(payload.name, 'production', payload.version),
    onSuccess: (result) => {
      message.success(
        result.reloaded
          ? `已把 ${result.version} 设为 production，引擎已重新加载`
          : `已把 ${result.version} 设为 production；引擎没回 reload，下次配置刷新生效`,
      );
      void queryClient.invalidateQueries({ queryKey: ['platform-agents'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-agent'] });
    },
    onError: (error: Error) => message.error(error.message || '切换标签失败'),
  });

  const toggleAgentOnline = useMutation({
    mutationFn: (payload: { name: string; online: boolean }) =>
      api.integrations.setAgentOnline(payload.name, payload.online),
    onSuccess: (result) => {
      message.success(`${result.name} 已${result.enable ? '上线' : '下线'}`);
      void queryClient.invalidateQueries({ queryKey: ['platform-agents'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-agent'] });
    },
    onError: (error: Error) => message.error(error.message || '操作失败'),
  });

  const publishPromptVersion = useMutation({
    mutationFn: (payload: { key: string; version: string }) =>
      api.integrations.publishPrompt(payload.key, payload.version),
    onSuccess: (result) => {
      message.success(`Prompt ${result.key} 已发布 ${result.version}`);
      void queryClient.invalidateQueries({ queryKey: ['platform-prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-prompt'] });
    },
    onError: (error: Error) => message.error(error.message || '发布失败'),
  });

  /** 切换 production 标签（Nacos prompt 有公开的 label 接口，agent 没有） */
  const setPromptLabel = useMutation({
    mutationFn: (payload: { key: string; version: string }) =>
      api.integrations.setPromptLabel(payload.key, 'production', payload.version),
    onSuccess: (result) => {
      message.success(`已把 ${result.version} 设为 production，引擎下次加载生效`);
      void queryClient.invalidateQueries({ queryKey: ['platform-prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-prompt'] });
    },
    onError: (error: Error) => message.error(error.message || '切换失败'),
  });

  const agentColumns: ColumnsType<PlatformAgent> = [
    {
      title: 'Agent',
      dataIndex: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    { title: '说明', dataIndex: 'description', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'enable',
      width: 90,
      render: (enable: boolean) => (enable ? <Tag color="green">已上线</Tag> : <Tag>已下线</Tag>),
    },
    {
      title: '操作',
      width: 190,
      render: (_, row) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setAgentName(row.name);
              setInstructionDraft(null);
              setContentDraft(null);
            }}
          >
            查看 / 编辑
          </Button>
          <Popconfirm
            title={row.enable ? '下线这个 Agent？' : '上线这个 Agent？'}
            description={row.enable ? '下线后引擎不会再加载它' : '上线后引擎可以加载生产版本'}
            okText="确认"
            cancelText="取消"
            onConfirm={() => toggleAgentOnline.mutate({ name: row.name, online: !row.enable })}
          >
            <Button size="small" type="link" danger={row.enable} loading={toggleAgentOnline.isPending}>
              {row.enable ? '下线' : '上线'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const promptColumns: ColumnsType<PlatformPromptRow> = [
    {
      title: 'Prompt Key',
      dataIndex: 'key',
      render: (key: string) => <Typography.Text strong>{key}</Typography.Text>,
    },
    { title: '说明', dataIndex: 'description', ellipsis: true },
    {
      title: '版本标签',
      key: 'version',
      width: 170,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          {/* 只展示线上标签与 latest：草稿/待审核在抽屉里看，表格里堆一堆反而看不清哪个在跑 */}
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            production · {row.version || '未发布'}
          </Tag>
          {row.latestVersion && row.latestVersion !== row.version ? (
            <Tag style={{ marginInlineEnd: 0 }}>latest · {row.latestVersion}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 110,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => {
            setPromptKey(row.key);
            setTemplateDraft(null);
          }}
        >
          查看 / 编辑
        </Button>
      ),
    },
  ];

  const skillColumns: ColumnsType<PlatformSkill> = [
    {
      title: 'Skill',
      dataIndex: 'name',
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '版本', dataIndex: 'version', width: 90, render: (v: string) => <Tag>{v || '-'}</Tag> },
    {
      title: '操作',
      width: 140,
      render: (_, row) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() =>
              Modal.info({
                title: `Skill · ${row.name}`,
                width: 560,
                content: (
                  <div>
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{row.description}</Typography.Paragraph>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      技能包的内容在 Nacos 里维护（版本 {row.version || '-'}）；引擎调用时会把包解压到沙箱共享卷，并把 SKILL.md 放进上下文。
                    </Typography.Text>
                  </div>
                ),
              })
            }
          >
            查看说明
          </Button>
        </Space>
      ),
    },
  ];

  /** 网关里的用途枚举 -> 人话，避免整列都显示 chat */
  const MODE_TEXT: Record<string, { text: string; color?: string }> = {
    chat: { text: '对话', color: 'blue' },
    embedding: { text: '向量', color: 'purple' },
    rerank: { text: '重排', color: 'geekblue' },
    image: { text: '图像', color: 'magenta' },
    audio: { text: '语音', color: 'orange' },
    fallback: { text: '备用', color: 'default' },
  };

  const gatewayColumns: ColumnsType<PlatformGatewayModel> = [
    {
      title: '模型别名',
      dataIndex: 'id',
      render: (id: string) => <Typography.Text strong>{id}</Typography.Text>,
    },
    { title: '上游模型', dataIndex: 'upstream', ellipsis: true },
    {
      title: '来源 / 凭证',
      key: 'credential',
      width: 200,
      ellipsis: true,
      render: (_, row) => {
        const parts = [row.provider, row.credential].filter(Boolean);
        if (parts.length === 0) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        return (
          <Tooltip title={[row.provider, row.credential, row.apiBase].filter(Boolean).join(' · ')}>
            <Typography.Text ellipsis style={{ maxWidth: 190, fontSize: 12 }}>
              {parts.join(' · ')}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: '用途',
      dataIndex: 'mode',
      width: 90,
      render: (value: string) => {
        const meta = MODE_TEXT[value] ?? { text: value };
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    {
      title: '最大 tokens',
      dataIndex: 'maxTokens',
      width: 120,
      render: (value: number) =>
        value > 0 ? (
          value.toLocaleString()
        ) : (
          <Tooltip title="网关没配 max_tokens，按上游模型默认值执行">
            <Typography.Text type="secondary">上游默认</Typography.Text>
          </Tooltip>
        ),
    },
  ];

  const keyColumns: ColumnsType<PlatformGatewayKey> = [
    {
      title: '密钥',
      dataIndex: 'key',
      render: (value: string, row) =>
        row.keyName ? (
          <Space size={6}>
            <Typography.Text strong>{row.keyName}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value.slice(0, 8)}…
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {value.slice(0, 12)}…
          </Typography.Text>
        ),
    },
    { title: '别名', dataIndex: 'alias', width: 160, render: (value: string) => value || '-' },
    {
      title: '可用模型',
      key: 'models',
      render: (_, row) =>
        row.models && row.models.length > 0 ? (
          <Space size={4} wrap>
            {row.models.slice(0, 3).map((model) => (
              <Tag key={model}>{model}</Tag>
            ))}
            {row.models.length > 3 ? <Tag>+{row.models.length - 3}</Tag> : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">全部</Typography.Text>
        ),
    },
    {
      title: '已用',
      dataIndex: 'spend',
      width: 110,
      render: (value: number) => (value > 0 ? `$${value.toFixed(4)}` : '$0'),
    },
    {
      title: '预算',
      dataIndex: 'maxBudget',
      width: 110,
      render: (value: number) => (value > 0 ? `$${value.toFixed(2)}` : '不限'),
    },
  ];

  const credentialColumns: ColumnsType<PlatformGatewayCredential> = [
    {
      title: '凭证名',
      dataIndex: 'name',
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
    },
    { title: 'Provider', dataIndex: 'provider', width: 160, render: (value: string) => value || '-' },
    { title: 'API Base', dataIndex: 'apiBase', ellipsis: true, render: (value: string) => value || '-' },
    {
      title: 'Key',
      dataIndex: 'apiKey',
      width: 170,
      render: (value: string) =>
        !value ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : /^\*+$/.test(value) ? (
          <Tag color="green">已配置（掩码）</Tag>
        ) : (
          <Typography.Text code>{value}</Typography.Text>
        ),
    },
  ];

  const traceColumns: ColumnsType<TraceRow> = [
    { title: '时间', dataIndex: 'startTime', width: 165, render: (value: string) => formatDateTime(value) },
    {
      title: '类型',
      dataIndex: 'type',
      width: 100,
      render: (value: string) => {
        const map: Record<string, { label: string; color: string }> = {
          TRACE: { label: '链路', color: 'purple' },
          GENERATION: { label: '模型调用', color: 'blue' },
          SPAN: { label: '步骤', color: 'default' },
          EVENT: { label: '事件', color: 'default' },
          TOOL: { label: '工具', color: 'geekblue' },
        };
        const meta = map[value] ?? { label: value || '-', color: 'default' };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { title: '名称', dataIndex: 'name', ellipsis: true },
    {
      title: '模型',
      dataIndex: 'model',
      width: 190,
      ellipsis: true,
      render: (value: string) => value || <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: '耗时',
      dataIndex: 'latency',
      width: 90,
      render: (value: number) => (value ? `${value.toFixed(2)}s` : '-'),
    },
    {
      title: 'tokens（入/出）',
      width: 140,
      render: (_, row) =>
        row.inputTokens || row.outputTokens ? `${row.inputTokens} / ${row.outputTokens}` : '-',
    },
    {
      title: '成本',
      dataIndex: 'totalCost',
      width: 110,
      render: (value: number) => (value ? `$${value.toFixed(6)}` : '-'),
    },
    {
      title: '链路',
      width: 90,
      render: (_, row) => {
        const host = traces.data?.host ?? '';
        if (!host || !row.traceId) {
          return '-';
        }
        // Langfuse v4 的链路地址带 projectId，少了它必然 404
        const href = row.projectId
          ? `${host}/project/${row.projectId}/traces/${row.traceId}`
          : `${host}/trace/${row.traceId}`;
        return (
          <Button size="small" type="link" href={href} target="_blank" rel="noreferrer">
            打开
          </Button>
        );
      },
    },
  ];

  const detail: PlatformAgentDetail | undefined = agentDetail.data;
  const prompt: PlatformPromptDetail | undefined = promptDetail.data;

  /** 和线上版本逐字段比：没改动就不该让"发布新版本"可点（会产生一个空版本） */
  const agentDirty = Boolean(
    detail &&
      ((contentDraft !== null && contentDraft !== detail.content) ||
        (instructionDraft !== null && instructionDraft !== detail.instruction)),
  );
  const promptDirty = Boolean(prompt && templateDraft !== null && templateDraft !== prompt.template);
  const observations = traces.data?.observations ?? [];
  const totalCost = observations.reduce((sum, item) => sum + (item.totalCost || 0), 0);
  const totalCalls = observations.length;
  const avgLatency = totalCalls
    ? observations.reduce((sum, item) => sum + (item.latency || 0), 0) / totalCalls
    : 0;

  /**
   * 同一 trace 的观测分层看：一次问答 = 检索 → 模型调用 → 工具调用。
   * 平铺成一张表看不出哪几步属于同一个链路，所以按 traceId 折叠成树。
   */
  const traceTree = useMemo<TraceRow[]>(() => {
    const groups = new Map<string, PlatformObservation[]>();
    for (const item of observations) {
      const key = item.traceId || item.id;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([traceId, items]) => {
      const sorted = [...items].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      const root = sorted.find((item) => !item.parentObservationId) ?? sorted[0];
      const tokens = sorted.reduce((sum, item) => sum + (item.inputTokens || 0) + (item.outputTokens || 0), 0);
      const cost = sorted.reduce((sum, item) => sum + (item.totalCost || 0), 0);
      const latency = sorted.reduce((sum, item) => sum + (item.latency || 0), 0);
      return {
        key: traceId,
        id: traceId,
        traceId,
        projectId: root?.projectId,
        type: 'TRACE',
        name: `${root?.name || '链路'} · ${sorted.length} 步`,
        model: '',
        startTime: sorted[0]?.startTime ?? '',
        latency,
        inputTokens: 0,
        outputTokens: tokens,
        totalCost: cost,
        level: '',
        children: sorted.map((item) => ({ ...item, key: item.id })),
      };
    });
  }, [observations]);

  return (
    <div>
      <PageHeader
        title="平台集成"
        description="Agent / 提示词 / Skill 来自 Nacos，模型与密钥来自 LiteLLM 网关，链路追踪来自 Langfuse"
        extra={
          <Space size={8} wrap>
            {(platformLinks.data ?? []).map((item) =>
              item.url ? (
                <Tooltip key={item.name} title={item.description}>
                  <Button size="small" href={item.url} target="_blank" rel="noreferrer">
                    {item.name}
                  </Button>
                </Tooltip>
              ) : null,
            )}
            <Button
              size="small"
              loading={agents.isFetching || prompts.isFetching || gatewayModels.isFetching}
              onClick={() => {
                void agents.refetch();
                void prompts.refetch();
                void skills.refetch();
                void gatewayModels.refetch();
                void gatewayKeys.refetch();
                void gatewayCredentials.refetch();
              }}
            >
              刷新
            </Button>
          </Space>
        }
      />

      <Tabs
        defaultActiveKey="agent"
        items={[
          {
            key: 'agent',
            label: `Agent（${(agents.data ?? []).length}）`,
            children: agents.isError ? (
              <ErrorState error={agents.error} title="读取 Nacos 失败" onRetry={() => void agents.refetch()} />
            ) : (
              <Card title="Agent 定义">
                <Table
                  rowKey="name"
                  size="small"
                  loading={agents.isLoading}
                  dataSource={agents.data ?? []}
                  columns={agentColumns}
                  pagination={false}
                />

                <Card
                  size="small"
                  title="中间件开关（Nacos knowledge-hub.yaml → agent.*）"
                  style={{ marginTop: 16 }}
                  extra={
                    <Space size={8}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {agentConfig.data
                          ? `${agentConfig.data.dataId} / ${agentConfig.data.group}`
                          : '未读取'}
                      </Typography.Text>
                      <Button
                        size="small"
                        type="primary"
                        loading={saveSwitches.isPending}
                        onClick={() => saveSwitches.mutate(switches)}
                      >
                        保存并生效
                      </Button>
                    </Space>
                  }
                >
                  <InfoNote title="三个中间件">
                    规划（先出计划再调用工具）、复核（答案自查后改写一次）、安全扫描（拦截提示词回显/密钥/内网地址）。
                    保存会合并进 Nacos 配置并让引擎立即 reload，不用重启容器。
                  </InfoNote>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space size={10}>
                      <Switch
                        checked={switches.plan}
                        onChange={(checked) => setSwitches((prev) => ({ ...prev, plan: checked }))}
                      />
                      <Typography.Text>规划（plan_enabled）</Typography.Text>
                    </Space>
                    <Space size={10}>
                      <Switch
                        checked={switches.review}
                        onChange={(checked) => setSwitches((prev) => ({ ...prev, review: checked }))}
                      />
                      <Typography.Text>复核（review_enabled）</Typography.Text>
                    </Space>
                    <Space size={10}>
                      <Switch
                        checked={switches.securityScan}
                        onChange={(checked) => setSwitches((prev) => ({ ...prev, securityScan: checked }))}
                      />
                      <Typography.Text>安全扫描（security_scan_enabled）</Typography.Text>
                    </Space>
                  </Space>
                </Card>
              </Card>
            ),
          },
          {
            key: 'prompt',
            label: `提示词（${(prompts.data ?? []).length}）`,
            children: (
              <Card
                size="small"
                title="Prompt 资源"
                extra={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Agent 通过 link_prompts 引用这里的 key，发布后下次加载即生效
                  </Typography.Text>
                }
              >
                <Table
                  rowKey="key"
                  size="small"
                  loading={prompts.isLoading}
                  dataSource={prompts.data ?? []}
                  columns={promptColumns}
                  pagination={false}
                />
              </Card>
            ),
          },
          {
            key: 'skill',
            label: `Skill（${(skills.data ?? []).length}）`,
            children: (
              <Card
                size="small"
                title="技能包（沙箱可执行）"
                extra={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Agent 的 skills 字段引用这里的名字
                  </Typography.Text>
                }
              >
                {(skills.data ?? []).length === 0 ? (
                  <EmptyState title="还没有 Skill" description="在 Nacos 上传技能包后这里会出现" />
                ) : (
                  <Table
                    rowKey="name"
                    size="small"
                    loading={skills.isLoading}
                    dataSource={skills.data ?? []}
                    columns={skillColumns}
                    pagination={false}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'gateway',
            label: `模型网关（${(gatewayModels.data ?? []).length}）`,
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <InfoNote title="模型都从这里走">
                  业务不直连厂商：对话、向量、重排、图像都过网关，流量的账单与配额在网关上算。
                  模型别名改了这里就生效，不用改代码。
                </InfoNote>
                <Row gutter={16}>
                  <Col span={24}>
                    <Card title="网关提供的模型" size="small">
                      <Table
                        rowKey="id"
                        size="small"
                        loading={gatewayModels.isLoading}
                        dataSource={gatewayModels.data ?? []}
                        columns={gatewayColumns}
                        pagination={false}
                      />
                    </Card>
                  </Col>
                </Row>
                <Card
                  title="虚拟密钥"
                  size="small"
                  extra={<Tag>{(gatewayKeys.data ?? []).length} 个</Tag>}
                >
                  <Table
                    rowKey="key"
                    size="small"
                    loading={gatewayKeys.isLoading}
                    dataSource={gatewayKeys.data ?? []}
                    columns={keyColumns}
                    pagination={false}
                  />
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    网关只回显哈希前缀；别名、额度与花费是逐条查 /key/info 补的。
                    网关闭源在 /ui 里，需要它自己的账号登录，API Key 不能当会话用；要改模型就点右上角的「LiteLLM 网关」。
                  </Typography.Paragraph>
                </Card>
                <Card
                  size="small"
                  title="上游凭证（Provider Credentials）"
                  extra={<Tag>{(gatewayCredentials.data ?? []).length} 个</Tag>}
                >
                  {gatewayCredentials.error ? (
                    <ErrorState
                      error={gatewayCredentials.error}
                      title="读不到凭证列表"
                      onRetry={() => void gatewayCredentials.refetch()}
                    />
                  ) : (
                    <Table
                      rowKey="name"
                      size="small"
                      loading={gatewayCredentials.isLoading}
                      dataSource={gatewayCredentials.data ?? []}
                      columns={credentialColumns}
                      pagination={{ pageSize: 8, size: 'small' }}
                      locale={{
                        emptyText: (
                          <EmptyState
                            title="暂无凭证"
                            description="网关里还没配置厂商账号；在网关控制台添加后会出现在这里（值只显示掩码）"
                          />
                        ),
                      }}
                    />
                  )}
                </Card>
              </Space>
            ),
          },
          {
            key: 'langfuse',
            label: '调用记录与成本',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Card
                  size="small"
                  title="网关成本（近 14 天，按天与按模型）"
                  extra={
                    <Button size="small" onClick={() => void spend.refetch()} loading={spend.isFetching}>
                      刷新
                    </Button>
                  }
                >
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                    账单价来自网关聚合；逐请求明细（tokens / 成本 / 类型）在 LiteLLM 的 /ui 里，需要它自己的账号登录。
                    下面的「最近调用」是 Langfuse 采样的真实链路。
                  </Typography.Paragraph>
                  <Row gutter={16}>
                    <Col span={12}>
                      <Table
                        rowKey="model"
                        size="small"
                        loading={spend.isLoading}
                        dataSource={spend.data?.byModel ?? []}
                        pagination={false}
                        locale={{ emptyText: <EmptyState title="暂无成本数据" description="网关还没有产生调用" /> }}
                        columns={[
                          { title: '模型', dataIndex: 'model', ellipsis: true },
                          {
                            title: '成本（美元）',
                            dataIndex: 'spend',
                            width: 130,
                            align: 'right',
                            render: (value: number) => `$${value.toFixed(5)}`,
                          },
                        ]}
                      />
                    </Col>
                    <Col span={12}>
                      <Table
                        rowKey="date"
                        size="small"
                        loading={spend.isLoading}
                        dataSource={[...(spend.data?.daily ?? [])].reverse()}
                        pagination={{ pageSize: 6, size: 'small' }}
                        locale={{ emptyText: <EmptyState title="暂无按天数据" /> }}
                        columns={[
                          { title: '日期', dataIndex: 'date', width: 110 },
                          {
                            title: '成本（美元）',
                            dataIndex: 'spend',
                            width: 120,
                            align: 'right',
                            render: (value: number) => `$${value.toFixed(5)}`,
                          },
                          {
                            title: '主要模型',
                            key: 'models',
                            render: (_, row) =>
                              row.models.length > 0 ? (
                                <Space size={4} wrap>
                                  {row.models.slice(0, 2).map((model) => (
                                    <Tag key={model.model}>{model.model}</Tag>
                                  ))}
                                </Space>
                              ) : (
                                '-'
                              ),
                          },
                        ]}
                      />
                    </Col>
                  </Row>
                </Card>

                <Card size="small" title="最近调用（Langfuse 链路）">
                  {!traces.data?.configured ? (
                    <Alert
                      type="warning"
                      showIcon
                      message="Langfuse 未配置密钥"
                      description="在 .env 里填 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 后即可在此看到线上调用。"
                    />
                  ) : (
                    <>
                      <Row gutter={16} style={{ marginBottom: 12 }}>
                        <Col span={8}>
                          <Statistic title={`最近采样观测（${traceTree.length} 条链路）`} value={totalCalls} />
                        </Col>
                        <Col span={8}>
                          <Statistic title="累计成本（美元）" value={totalCost.toFixed(5)} />
                        </Col>
                        <Col span={8}>
                          <Statistic title="平均耗时（秒）" value={avgLatency.toFixed(2)} />
                        </Col>
                      </Row>
                      <Table
                        rowKey="id"
                        size="small"
                        loading={traces.isLoading}
                        dataSource={traceTree}
                        columns={traceColumns}
                        expandable={{ defaultExpandAllRows: false }}
                        pagination={{ pageSize: 8 }}
                      />
                    </>
                  )}
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={detail ? `Agent · ${detail.name}` : 'Agent'}
        width={760}
        open={Boolean(agentName)}
        onClose={() => setAgentName(null)}
        extra={
          <Space>
            <Button onClick={() => setAgentName(null)}>关闭</Button>
            <Tooltip
              title={
                detail && !agentDirty
                  ? `内容和线上（${detail.productVersion || detail.version || '-'}）一致，改点什么再发布`
                  : '保存为草稿并提交审核；发布后可以切 production 标签'
              }
            >
              <Button
                type="primary"
                loading={saveAgent.isPending}
                disabled={!detail || !agentDirty}
                onClick={() =>
                  detail &&
                  saveAgent.mutate({
                    name: detail.name,
                    description: detail.description,
                    content: contentDraft ?? detail.content,
                    instruction: instructionDraft ?? detail.instruction,
                  })
                }
              >
                发布新版本
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {detail ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="版本标签">
                <Space size={6} wrap>
                  <Tag color="green">production · {detail.productVersion || detail.version || '-'}</Tag>
                  <Tag>latest · {detail.latestVersion || '-'}</Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="link_prompts">
                {detail.linkPrompts && detail.linkPrompts.length > 0 ? (
                  <Space size={4} wrap>
                    {detail.linkPrompts.map((item) => (
                      <Tag key={item}>{item}</Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">未引用</Typography.Text>
                )}
              </Descriptions.Item>
            </Descriptions>

            {detail.productVersion && detail.latestVersion && detail.productVersion !== detail.latestVersion ? (
              <InfoNote
                title="线上版本落后"
                items={[
                  `production 还停在 ${detail.productVersion}，latest 已经是 ${detail.latestVersion}。`,
                  '引擎读的是 production：只发布 latest 不会让线上生效，还要把 production 切过去。',
                ]}
                extra={
                  <Button
                    size="small"
                    type="primary"
                    loading={setAgentLabel.isPending}
                    onClick={() =>
                      setAgentLabel.mutate({ name: detail.name, version: detail.latestVersion as string })
                    }
                  >
                    把 {detail.latestVersion} 设为 production
                  </Button>
                }
              />
            ) : null}

            <Card size="small" title="版本历史（发布 / 审核状态）">
              <Table
                rowKey="version"
                size="small"
                dataSource={detail.versions ?? []}
                pagination={false}
                locale={{ emptyText: <EmptyState title="还没有版本记录" /> }}
                columns={[
                  {
                    title: '版本',
                    dataIndex: 'version',
                    width: 90,
                    render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 110,
                    render: (value: string) => VERSION_STATUS_TAG(value),
                  },
                  {
                    title: '审核流水线',
                    dataIndex: 'pipelineStatus',
                    width: 110,
                    render: (value?: string) => {
                      if (!value) {
                        return <Typography.Text type="secondary">-</Typography.Text>;
                      }
                      const map: Record<string, { label: string; color: string }> = {
                        APPROVED: { label: '通过', color: 'green' },
                        IN_PROGRESS: { label: '进行中', color: 'blue' },
                        REJECTED: { label: '未通过', color: 'red' },
                        FAILED: { label: '失败', color: 'red' },
                      };
                      const meta = map[value] ?? { label: value, color: 'default' };
                      return <Tag color={meta.color}>{meta.label}</Tag>;
                    },
                  },
                  {
                    title: '更新',
                    dataIndex: 'updateTime',
                    width: 150,
                    render: (value: number) => formatDateTime(value),
                  },
                  {
                    title: '操作',
                    key: 'actions',
                    width: 150,
                    render: (_, row) => {
                      const isLatest = row.version === detail.latestVersion;
                      const isProduction = row.version === (detail.productVersion || detail.version);
                      if (isLatest && isProduction) {
                        return (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            已是最新线上版
                          </Typography.Text>
                        );
                      }
                      if (!isLatest) {
                        return (
                          <Popconfirm
                            title={`发布 ${row.version}？`}
                            description={`发布后 latest 变成 ${row.version}；如需线上生效，再把它设为 production。`}
                            okText="发布"
                            cancelText="取消"
                            onConfirm={() =>
                              publishAgentVersion.mutate({ name: detail.name, version: row.version })
                            }
                          >
                            <Button
                              size="small"
                              type="link"
                              disabled={row.status === 'reviewing' || row.status === 'draft'}
                              loading={publishAgentVersion.isPending}
                            >
                              发布
                            </Button>
                          </Popconfirm>
                        );
                      }
                      // 只有发布过的版本才能设 production，否则引擎会加载一个没过审核的版本
                      return (
                        <Popconfirm
                          title={`把 ${row.version} 设为 production？`}
                          description="引擎下一次加载就会用这一版，当前线上版本会被替换。"
                          okText="切换"
                          cancelText="取消"
                          onConfirm={() => setAgentLabel.mutate({ name: detail.name, version: row.version })}
                        >
                          <Button
                            size="small"
                            type="link"
                            disabled={row.status !== 'online'}
                            loading={setAgentLabel.isPending}
                          >
                            设为 production
                          </Button>
                        </Popconfirm>
                      );
                    },
                  },
                ]}
              />
            </Card>

            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>配置 JSON</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  与线上（{detail.productVersion || detail.version || '-'}）比对：
                  {contentDraft !== null && contentDraft !== detail.content ? '有改动' : '未改动'}
                </Typography.Text>
              </Space>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
                model（name / thinking）、tools、subagents、skills、link_prompts 都在这份 JSON 里。
              </Typography.Paragraph>
              <Input.TextArea
                value={contentDraft ?? detail.content}
                onChange={(event) => setContentDraft(event.target.value)}
                autoSize={{ minRows: 10, maxRows: 22 }}
                style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
              />
            </div>
            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text strong>AGENTS.md 指令</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {instructionDraft !== null && instructionDraft !== detail.instruction ? '有改动' : '未改动'}
                </Typography.Text>
              </Space>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
                这段正文会和 link_prompts 一起组成引擎的系统提示词。
              </Typography.Paragraph>
              <Input.TextArea
                value={instructionDraft ?? detail.instruction}
                onChange={(event) => setInstructionDraft(event.target.value)}
                autoSize={{ minRows: 10, maxRows: 22 }}
                style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
              />
            </div>
          </Space>
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        )}
      </Drawer>

      <Drawer
        title={prompt ? `Prompt · ${prompt.key}` : 'Prompt'}
        width={720}
        open={Boolean(promptKey)}
        onClose={() => setPromptKey(null)}
        extra={
          <Space>
            <Button onClick={() => setPromptKey(null)}>关闭</Button>
            <Tooltip
              title={
                prompt && !promptDirty
                  ? `模板和线上（${prompt.version || '-'}）一致，改点什么再发布`
                  : '发布后生成新版本，引擎下一次加载即生效'
              }
            >
              <Button
                type="primary"
                loading={savePrompt.isPending}
                disabled={!prompt || !promptDirty}
                onClick={() =>
                  prompt &&
                  savePrompt.mutate({
                    key: prompt.key,
                    template: templateDraft ?? prompt.template,
                    description: prompt.description,
                  })
                }
              >
                发布新版本
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {prompt ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="版本标签">
                <Space size={6} wrap>
                  <Tag color="green">production · {prompt.productionVersion || '-'}</Tag>
                  <Tag>latest · {prompt.latestVersion || prompt.version || '-'}</Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="说明">{prompt.description || '-'}</Descriptions.Item>
            </Descriptions>

            {prompt.productionVersion &&
            prompt.latestVersion &&
            prompt.productionVersion !== prompt.latestVersion ? (
              <InfoNote
                title="线上版本落后"
                items={[
                  `production 还停在 ${prompt.productionVersion}，latest 已经是 ${prompt.latestVersion}。`,
                  '引擎读的是 production：只发布 latest 不会让线上生效，还要在下表把 production 切过去。',
                ]}
              />
            ) : null}
            <Card size="small" title="历史版本">
              <Table
                rowKey="version"
                size="small"
                dataSource={prompt.versions ?? []}
                pagination={false}
                locale={{ emptyText: <EmptyState title="还没有版本记录" /> }}
                columns={[
                  {
                    title: '版本',
                    dataIndex: 'version',
                    width: 90,
                    render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 110,
                    render: (value: string) => VERSION_STATUS_TAG(value),
                  },
                  {
                    title: '更新',
                    dataIndex: 'updateTime',
                    width: 150,
                    render: (value: number) => formatDateTime(value),
                  },
                  {
                    title: '操作',
                    key: 'actions',
                    width: 210,
                    render: (_, row) => {
                      const isProduction = row.version === (prompt.productionVersion || '');
                      const isLatest = row.version === (prompt.latestVersion || prompt.version);
                      if (isProduction) {
                        return (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            已是 production
                          </Typography.Text>
                        );
                      }
                      return (
                        <Space size={4}>
                          {row.status === 'online' || row.status === 'reviewed' ? (
                            <Popconfirm
                              title={`把 ${row.version} 设为 production？`}
                              description={`线上当前是 ${prompt.productionVersion || '未设置'}，切换后引擎下一次加载就用这一版`}
                              okText="切换"
                              cancelText="取消"
                              onConfirm={() => setPromptLabel.mutate({ key: prompt.key, version: row.version })}
                            >
                              <Button size="small" type="link" loading={setPromptLabel.isPending}>
                                设 production
                              </Button>
                            </Popconfirm>
                          ) : (
                            <Tooltip title="这个版本还没发布，先点「发布」推到线上">
                              <Button size="small" type="link" disabled>
                                设 production
                              </Button>
                            </Tooltip>
                          )}
                          {isLatest ? null : (
                            <Button
                              size="small"
                              type="link"
                              loading={publishPromptVersion.isPending}
                              onClick={() =>
                                publishPromptVersion.mutate({ key: prompt.key, version: row.version })
                              }
                            >
                              发布
                            </Button>
                          )}
                        </Space>
                      );
                    },
                  },
                ]}
              />
            </Card>
            <Input.TextArea
              value={templateDraft ?? prompt.template}
              onChange={(event) => setTemplateDraft(event.target.value)}
              autoSize={{ minRows: 16, maxRows: 30 }}
              style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }}
            />
          </Space>
        ) : (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        )}
      </Drawer>
    </div>
  );
}
