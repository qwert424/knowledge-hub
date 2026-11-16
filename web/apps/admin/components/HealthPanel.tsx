'use client';

import type { IntegrationsHealth } from '@kh/api-client';
import { ErrorState, JsonView, StatusTag } from '@kh/ui';
import { Card, Space, Table, Typography } from 'antd';

interface HealthRow {
  key: string;
  name: string;
  status: string;
  detail?: string;
}

function normalize(health: IntegrationsHealth | undefined): HealthRow[] {
  if (!health) {
    return [];
  }
  const rows: HealthRow[] = [];
  if (Array.isArray(health.items)) {
    health.items.forEach((item, index) => {
      const endpoint = typeof item.endpoint === 'string' ? item.endpoint : '';
      const detail = typeof item.detail === 'string' ? item.detail : '';
      const joined = [detail, endpoint].filter(Boolean).join(' · ');
      rows.push({
        key: `item-${index}`,
        name: String(item.name ?? `组件 ${index + 1}`),
        status: String(item.status ?? 'unknown'),
        detail: joined || undefined,
      });
    });
    if (rows.length > 0) {
      return rows;
    }
  }
  const components = health.components;
  if (components && typeof components === 'object') {
    Object.entries(components).forEach(([name, raw]) => {
      if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        rows.push({
          key: name,
          name,
          status: String(record.status ?? record.state ?? 'unknown'),
          detail:
            typeof record.detail === 'string'
              ? record.detail
              : typeof record.latencyMs === 'number'
                ? `${record.latencyMs} ms`
                : undefined,
        });
      } else {
        rows.push({ key: name, name, status: raw === true ? 'ok' : raw === false ? 'down' : String(raw) });
      }
    });
    if (rows.length > 0) {
      return rows;
    }
  }
  Object.entries(health).forEach(([name, raw]) => {
    if (name === 'status' || name === 'checkedAt') {
      return;
    }
    if (typeof raw === 'boolean') {
      rows.push({ key: name, name, status: raw ? 'ok' : 'down' });
    } else if (typeof raw === 'string' || typeof raw === 'number') {
      rows.push({ key: name, name, status: String(raw) });
    } else if (raw && typeof raw === 'object') {
      rows.push({ key: name, name, status: 'unknown' });
    }
  });
  return rows;
}

export function HealthPanel({
  health,
  loading,
  error,
  onRetry,
  extra,
}: {
  health?: IntegrationsHealth;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  extra?: React.ReactNode;
}) {
  const rows = normalize(health);
  const overall = health?.status ?? (rows.every((row) => row.status === 'ok') && rows.length > 0 ? 'ok' : 'unknown');

  return (
    <Card
      title={
        <Space>
          <span>集成健康</span>
          <StatusTag kind="health" status={overall} />
        </Space>
      }
      extra={extra}
      styles={{ body: { paddingTop: 12 } }}
    >
      {error ? <ErrorState error={error} title="集成健康检查失败" onRetry={onRetry} /> : null}
      {!error ? (
        <Table<HealthRow>
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: '后端未返回可识别的健康项' }}
          columns={[
            { title: '组件', dataIndex: 'name', key: 'name' },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              width: 120,
              render: (value: string) => <StatusTag kind="health" status={value} />,
            },
            {
              title: '详情',
              dataIndex: 'detail',
              key: 'detail',
              render: (value?: string) => <Typography.Text type="secondary">{value ?? '-'}</Typography.Text>,
            },
          ]}
        />
      ) : null}
      {health && rows.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">原始响应：</Typography.Text>
          <JsonView value={health} maxHeight={180} />
        </div>
      ) : null}
    </Card>
  );
}
