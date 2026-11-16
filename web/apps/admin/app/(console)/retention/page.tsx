'use client';

import { EmptyState, ErrorState, PageHeader, StatusTag, formatDate } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useApi } from '@/lib/providers';

interface RetentionPolicyRow {
  id: string;
  name: string;
  target: string;
  retentionDays: number;
  enabled: boolean;
  cron: string;
  lastRunAt?: string | null;
  lastDeleted?: number | null;
  lastStatus?: string | null;
  lastMessage?: string | null;
  updatedAt?: string | null;
}

const TARGET_LABEL: Record<string, string> = {
  audit_log: '审计日志',
  chat_message: '会话消息',
};

/**
 * 数据保留：审计与会话消息只增不减，跑几个月就把列表和统计拖慢。
 * 这里按策略表配置「留多少天、什么时候清理」，后端每分钟检查 cron，到点就删。
 */
export default function RetentionPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RetentionPolicyRow | null>(null);
  const [form] = Form.useForm<{ retentionDays: number; cron: string; enabled: boolean }>();

  const policies = useQuery({
    queryKey: ['retention-policies'],
    queryFn: () => api.ops.retentionPolicies(),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['retention-policies'] });

  const save = useMutation({
    mutationFn: (values: { retentionDays: number; cron: string; enabled: boolean }) =>
      api.ops.updateRetention(String(editing?.id), values),
    onSuccess: () => {
      message.success('保留策略已更新，下一次调度生效');
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.ops.runRetention(id),
    onSuccess: (result) => {
      message.success(`已执行：${result.lastMessage ?? '完成'}`);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ColumnsType<RetentionPolicyRow> = [
    {
      title: '策略',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {TARGET_LABEL[record.target] ?? record.target}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '保留',
      dataIndex: 'retentionDays',
      key: 'retentionDays',
      width: 110,
      render: (value: number) => <Tag>{value} 天</Tag>,
    },
    {
      title: '调度',
      dataIndex: 'cron',
      key: 'cron',
      width: 170,
      render: (value: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (value: boolean) => <StatusTag kind="generic" status={value ? 'enabled' : 'disabled'} />,
    },
    {
      title: '上次执行',
      key: 'lastRun',
      width: 240,
      render: (_, record) =>
        record.lastRunAt ? (
          <Space direction="vertical" size={0} style={{ maxWidth: 240 }}>
            <Typography.Text style={{ fontSize: 12.5 }}>
              {formatDate(record.lastRunAt)} · 删除 {record.lastDeleted ?? 0} 行
            </Typography.Text>
            <Typography.Text
              type={record.lastStatus === 'failed' ? 'danger' : 'secondary'}
              style={{ fontSize: 12 }}
              ellipsis={{ tooltip: record.lastMessage ?? '' }}
            >
              {record.lastMessage || '-'}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">还没执行过</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_, record) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditing(record);
              form.setFieldsValue({
                retentionDays: record.retentionDays,
                cron: record.cron,
                enabled: record.enabled,
              });
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            loading={runNow.isPending && runNow.variables === record.id}
            onClick={() =>
              Modal.confirm({
                title: '立即执行清理？',
                content: `将删除早于 ${record.retentionDays} 天的${TARGET_LABEL[record.target] ?? record.target}，删除后不可恢复。`,
                okButtonProps: { danger: true },
                onOk: () => runNow.mutate(record.id),
              })
            }
          >
            立即执行
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="数据保留"
        description="审计日志与会话消息的自动清理：按天保留，定时任务到点执行"
        extra={
          <Button loading={policies.isFetching} onClick={() => void policies.refetch()}>
            刷新
          </Button>
        }
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginBottom: 16 }}>
        后端每分钟检查一次 cron（6 段：秒 分 时 日 月 周），到点且启用的策略才会执行。
        清理是物理删除，界面上只保留「上次执行」的结果用于核对。
      </Typography.Paragraph>

      {policies.error ? (
        <ErrorState error={policies.error} title="保留策略加载失败" onRetry={() => void policies.refetch()} />
      ) : null}

      <Card>
        <Table<RetentionPolicyRow>
          rowKey="id"
          size="middle"
          loading={policies.isLoading}
          columns={columns}
          dataSource={policies.data ?? []}
          pagination={false}
          scroll={{ x: 1000 }}
          locale={{ emptyText: <EmptyState title="还没有保留策略" description="应由数据库迁移自动创建" /> }}
        />
      </Card>

      <Modal
        title={editing ? `编辑：${editing.name}` : '编辑保留策略'}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item
            label="保留天数"
            name="retentionDays"
            rules={[{ required: true, message: '请输入保留天数' }]}
            extra="超过这个天数的数据会被删除；审计建议 180 天，对话建议 90 天"
          >
            <InputNumber min={1} max={3650} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="cron 表达式"
            name="cron"
            rules={[{ required: true, message: '请输入 cron' }]}
            extra="6 段，秒在最前；例如 0 30 3 * * * 表示每天 03:30:00"
          >
            <Input placeholder="0 30 3 * * *" />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
