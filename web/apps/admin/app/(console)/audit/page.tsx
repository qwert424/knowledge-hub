'use client';

import type { AuditLogRow } from '@kh/api-client';
import { EmptyState, ErrorState, JsonView, PageHeader, StatusTag, formatDate } from '@kh/ui';
import { useQuery } from '@tanstack/react-query';
import { Button, Descriptions, Input, Popover, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { AUDIT_ACTION_OPTIONS, actionLabelOf, actionSentence, describeChange, resourceLabelOf, substituteIds } from '@/lib/audit';
import type { ChangeEntry } from '@/lib/audit';
import { useApi } from '@/lib/providers';
import { useKbOptions } from '@/lib/useKbOptions';

/** 变更前后统一渲染成「字段 / 变更前 → 变更后」，裸 UUID 和裸字符串都能看懂 */
function ChangeTable({ entries }: { entries: ChangeEntry[] }) {
  return (
    <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={`${entry.field}-${index}`} style={{ borderTop: index === 0 ? 'none' : '1px solid #f0f0f0' }}>
            <td style={{ width: 96, padding: '4px 8px 4px 0', color: '#8c8c8c', verticalAlign: 'top' }}>
              {entry.field || '值'}
            </td>
            <td style={{ padding: '4px 8px', verticalAlign: 'top', wordBreak: 'break-all' }}>
              <Typography.Text delete={Boolean(entry.before) && Boolean(entry.after)} type="secondary">
                {entry.before || '—'}
              </Typography.Text>
            </td>
            <td style={{ width: 18, padding: '4px 0', color: '#bfbfbf', textAlign: 'center' }}>→</td>
            <td style={{ padding: '4px 8px', verticalAlign: 'top', wordBreak: 'break-all' }}>
              <Typography.Text strong={Boolean(entry.after)}>{entry.after || '—'}</Typography.Text>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditPage() {
  const api = useApi();
  const { kbs } = useKbOptions();
  const [action, setAction] = useState('');
  const [actorName, setActorName] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  /** 名称映射：知识库 / 文档 / 用户，用于把审计里的裸 ID 翻成人话 */
  const documents = useQuery({
    queryKey: ['documents', 'audit-labels'],
    queryFn: () => api.documents.list({ page: 1, pageSize: 200 }),
    staleTime: 5 * 60_000,
  });
  const users = useQuery({
    queryKey: ['iam-users', 'audit-labels'],
    queryFn: () => api.iam.listUsers({ pageSize: 200 }),
    staleTime: 5 * 60_000,
  });
  const labels = new Map<string, string>();
  for (const kb of kbs) {
    labels.set(kb.id.toLowerCase(), kb.name);
  }
  for (const doc of documents.data?.items ?? []) {
    labels.set(doc.id.toLowerCase(), doc.title || `文档 ${doc.id.slice(0, 8)}`);
  }
  for (const user of users.data?.items ?? []) {
    labels.set(user.id.toLowerCase(), user.displayName || user.username);
  }

  const list = useQuery({
    queryKey: ['audit-logs', { action, actorName, page, pageSize }],
    queryFn: () =>
      api.ops.auditLogs({
        action: action || undefined,
        actorName: actorName || undefined,
        page,
        pageSize,
      }),
  });

  const columns: ColumnsType<AuditLogRow> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (value: string) => formatDate(value, true),
    },
    {
      title: '操作人',
      key: 'actor',
      width: 160,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{record.actorName ?? '系统'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.actorId ? String(record.actorId).slice(0, 8) : '-'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '动作',
      key: 'action',
      width: 210,
      render: (_, record) => {
        const label = actionLabelOf(record.action);
        return (
          <Space direction="vertical" size={0}>
            <Tag color={label.color} style={{ marginInlineEnd: 0 }}>
              {actionSentence(record.action, record.resourceType)}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {record.action ?? '-'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '资源',
      key: 'resource',
      width: 200,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{resourceLabelOf(record.resourceType)}</Typography.Text>
          {record.resourceId ? (
            <Tooltip title={String(record.resourceId)}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: String(record.resourceId) }}>
                {String(record.resourceId).slice(0, 12)}
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      width: 130,
      render: (value: string | null, record) => {
        if (!value) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        // 历史数据里 result 有 SUCCESS / ok / true 等写法，统一映射，别把原始枚举糊在界面上
        const normalized = value.trim();
        const upper = normalized.toUpperCase();
        const isSuccess = ['SUCCESS', 'OK', 'TRUE', 'SUCCEEDED'].includes(upper);
        const isFailure = ['FAILED', 'FAIL', 'ERROR', 'FALSE'].includes(upper);
        if (!isSuccess && !isFailure) {
          return (
            <Tooltip title={normalized}>
              <Typography.Text ellipsis style={{ maxWidth: 90, fontSize: 12 }}>
                {normalized}
              </Typography.Text>
            </Tooltip>
          );
        }
        return (
          // 失败 + 错误码挤在一行会把两段文字压扁：上下两行更清楚
          <Space direction="vertical" size={0}>
            <StatusTag kind="result" status={isSuccess ? 'SUCCESS' : 'FAILED'} />
            {record.errorCode ? (
              <Tooltip title={record.errorCode}>
                <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                  {record.errorCode.length > 20 ? `${record.errorCode.slice(0, 20)}…` : record.errorCode}
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '详情',
      key: 'detail',
      width: 90,
      render: (_, record) => {
        const before = substituteIds(record.before, labels);
        const after = substituteIds(record.after, labels);
        if (!before && !after) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const changes = describeChange(record.before, record.after, labels);
        return (
          <Popover
            trigger="click"
            placement="left"
            title="这次操作做了什么"
            content={
              <div style={{ width: 520, maxHeight: 380, overflowY: 'auto' }}>
                <Descriptions column={1} size="small" styles={{ label: { width: 72 } }}>
                  <Descriptions.Item label="操作">
                    {actionSentence(record.action, record.resourceType)}
                    <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      {record.action ?? '-'}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="对象">
                    {resourceLabelOf(record.resourceType)}
                    {record.resourceId
                      ? ` · ${labels.get(String(record.resourceId).toLowerCase()) ?? String(record.resourceId).slice(0, 18)}`
                      : ''}
                  </Descriptions.Item>
                  <Descriptions.Item label="操作人">
                    {record.actorName || '系统（引擎回调）'}
                  </Descriptions.Item>
                </Descriptions>
                <div style={{ marginTop: 8 }}>
                  <ChangeTable entries={changes} />
                </div>
              </div>
            }
          >
            <Button size="small" type="link">
              查看
            </Button>
          </Popover>
        );
      },
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      width: 140,
      render: (value?: string) => <Typography.Text code>{value ?? '-'}</Typography.Text>,
    },
    {
      title: 'RequestId',
      dataIndex: 'requestId',
      key: 'requestId',
      width: 160,
      render: (value?: string) =>
        value ? (
          <Typography.Text copyable style={{ fontSize: 12 }}>
            {value.slice(0, 12)}
          </Typography.Text>
        ) : (
          '-'
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="审计日志"
        description="登录、上传、授权、发布等写操作都会留痕，只增不改；按动作或操作人筛选，点「查看」或展开行看前后值"
        extra={
          <Space wrap>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="动作（可搜索）"
              style={{ width: 280 }}
              options={AUDIT_ACTION_OPTIONS}
              value={action || undefined}
              onChange={(value) => setAction(value ?? '')}
            />
            <Input
              allowClear
              placeholder="操作人姓名"
              style={{ width: 180 }}
              value={actorName}
              onChange={(event) => setActorName(event.target.value)}
            />
            <Button
              type="primary"
              onClick={() => {
                setPage(1);
                void list.refetch();
              }}
              loading={list.isFetching}
            >
              查询
            </Button>
          </Space>
        }
      />

      {list.error ? <ErrorState error={list.error} title="审计日志加载失败" onRetry={() => void list.refetch()} /> : null}

      <Table<AuditLogRow>
        rowKey={(record) => String(record.id)}
        size="middle"
        loading={list.isLoading}
        columns={columns}
        dataSource={list.data?.items ?? []}
        scroll={{ x: 1180 }}
        expandable={{
          expandedRowRender: (record) => (
            <div style={{ paddingRight: 12 }}>
              <Descriptions column={2} size="small" styles={{ label: { width: 76 } }}>
                <Descriptions.Item label="操作">
                  {actionSentence(record.action, record.resourceType)}
                </Descriptions.Item>
                <Descriptions.Item label="对象">
                  {resourceLabelOf(record.resourceType)}
                  {record.resourceId ? ` · ${String(record.resourceId)}` : ''}
                </Descriptions.Item>
                <Descriptions.Item label="来源 IP">{record.ip ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="客户端">{record.userAgent ?? '-'}</Descriptions.Item>
              </Descriptions>
              <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                <ChangeTable entries={describeChange(record.before, record.after, labels)} />
              </Space>
            </div>
          ),
          rowExpandable: (record) => Boolean(record.before || record.after),
        }}
        locale={{
          emptyText: <EmptyState title="暂无审计记录" description="登录、上传、授权等写操作都会留下审计事件" />,
        }}
        pagination={{
          current: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
      />
    </div>
  );
}
