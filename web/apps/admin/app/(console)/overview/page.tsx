'use client';

import type { MetricsOverview } from '@kh/api-client';
import { ErrorState, PageHeader, formatDateTime, formatNumber } from '@kh/ui';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOutlined,
  ArrowRightOutlined,
  BookOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  MessageOutlined,
  PartitionOutlined,
  ReloadOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Card, Col, Progress, Row, Space, Statistic, Tooltip, Typography, theme } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import { HealthPanel } from '@/components/HealthPanel';
import { TrendChart } from '@/components/TrendChart';
import { useApi, useAuth } from '@/lib/providers';

interface MetricCard {
  key: keyof MetricsOverview;
  label: string;
  hint: string;
  href: string;
  icon: React.ReactNode;
  /** 目标页面需要的权限码：没有权限就只展示数字，不做可点击入口 */
  permission?: string;
}

const METRIC_CARDS: MetricCard[] = [
  { key: 'knowledgeBases', label: '知识库', hint: '查看全部知识库', href: '/kbs', icon: <BookOutlined />, permission: 'kb:read' },
  { key: 'documents', label: '文档', hint: '上传与治理', href: '/documents', icon: <FileTextOutlined />, permission: 'doc:read' },
  { key: 'chunks', label: '切片', hint: '检索调试台', href: '/retrieval', icon: <PartitionOutlined />, permission: 'profile:manage' },
  { key: 'conversations', label: '会话', hint: '查看全租户问答记录', href: '/conversations', icon: <MessageOutlined />, permission: 'ops:audit:read' },
];

const SHORTCUTS = [
  { href: '/documents', title: '上传与治理文档', description: '预签名直传 → 提交 → 索引 → 切片检查', permission: 'doc:read' },
  { href: '/index-jobs', title: '索引任务中心', description: '查看阶段进度，失败一键重试或取消', permission: 'index:manage' },
  { href: '/retrieval', title: '检索调试台', description: '真实链路召回、ACL 过滤与耗时埋点', permission: 'profile:manage' },
  { href: '/iam', title: '用户与权限', description: '用户、角色、权限点与群组维护', permission: 'iam:user:manage' },
];


function MetricTile({
  card,
  value,
  loading,
  allowed,
}: {
  card: MetricCard;
  value: number;
  loading: boolean;
  allowed: boolean;
}) {
  const { token } = theme.useToken();
  const body = (
    <Card
      size="small"
      loading={loading}
      styles={{ body: { padding: 16 } }}
      style={{ borderRadius: token.borderRadiusLG, height: '100%', cursor: allowed ? 'pointer' : 'default' }}
      hoverable={allowed}
    >
      <Space size={6} style={{ color: token.colorTextSecondary, fontSize: 13 }}>
        <span style={{ color: token.colorTextTertiary }}>{card.icon}</span>
        {card.label}
      </Space>
      <div style={{ fontSize: 28, fontWeight: 650, lineHeight: 1.2, marginTop: 6 }}>{formatNumber(value)}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {allowed ? (
          <>
            {card.hint} <ArrowRightOutlined style={{ fontSize: 10 }} />
          </>
        ) : (
          `没有「${card.label}」的查看权限`
        )}
      </Typography.Text>
    </Card>
  );
  return allowed ? <Link href={card.href} style={{ display: 'block' }}>{body}</Link> : <div>{body}</div>;
}

export default function OverviewPage() {
  const api = useApi();
  const { token } = theme.useToken();
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  /** 与侧栏同一套判断：没有权限的入口不展示为可点击，避免点进去被弹回 */
  const canSee = (permission?: string) =>
    !permission || permissions.includes(permission) || permissions.includes('*');
  const [refreshing, setRefreshing] = useState(false);
  const metrics = useQuery({ queryKey: ['metrics', 'overview'], queryFn: api.ops.overview, refetchInterval: 30_000 });
  const trends = useQuery({
    queryKey: ['metrics', 'trends', 7],
    queryFn: () => api.ops.trends(7),
    refetchInterval: 60_000,
  });
  const health = useQuery({
    queryKey: ['integrations', 'health'],
    queryFn: api.integrations.health,
    refetchInterval: 60_000,
  });
  /**
   * 额度占用必须用真实的月度额度与用量。
   * 之前这里写死 TOKEN_SCALE=2000000 再拿"今日 tokens"去除，所以永远显示 0%。
   */
  const quota = useQuery({
    queryKey: ['chat-quota-overview'],
    queryFn: api.chat.quotaOverview,
    refetchInterval: 60_000,
    retry: false,
  });

  const data = metrics.data;
  const today = data?.today ?? {};
  const performance = data?.performance ?? {};
  const tenantQuota = (quota.data?.items ?? []).find((row) => row.subject_type === 'tenant');
  const monthTokens = tenantQuota?.tokens_used ?? 0;
  const monthLimit = tenantQuota?.limit_tokens ?? 0;
  const tokenShare = monthLimit > 0 ? Math.min(100, Math.round((monthTokens / monthLimit) * 100)) : 0;
  const tokenShareText =
    monthLimit > 0
      ? `${formatNumber(monthTokens)} / ${formatNumber(monthLimit)} tokens（${tokenShare}%）`
      : `${formatNumber(monthTokens)} tokens（未设上限）`;

  const shortcuts = SHORTCUTS.filter((item) => canSee(item.permission));

  return (
    <div>
      <PageHeader
        title="平台概览"
        description="容量、增长与链路健康一屏掌握；指标 30 秒自动刷新"
        extra={
          <Space>
            <Typography.Text type="secondary">
              更新于 {formatDateTime(metrics.dataUpdatedAt || undefined)}
            </Typography.Text>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing || metrics.isFetching || trends.isFetching || health.isFetching}
              onClick={() => {
                // refetch 命中缓存时会瞬间完成，用户看不到 loading；这里至少保证有一次可见反馈
                setRefreshing(true);
                void Promise.allSettled([metrics.refetch(), trends.refetch(), health.refetch()]).finally(() => {
                  setTimeout(() => setRefreshing(false), 300);
                });
              }}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
          </Space>
        }
      />

      {metrics.error ? (
        <ErrorState error={metrics.error} title="概览指标加载失败" onRetry={() => void metrics.refetch()} />
      ) : null}

      <Row gutter={[16, 16]}>
        {METRIC_CARDS.map((card) => (
          <Col key={String(card.key)} xs={24} sm={12} xl={6}>
            <MetricTile
              card={card}
              value={Number(data?.[card.key] ?? 0)}
              loading={metrics.isLoading}
              allowed={canSee(card.permission)}
            />
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={15}>
          <Card
            title={
              <Space size={8}>
                <ThunderboltOutlined style={{ color: token.colorPrimary }} />
                近 7 天趋势
              </Space>
            }
            styles={{ body: { paddingTop: 8 } }}
          >
            <TrendChart points={trends.data?.days ?? []} loading={trends.isLoading} />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="今日与性能" styles={{ body: { paddingTop: 12 } }} style={{ height: '100%' }}>
            <Row gutter={[12, 16]}>
              <Col span={12}>
                <Statistic
                  title="今日会话"
                  value={today.conversations ?? 0}
                  formatter={(v) => formatNumber(Number(v))}
                />
              </Col>
              <Col span={12}>
                <Statistic title="今日消息" value={today.messages ?? 0} formatter={(v) => formatNumber(Number(v))} />
              </Col>
              <Col span={12}>
                <Statistic title="今日 Tokens" value={today.tokens ?? 0} formatter={(v) => formatNumber(Number(v))} />
              </Col>
              <Col span={12}>
                <Statistic
                  title="平均响应"
                  value={Math.round(Number(performance.avgMessageLatencyMs ?? 0))}
                  suffix="ms"
                  formatter={(v) => formatNumber(Number(v))}
                />
              </Col>
            </Row>
            <div style={{ marginTop: 18 }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  本月 Tokens 占租户额度
                </Typography.Text>
                <Typography.Text style={{ fontSize: 12 }}>{tokenShareText}</Typography.Text>
              </Space>
              <Progress
                percent={tokenShare}
                strokeColor={tokenShare > 85 ? token.colorError : token.colorPrimary}
                showInfo={false}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {monthLimit > 0 ? '额度可在「用量与额度」调整' : '当前未设置额度上限，可在「用量与额度」设置'}
              </Typography.Text>
            </div>
            <Row gutter={12} style={{ marginTop: 16 }}>
              <Col span={12}>
                <Tooltip title="查看索引任务队列（已按「运行中」筛选）">
                  <Link href="/index-jobs?status=running">
                    <Card size="small" hoverable styles={{ body: { padding: 12 } }}>
                      <Space size={6} style={{ color: token.colorTextSecondary, fontSize: 12 }}>
                        <RocketOutlined /> 运行中
                      </Space>
                      <div style={{ fontSize: 20, fontWeight: 600 }}>
                        {formatNumber(Number(data?.runningJobs ?? 0))}
                      </div>
                    </Card>
                  </Link>
                </Tooltip>
              </Col>
              <Col span={12}>
                <Tooltip title="查看失败任务（已按「失败」筛选）">
                  <Link href="/index-jobs?status=failed">
                    <Card size="small" hoverable styles={{ body: { padding: 12 } }}>
                      <Space
                        size={6}
                        style={{
                          color: Number(data?.failedJobs ?? 0) > 0 ? token.colorError : token.colorTextSecondary,
                          fontSize: 12,
                        }}
                      >
                        <AlertOutlined /> 失败
                      </Space>
                      <div style={{ fontSize: 20, fontWeight: 600 }}>
                        {formatNumber(Number(data?.failedJobs ?? 0))}
                      </div>
                    </Card>
                  </Link>
                </Tooltip>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={15}>
          <HealthPanel
            health={health.data}
            loading={health.isLoading}
            error={health.error}
            onRetry={() => void health.refetch()}
          />
        </Col>
        <Col xs={24} xl={9}>
          <Card title="常用入口" styles={{ body: { paddingTop: 12 } }} style={{ height: '100%' }}>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              {shortcuts.map((item) => (
                <div key={item.href}>
                  <Link href={item.href}>
                    <Typography.Text strong>{item.title}</Typography.Text>
                  </Link>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {item.description}
                    </Typography.Text>
                  </div>
                </div>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <ClockCircleOutlined /> 指标 30 秒、趋势与健康 60 秒自动刷新
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}