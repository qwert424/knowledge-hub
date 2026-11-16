'use client';

import { ErrorState, PageHeader, JsonView } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Descriptions, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { HealthPanel } from '@/components/HealthPanel';
import { InfoNote } from '@/components/InfoNote';
import { useApi, useAuth } from '@/lib/providers';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8088';

export default function SettingsPage() {
  const api = useApi();
  const { user, session } = useAuth();

  const health = useQuery({
    queryKey: ['integrations', 'health'],
    queryFn: api.integrations.health,
    refetchInterval: 60_000,
  });

  const models = useQuery({
    queryKey: ['integrations', 'models'],
    queryFn: api.integrations.models,
    retry: 0,
  });

  /** 权限码 -> 中文名，避免把 kb:write 直接铺给管理员看 */
  const permissionDefs = useQuery({
    queryKey: ['iam', 'permissions'],
    queryFn: () => api.iam.listPermissions(),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const permissionNames = new Map((permissionDefs.data ?? []).map((item) => [item.code, item.name]));

  /** 各平台入口：地址来自 .env，这里只做可点跳转 */
  const links = useQuery({
    queryKey: ['platform-links'],
    queryFn: () => api.integrations.links(),
    staleTime: 10 * 60_000,
    retry: 0,
  });

  return (
    <div>
      <PageHeader
        title="设置"
        description="只读展示运行环境与集成健康；密钥、模型与检索参数由环境变量与 Nacos 管理"
        extra={
          <Button
            onClick={() => {
              void health.refetch();
              void models.refetch();
            }}
            loading={health.isFetching || models.isFetching}
          >
            刷新
          </Button>
        }
      />

      <Card title="平台入口" style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 12 } }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {(links.data ?? []).map((item) => (
            <Space key={item.name} style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space size={8}>
                <Typography.Text strong>{item.name}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {item.description}
                </Typography.Text>
              </Space>
              {item.url ? (
                <Button size="small" href={item.url} target="_blank" rel="noreferrer">
                  打开
                </Button>
              ) : (
                <Tag>未配置</Tag>
              )}
            </Space>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            地址来自 .env（NACOS_CONSOLE_URL / LITELLM_BASE_URL / LANGFUSE_HOST），换环境只改配置即可。
          </Typography.Text>
        </Space>
      </Card>

      <Card title="运行环境" styles={{ body: { paddingTop: 12 } }}>
        <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
          <Descriptions.Item label="接口地址">
            <Typography.Text code>{API_BASE_URL}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="管理端端口">3101</Descriptions.Item>
          <Descriptions.Item label="用户端端口">3100</Descriptions.Item>
          <Descriptions.Item label="前端框架">Next.js 15 / React 19 / Ant Design 5</Descriptions.Item>
          <Descriptions.Item label="当前租户">{user?.tenantId ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="登录账号">{user?.username ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="角色">
            {user?.roles && user.roles.length > 0 ? (
              <Space size={4} wrap>
                {user.roles.map((role) => (
                  <Tag key={role} color="blue">
                    {role}
                  </Tag>
                ))}
              </Space>
            ) : (
              '-'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="令牌有效期">
            {session?.expiresAt ? new Date(session.expiresAt).toLocaleString('zh-CN') : '未知'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <div style={{ marginTop: 16 }}>
        <InfoNote
          title="配置写在哪一层"
          items={[
            <>
              <Typography.Text code>.env</Typography.Text> 只放接入点与凭证（Nacos 地址、网关 Key、数据库口令）
            </>,
            <>
              模型别名、切分参数、检索权重、JEV 阈值在 Nacos（
              <Typography.Text code>knowledge-hub.yaml</Typography.Text> 与{' '}
              <Typography.Text code>rag_config / deal_pilot</Typography.Text>），改完即时生效
            </>,
            <>业务策略（额度、授权、菜单）落在 Postgres，有版本记录可回滚</>,
          ]}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <HealthPanel
          health={health.data}
          loading={health.isLoading}
          error={health.error}
          onRetry={() => void health.refetch()}
        />
      </div>

      <Card
        title="模型清单（LiteLLM）"
        style={{ marginTop: 16 }}
        styles={{ body: { paddingTop: 12 } }}
        extra={<Tag>{models.data?.length ?? 0} 个</Tag>}
      >
        {models.error ? (
          <ErrorState
            error={models.error}
            title="模型清单不可用"
            onRetry={() => void models.refetch()}
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                需要后端提供 GET /api/v1/integrations/models
              </Typography.Text>
            }
          />
        ) : models.isLoading ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : (models.data?.length ?? 0) === 0 ? (
          <Typography.Text type="secondary">暂无模型数据</Typography.Text>
        ) : (
          <JsonView value={models.data} maxHeight={280} />
        )}
      </Card>

      <PortalSuggestionsCard />

      <Card
        title="当前账号权限点"
        style={{ marginTop: 16 }}
        styles={{ body: { paddingTop: 12 } }}
        extra={<Tag>{user?.permissions?.length ?? 0} 项</Tag>}
      >
        {user?.permissions && user.permissions.length > 0 ? (
          <Space size={6} wrap>
            {user.permissions.map((permission) => (
              <Tooltip key={permission} title={permission}>
                <Tag>{permissionNames.get(permission) ?? permission}</Tag>
              </Tooltip>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">后端未返回权限点列表</Typography.Text>
        )}
      </Card>
    </div>
  );
}

/**
 * 用户端空状态推荐问题：改文案不再需要发版。
 * 保存空列表即恢复系统默认文案。
 */
function PortalSuggestionsCard() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<string[]>([]);

  const settings = useQuery({
    queryKey: ['portal-suggestions'],
    queryFn: () => api.chat.portalSettings(),
    retry: 0,
  });

  useEffect(() => {
    if (settings.data) {
      setItems(settings.data.suggestions);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (next: string[]) => api.chat.savePortalSettings(next),
    onSuccess: (data) => {
      message.success('已保存，用户端刷新后生效');
      setItems(data.suggestions);
      void queryClient.invalidateQueries({ queryKey: ['portal-suggestions'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  return (
    <Card
      title="用户端推荐问题"
      style={{ marginTop: 16 }}
      styles={{ body: { paddingTop: 12 } }}
      extra={
        <Space>
          <Button onClick={() => setItems(settings.data?.defaults ?? [])}>填入默认</Button>
          <Button
            type="primary"
            loading={save.isPending}
            onClick={() => save.mutate(items.filter((item) => item.trim()))}
          >
            保存
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
        出现在用户端空状态，最多 4 条、两列排布；点一下就会直接提问。留空保存则恢复系统默认文案。
      </Typography.Paragraph>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 10,
          marginBottom: 12,
        }}
      >
        {items.map((item, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 10,
              padding: '8px 10px',
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                width: 20,
                height: 20,
                borderRadius: 6,
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 600,
                color: '#1677ff',
                background: 'rgba(22,119,255,0.1)',
              }}
            >
              {index + 1}
            </span>
            <Input
              value={item}
              maxLength={60}
              variant="borderless"
              placeholder="例如：公司差旅报销标准是什么？"
              onChange={(event) => {
                const next = [...items];
                next[index] = event.target.value;
                setItems(next);
              }}
            />
            <Button
              type="text"
              aria-label="删除这条推荐问题"
              icon={<MinusCircleOutlined />}
              onClick={() => setItems(items.filter((_, i) => i !== index))}
            />
          </div>
        ))}
        {items.length < 4 ? (
          <Button
            type="dashed"
            icon={<PlusOutlined />}
            style={{ height: 'auto', minHeight: 42 }}
            onClick={() => setItems([...items, ''])}
          >
            添加一条（最多 4 条）
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
