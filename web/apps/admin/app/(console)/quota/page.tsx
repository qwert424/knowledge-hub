'use client';

import type { ChatQuotaRow } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, formatDateTime } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useApi } from '@/lib/providers';
import { InfoNote } from '@/components/InfoNote';

type SubjectType = 'tenant' | 'user' | 'role' | 'group';

interface QuotaFormValues {
  subjectType: SubjectType;
  subjectId?: string;
  limitTokens: number;
  limitRequests: number;
}

const SUBJECT_TEXT: Record<string, { label: string; color?: string }> = {
  tenant: { label: '租户级', color: 'blue' },
  user: { label: '用户', color: 'geekblue' },
  role: { label: '角色', color: 'purple' },
  group: { label: '用户组', color: 'cyan' },
};

function percent(used: number, limit: number): number {
  if (!limit || limit <= 0 || used <= 0) {
    return 0;
  }
  // 零点几个百分点时 0% 的条看着像没生效，保留一点可见进度
  return Math.min(100, Math.max(1, Number(((used / limit) * 100).toFixed(2))));
}

function percentText(used: number, limit: number): string {
  if (!limit || limit <= 0) {
    return '不限';
  }
  return `${((used / limit) * 100).toFixed(2)}%`;
}

/**
 * 对话额度管理。
 *
 * 目前没有在线收款，额度是内部成本管控：管理员按租户 / 角色 / 用户组 / 个人设置每月上限，0 表示不限。
 * 数据落在 quota 表并按月分 period，因此调整只影响当月，历史用量不会被改写。
 */
export default function QuotaPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm<QuotaFormValues>();

  const overview = useQuery({
    queryKey: ['chat-quota-overview'],
    queryFn: () => api.chat.quotaOverview(),
  });

  const save = useMutation({
    mutationFn: (values: QuotaFormValues) =>
      api.chat.setQuota({
        subjectType: values.subjectType,
        subjectId: values.subjectId,
        limitTokens: Number(values.limitTokens ?? 0),
        limitRequests: Number(values.limitRequests ?? 0),
      }),
    onSuccess: () => {
      message.success('额度已保存（当月生效）');
      setEditing(false);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['chat-quota-overview'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const rows: ChatQuotaRow[] = overview.data?.items ?? [];
  const tenantRow = rows.find((row) => row.subject_type === 'tenant');
  const subjectRows = rows.filter((row) => row.subject_type !== 'tenant');

  const users = useQuery({ queryKey: ['iam-users', 'quota'], queryFn: () => api.iam.listUsers({ pageSize: 200 }) });
  const roles = useQuery({ queryKey: ['iam-roles', 'quota'], queryFn: () => api.iam.listRoles() });
  const groups = useQuery({ queryKey: ['iam-groups', 'quota'], queryFn: () => api.iam.listGroups() });

  const openEditor = (row?: ChatQuotaRow) => {
    form.resetFields();
    if (row) {
      form.setFieldsValue({
        subjectType: row.subject_type as SubjectType,
        subjectId: row.subject_id,
        limitTokens: row.limit_tokens,
        limitRequests: row.limit_requests,
      });
    }
    setEditing(true);
  };

  const clearRow = useMutation({
    mutationFn: (row: ChatQuotaRow) =>
      api.chat.clearQuota({ subjectType: row.subject_type as SubjectType, subjectId: row.subject_id }),
    onSuccess: () => {
      message.success('已撤销该对象的额度，回落到上一层规则');
      void queryClient.invalidateQueries({ queryKey: ['chat-quota-overview'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ColumnsType<ChatQuotaRow> = [
    {
      title: '作用对象',
      key: 'subject',
      render: (_, record) => {
        const meta = SUBJECT_TEXT[record.subject_type] ?? { label: record.subject_type };
        return (
          <Space size={6}>
            <Tag color={meta.color}>{meta.label}</Tag>
            <Typography.Text>
              {record.subject_label ?? (record.subject_type === 'tenant' ? '本租户' : record.subject_id)}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Token 用量',
      key: 'tokens',
      render: (_, record) => (
        <div style={{ minWidth: 160 }}>
          <Typography.Text>
            {record.tokens_used.toLocaleString()}
            {record.limit_tokens > 0 ? ` / ${record.limit_tokens.toLocaleString()}` : '（不限）'}
          </Typography.Text>
          {record.limit_tokens > 0 ? (
            <Progress
              percent={percent(record.tokens_used, record.limit_tokens)}
              size="small"
              format={() => percentText(record.tokens_used, record.limit_tokens)}
              status={percent(record.tokens_used, record.limit_tokens) > 85 ? 'exception' : 'normal'}
            />
          ) : null}
        </div>
      ),
    },
    {
      title: '回答数',
      key: 'requests',
      width: 150,
      render: (_, record) =>
        `${record.requests_used}${record.limit_requests > 0 ? ` / ${record.limit_requests}` : '（不限）'}`,
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 170,
      render: (value?: string | null) => formatDateTime(value ?? undefined),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEditor(record)}>
            编辑
          </Button>
          <Popconfirm
            title="撤销这条额度配置？"
            description="撤销后按上一层规则（用户 → 角色 → 用户组 → 全租户）执行，已用用量不变。"
            okText="撤销"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => clearRow.mutate(record)}
          >
            <Button
              size="small"
              type="link"
              danger
              loading={clearRow.isPending && clearRow.variables?.subject_id === record.subject_id}
            >
              撤销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="用量与额度"
        description="按租户 / 角色 / 用户组 / 个人设置每月对话额度；0 表示不限。内部成本管控，不涉及对外计费"
        extra={<Button onClick={() => openEditor()}>设置额度</Button>}
      />

      <InfoNote title="额度怎么算">
        发送提问前校验当月已用 token 与回答数，超限直接拒绝（429）；额度按月重置，历史用量不再改写。
        生效优先级 用户 → 角色 → 用户组 → 全租户，配了哪一层用哪一层。
      </InfoNote>

      {overview.error ? (
        <ErrorState error={overview.error} title="额度加载失败" onRetry={() => void overview.refetch()} />
      ) : null}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8}>
          <Card styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本月 Tokens（{overview.data?.period ?? '-'}）
            </Typography.Text>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.5 }}>
              {(tenantRow?.tokens_used ?? 0).toLocaleString()}
              <Typography.Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>
                {tenantRow && tenantRow.limit_tokens > 0
                  ? `/ ${tenantRow.limit_tokens.toLocaleString()}`
                  : '未设上限'}
              </Typography.Text>
            </div>
            {tenantRow && tenantRow.limit_tokens > 0 ? (
              <>
                <Progress
                  percent={percent(tenantRow.tokens_used, tenantRow.limit_tokens)}
                  size="small"
                  showInfo={false}
                  status={percent(tenantRow.tokens_used, tenantRow.limit_tokens) > 85 ? 'exception' : 'normal'}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已用 {percentText(tenantRow.tokens_used, tenantRow.limit_tokens)} · 剩{' '}
                  {Math.max(0, tenantRow.limit_tokens - tenantRow.tokens_used).toLocaleString()} tokens
                </Typography.Text>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前不限制总量
              </Typography.Text>
            )}
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本月回答数
            </Typography.Text>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.5 }}>
              {(tenantRow?.requests_used ?? 0).toLocaleString()}
              <Typography.Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>
                {tenantRow && tenantRow.limit_requests > 0
                  ? `/ ${tenantRow.limit_requests.toLocaleString()}`
                  : '未设上限'}
              </Typography.Text>
            </div>
            {tenantRow && tenantRow.limit_requests > 0 ? (
              <>
                <Progress
                  percent={Math.min(100, Math.round((tenantRow.requests_used / tenantRow.limit_requests) * 100))}
                  size="small"
                  showInfo={false}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  剩 {Math.max(0, tenantRow.limit_requests - tenantRow.requests_used)} 次
                </Typography.Text>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前不限制次数
              </Typography.Text>
            )}
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              额度覆盖
            </Typography.Text>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.5 }}>
              {subjectRows.length}
              <Typography.Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>
                个对象单独配置
              </Typography.Text>
            </div>
            <div style={{ minHeight: 22, display: 'flex', alignItems: 'center' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                其余按全租户额度执行；0 表示不限
              </Typography.Text>
            </div>
          </Card>
        </Col>
      </Row>

      <Table<ChatQuotaRow>
        rowKey={(record) => `${record.subject_type}:${record.subject_id}`}
        size="middle"
        loading={overview.isLoading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{
          emptyText: (
            <EmptyState
              title="本月还没有配置额度"
              description="没有配置时按系统默认额度执行；点右上角「设置额度」给全租户或某个人设上限"
            />
          ),
        }}
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        额度填 0 表示不限；完全没有配置时按系统默认额度执行。用量每月 1 日重置，历史月份不会被改写。
      </Typography.Paragraph>

      <Modal
        title="设置月度额度"
        open={editing}
        confirmLoading={save.isPending}
        onCancel={() => setEditing(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<QuotaFormValues>
          form={form}
          layout="vertical"
          initialValues={{ subjectType: 'tenant', limitTokens: 2000000, limitRequests: 5000 }}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item label="作用对象" name="subjectType" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '全租户（默认）', value: 'tenant' },
                { label: '按用户', value: 'user' },
                { label: '按角色', value: 'role' },
                { label: '按用户组', value: 'group' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.subjectType !== next.subjectType}>
            {({ getFieldValue }) => {
              const type = getFieldValue('subjectType') as SubjectType;
              if (!type || type === 'tenant') {
                return null;
              }
              const options =
                type === 'user'
                  ? (users.data?.items ?? []).map((user) => ({
                      value: user.id,
                      label: `${user.displayName || user.username}（${user.username}）`,
                    }))
                  : type === 'role'
                    ? (roles.data ?? []).map((role) => ({ value: role.code, label: `${role.name}（${role.code}）` }))
                    : (groups.data ?? []).map((group) => ({ value: group.id, label: group.name }));
              return (
                <Form.Item
                  label={type === 'user' ? '选择用户' : type === 'role' ? '选择角色' : '选择用户组'}
                  name="subjectId"
                  rules={[{ required: true, message: '请选择作用对象' }]}
                  extra="可以直接搜索，不用手动填 ID"
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="搜索并选择"
                    options={options}
                    loading={users.isLoading || roles.isLoading || groups.isLoading}
                  />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item
            label="每月 Token 上限"
            name="limitTokens"
            extra="0 表示不限；达到上限后用户无法发送，直到下月 1 日重置"
          >
            <InputNumber min={0} step={100000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="每月回答数上限" name="limitRequests" extra="0 表示不限">
            <InputNumber min={0} step={100} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
