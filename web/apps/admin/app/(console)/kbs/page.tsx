'use client';

import type { GatewayModel, KbMemberView, KbView, PrincipalType, Visibility } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, StatusTag, formatDate, formatNumber } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { friendlyAdminError } from '@/lib/errors';
import { useApi } from '@/lib/providers';

const VISIBILITY_OPTIONS: Array<{ label: string; value: Visibility }> = [
  { label: '私有（仅本人）', value: 'private' },
  { label: '部门', value: 'dept' },
  { label: '租户公开', value: 'tenant' },
  { label: '公开', value: 'public' },
];

const VISIBILITY_TEXT: Record<string, string> = {
  private: '私有',
  dept: '部门',
  tenant: '租户公开',
  public: '公开',
};

const PRINCIPAL_TYPES: Array<{ label: string; value: PrincipalType }> = [
  { label: '用户', value: 'user' },
  { label: '角色', value: 'role' },
  { label: '用户组', value: 'group' },
];

interface KbFormValues {
  name: string;
  code?: string;
  description?: string;
  visibility?: Visibility;
  embeddingModel?: string;
  embeddingDim?: number;
  graphEnabled?: boolean;
}

interface MemberFormValues {
  principalType: PrincipalType;
  principalIds: string[];
  permission: 'read' | 'write' | 'manage';
}

/** 网关里真正能算向量的模型（管理端口径：mode=embedding 或名字里带 embed） */
function embeddingModels(models: GatewayModel[]): GatewayModel[] {
  return models.filter((model) => model.mode === 'embedding' || /embed/i.test(model.id));
}

export default function KbPage() {
  const api = useApi();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<KbView | null>(null);
  const [creating, setCreating] = useState(false);
  const [memberKb, setMemberKb] = useState<KbView | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [principalType, setPrincipalType] = useState<PrincipalType>('user');

  const [createForm] = Form.useForm<KbFormValues>();
  const [editForm] = Form.useForm<KbFormValues>();
  const [memberForm] = Form.useForm<MemberFormValues>();

  const list = useQuery({
    queryKey: ['kbs', { keyword, page, pageSize }],
    queryFn: () => api.kbs.list({ keyword: keyword || undefined, page, pageSize }),
  });

  const models = useQuery({
    queryKey: ['gateway-models'],
    queryFn: () => api.integrations.models(),
    staleTime: 5 * 60_000,
  });

  /** 切片长度、检索参数等在 Nacos 的 rag_config 里；这里只用于展示与兜底默认值 */
  const ragConfig = useQuery({
    queryKey: ['rag-config'],
    queryFn: () => api.integrations.ragConfig(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const users = useQuery({ queryKey: ['iam-users'], queryFn: () => api.iam.listUsers({ pageSize: 100 }) });
  const roles = useQuery({ queryKey: ['iam-roles'], queryFn: () => api.iam.listRoles() });
  const groups = useQuery({ queryKey: ['iam-groups'], queryFn: () => api.iam.listGroups() });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['kbs'] });

  const defaults = useMemo(() => {
    const raw = (ragConfig.data?.defaults ?? {}) as Record<string, unknown>;
    const embedding = embeddingModels(models.data ?? []);
    const preferred = embedding.find((model) => String(model.id) === String(raw.embeddingModel ?? ''));
    return {
      embeddingModel: preferred?.id ?? embedding[0]?.id ?? (raw.embeddingModel as string) ?? '',
      embeddingDim: Number(raw.dimensions ?? 1024),
      chunkSize: raw.chunkSize,
      chunkOverlap: raw.chunkOverlap,
      topK: raw.topK,
      rerankModel: raw.rerankModel,
    };
  }, [models.data, ragConfig.data]);

  const createMutation = useMutation({
    mutationFn: (values: KbFormValues) =>
      api.kbs.create({
        name: values.name,
        // 编码留空由后端生成：它只是集合命名与接口引用的键
        code: values.code?.trim() || undefined,
        description: values.description,
        visibility: values.visibility ?? 'private',
        embeddingModel: values.embeddingModel,
        embeddingDim: values.embeddingDim,
      }),
    onSuccess: () => {
      message.success('知识库已创建');
      setCreating(false);
      createForm.resetFields();
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: KbFormValues }) =>
      api.kbs.update(id, {
        name: values.name,
        description: values.description,
        visibility: values.visibility,
        graphEnabled: values.graphEnabled,
      }),
    onSuccess: () => {
      message.success('知识库已更新');
      setEditing(null);
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.kbs.remove(id),
    onSuccess: () => {
      message.success('知识库已删除');
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      api.kbs.updateStatus(id, status),
    onSuccess: (_data, variables) => {
      message.success(variables.status === 'active' ? '已上架' : '已下架');
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const members = useQuery({
    queryKey: ['kb-members', memberKb?.id],
    queryFn: () => api.kbs.listMembers(memberKb?.id as string),
    enabled: Boolean(memberKb?.id),
  });

  const deleted = useQuery({
    queryKey: ['kb-deleted'],
    queryFn: () => api.kbs.listDeleted(),
    enabled: trashOpen,
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.kbs.restore(id),
    onSuccess: () => {
      message.success('已恢复，状态为已下架；需要检索请再上架');
      void queryClient.invalidateQueries({ queryKey: ['kb-deleted'] });
      invalidate();
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => api.kbs.purge(id),
    onSuccess: () => {
      message.success('已彻底删除');
      void queryClient.invalidateQueries({ queryKey: ['kb-deleted'] });
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const purgeAllMutation = useMutation({
    mutationFn: () => api.kbs.purgeAll(),
    onSuccess: (result) => {
      if (result.skipped.length > 0) {
        message.warning(
          `已清空 ${result.purged} 个；${result.skipped.length} 个因库内还有文档被跳过`,
        );
      } else {
        message.success(`已清空回收站（${result.purged} 个）`);
      }
      void queryClient.invalidateQueries({ queryKey: ['kb-deleted'] });
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const revokeMutation = useMutation({
    mutationFn: ({ kbId, memberId }: { kbId: string; memberId: string }) =>
      api.kbs.removeMember(kbId, memberId),
    onSuccess: () => {
      message.success('已取消授权');
      void queryClient.invalidateQueries({ queryKey: ['kb-members'] });
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const principalLabel = (type: string, id: string) => {
    if (type === 'user') {
      const user = (users.data?.items ?? []).find((item) => item.id === id);
      return user ? `${user.displayName || user.username}（${user.username}）` : id;
    }
    if (type === 'role') {
      const role = (roles.data ?? []).find((item) => item.code === id);
      return role ? `${role.name}（${role.code}）` : id;
    }
    const group = (groups.data ?? []).find((item) => item.id === id);
    return group ? group.name : id;
  };

  const memberMutation = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: MemberFormValues }) => {
      for (const principalId of values.principalIds) {
        await api.kbs.addMember(id, {
          principalType: values.principalType,
          principalId,
          permission: values.permission,
        });
      }
    },
    onSuccess: () => {
      message.success('成员授权已提交');
      memberForm.setFieldsValue({ principalIds: [] });
      // 授权后必须重新拉一次：否则下方「当前授权」还是旧的，看不出刚加了谁
      void queryClient.invalidateQueries({ queryKey: ['kb-members'] });
      void queryClient.invalidateQueries({ queryKey: ['kbs'] });
    },
    onError: (error: Error) => message.error(friendlyAdminError(error)),
  });

  const principalOptions = useMemo(() => {
    if (principalType === 'user') {
      return (users.data?.items ?? []).map((user) => ({
        value: user.id,
        label: `${user.displayName || user.username}（${user.username}）`,
      }));
    }
    if (principalType === 'role') {
      return (roles.data ?? []).map((role) => ({
        value: role.code,
        label: `${role.name}（${role.code}）`,
      }));
    }
    return (groups.data ?? []).map((group) => ({ value: group.id, label: group.name }));
  }, [groups.data, principalType, roles.data, users.data]);

  const columns: ColumnsType<KbView> = [
    {
      title: '知识库',
      key: 'name',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.code} · {record.embeddingModel} / {record.embeddingDim} 维
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '可见性',
      dataIndex: 'visibility',
      key: 'visibility',
      width: 96,
      render: (value: string) => <Tag>{VISIBILITY_TEXT[value] ?? value}</Tag>,
    },
    {
      title: '文档数',
      dataIndex: 'documentCount',
      key: 'documentCount',
      width: 80,
      align: 'right',
      render: (value: number) => formatNumber(value),
    },
    {
      title: '图谱',
      dataIndex: 'graphEnabled',
      key: 'graphEnabled',
      width: 84,
      render: (value: boolean) => (value ? <Tag color="blue">已启用</Tag> : <Tag>关闭</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 92,
      render: (value: string) => <StatusTag kind="kb" status={value} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              setEditing(record);
              editForm.setFieldsValue({
                name: record.name,
                code: record.code,
                description: record.description ?? undefined,
                visibility: record.visibility,
                graphEnabled: record.graphEnabled,
              });
            }}
          >
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => setMemberKb(record)}>
            成员
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'status',
                  label: record.status === 'active' ? '下架' : '上架',
                  onClick: () =>
                    statusMutation.mutate({
                      id: record.id,
                      status: record.status === 'active' ? 'disabled' : 'active',
                    }),
                },
                { type: 'divider' as const },
                {
                  key: 'delete',
                  label:
                    record.status === 'active'
                      ? '删除（需先下架）'
                      : (record.documentCount ?? 0) > 0
                        ? `删除（库内还有 ${record.documentCount} 个文档）`
                        : '删除',
                  danger: true,
                  disabled: record.status === 'active' || (record.documentCount ?? 0) > 0,
                  onClick: () =>
                    modal.confirm({
                      title: `删除知识库「${record.name}」？`,
                      width: 460,
                      content: (
                        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
                          <div>删除后这个库会从知识库列表和用户检索范围里消失，库内文档与已建向量仍然保留。</div>
                          <div>想临时下架用「下架」，不需要删除；删错了可以在「回收站」恢复。</div>
                        </div>
                      ),
                      okText: '确认删除',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => deleteMutation.mutateAsync(record.id),
                    }),
                },
              ],
            }}
          >
            <Button
              size="small"
              type="link"
              loading={statusMutation.isPending && statusMutation.variables?.id === record.id}
            >
              更多
            </Button>
          </Dropdown>
        </Space>
      ),
    },
  ];

  const items = list.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="知识库"
        description="一个知识库对应一个向量集合：文档进哪个库就在哪个库检索，授权与上下架都在库这一级"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="按名称或编码搜索"
              style={{ width: 240 }}
              onSearch={(value) => {
                setKeyword(value.trim());
                setPage(1);
              }}
            />
            <Button onClick={() => setTrashOpen(true)}>回收站</Button>
            <Button type="primary" onClick={() => setCreating(true)}>
              新建知识库
            </Button>
          </Space>
        }
      />

      {list.error ? (
        <ErrorState error={list.error} title="知识库列表加载失败" onRetry={() => void list.refetch()} />
      ) : null}

      <Table<KbView>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={items}
        loading={list.isLoading}
        scroll={{ x: 1000 }}
        locale={{
          emptyText: (
            <EmptyState
              title="还没有知识库"
              description="创建第一个知识库后即可上传文档（含飞书导入）并建立索引"
              action={
                <Button type="primary" onClick={() => setCreating(true)}>
                  新建知识库
                </Button>
              }
            />
          ),
        }}
        pagination={{
          current: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个知识库`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <Modal
        title="新建知识库"
        open={creating}
        confirmLoading={createMutation.isPending}
        onCancel={() => setCreating(false)}
        onOk={() => createForm.submit()}
        okText="创建"
        width={580}
        destroyOnHidden
      >
        <Form<KbFormValues>
          form={createForm}
          layout="vertical"
          onFinish={(values) => createMutation.mutate(values)}
          initialValues={{
            visibility: 'private',
            embeddingModel: defaults.embeddingModel,
            embeddingDim: defaults.embeddingDim,
          }}
        >
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：产品知识库" />
          </Form.Item>
          <Form.Item
            label="编码（可留空自动生成）"
            name="code"
            rules={[{ pattern: /^[a-zA-Z0-9_-]{2,64}$/, message: '仅允许字母、数字、下划线与中划线' }]}
            extra="租户内唯一，只用于向量集合命名与接口引用；不确定就留空"
          >
            <Input placeholder="留空自动生成，例如 kb3f9a21" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} placeholder="用途、负责团队、数据范围" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="可见性" name="visibility" style={{ flex: 1 }}>
              <Select options={VISIBILITY_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="Embedding 模型"
              name="embeddingModel"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '选择网关提供的向量模型' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={models.isLoading ? '读取网关模型…' : '选择网关里的向量模型'}
                options={embeddingModels(models.data ?? []).map((model) => ({
                  value: model.id,
                  label: model.id,
                }))}
                notFoundContent="网关里没有向量模型"
              />
            </Form.Item>
            <Form.Item
              label="维度"
              name="embeddingDim"
              style={{ width: 110 }}
              tooltip="维度决定集合结构（与向量模型配套）。默认值来自 Nacos rag_config；这里填的值会写进这个知识库，创建后不可改。"
            >
              <InputNumber min={64} max={4096} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
            {ragConfig.data
              ? `切片与检索参数由 Nacos 统一管理（${ragConfig.data.dataId} / ${ragConfig.data.group}）：切片 ${defaults.chunkSize ?? '-'} 字、重叠 ${defaults.chunkOverlap ?? '-'} 字、召回 ${defaults.topK ?? '-'} 条${
                  defaults.rerankModel ? `、重排 ${defaults.rerankModel}` : ''
                }；调这些请去「检索策略 → Nacos rag_config」，改这里不会覆盖。`
              : '没读到 rag_config，将使用系统默认切片参数。'}
          </Typography.Paragraph>
        </Form>
      </Modal>

      <Modal
        title={`编辑：${editing?.name ?? ''}`}
        open={Boolean(editing)}
        confirmLoading={updateMutation.isPending}
        onCancel={() => setEditing(null)}
        onOk={() => editForm.submit()}
        destroyOnHidden
      >
        <Form<KbFormValues>
          form={editForm}
          layout="vertical"
          onFinish={(values) => {
            if (!editing) {
              return;
            }
            updateMutation.mutate({ id: editing.id, values });
          }}
        >
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="可见性" name="visibility">
            <Select options={VISIBILITY_OPTIONS} />
          </Form.Item>
          <Form.Item
            label="启用知识图谱抽取"
            name="graphEnabled"
            valuePropName="checked"
            extra="只对标记为「精选」的文档抽实体关系，没标记的不抽"
          >
            <Switch />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            编码、向量配置创建后不可修改；如需调整请新建知识库并迁移文档。
          </Typography.Text>
        </Form>
      </Modal>

      <Drawer
        title={`成员授权：${memberKb?.name ?? ''}`}
        open={Boolean(memberKb)}
        width={460}
        onClose={() => setMemberKb(null)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginBottom: 12 }}>
          授权决定「谁能检索到这些文档」，检索时按身份过滤；文档标签只用来缩小检索范围。
        </Typography.Paragraph>
        <Form<MemberFormValues>
          form={memberForm}
          layout="vertical"
          initialValues={{ principalType: 'user', permission: 'read', principalIds: [] }}
          onFinish={(values) => {
            if (!memberKb) {
              return;
            }
            memberMutation.mutate({ id: memberKb.id, values });
          }}
        >
          <Space size={12} style={{ display: 'flex', alignItems: 'flex-start' }}>
            <Form.Item label="主体类型" name="principalType" rules={[{ required: true }]} style={{ width: 110 }}>
              <Select
                options={PRINCIPAL_TYPES}
                onChange={(value: PrincipalType) => {
                  setPrincipalType(value);
                  memberForm.setFieldsValue({ principalIds: [] });
                }}
              />
            </Form.Item>
            <Form.Item label="权限" name="permission" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={[
                  { label: '只读（可被检索）', value: 'read' },
                  { label: '编辑（可维护文档）', value: 'write' },
                  { label: '管理（含授权）', value: 'manage' },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            label="授权对象（可多选）"
            name="principalIds"
            rules={[{ required: true, message: '至少选一个对象' }]}
            style={{ marginBottom: 8 }}
          >
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              loading={users.isLoading || roles.isLoading || groups.isLoading}
              placeholder="搜索并选择（可多选）"
              options={principalOptions}
              notFoundContent="没有可选项"
              maxTagCount="responsive"
              allowClear
            />
          </Form.Item>
          <Space size={8} style={{ marginBottom: 12 }}>
            <Button
              size="small"
              onClick={() =>
                memberForm.setFieldsValue({ principalIds: principalOptions.map((item) => item.value) })
              }
            >
              全选
            </Button>
            <Button size="small" onClick={() => memberForm.setFieldsValue({ principalIds: [] })}>
              清空
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {principalOptions.length} 个可选
            </Typography.Text>
          </Space>
          <Button type="primary" htmlType="submit" loading={memberMutation.isPending} block>
            提交授权
          </Button>
        </Form>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 20 }}>
          <Typography.Text strong>当前授权（{members.data?.length ?? 0}）</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            没列在这里的人靠「可见性」拿权限
          </Typography.Text>
        </div>
        <Table<KbMemberView>
          style={{ marginTop: 8 }}
          size="small"
          rowKey="id"
          loading={members.isLoading}
          dataSource={members.data ?? []}
          pagination={false}
          locale={{ emptyText: '还没有单独授权：目前靠可见性与角色继承生效' }}
          columns={[
            {
              title: '授权对象',
              key: 'principal',
              ellipsis: true,
              render: (_, row) => {
                const typeText =
                  ({ user: '用户', role: '角色', group: '用户组' } as Record<string, string>)[row.principalType] ??
                  row.principalType;
                return (
                  <Space size={6} style={{ minWidth: 0 }}>
                    <Tag style={{ flex: '0 0 auto' }}>{typeText}</Tag>
                    <Tooltip title={row.principalId}>
                      <Typography.Text strong ellipsis style={{ maxWidth: 160 }}>
                        {principalLabel(row.principalType, row.principalId)}
                      </Typography.Text>
                    </Tooltip>
                  </Space>
                );
              },
            },
            {
              title: '对象 ID',
              key: 'principalId',
              width: 130,
              render: (_, row) => (
                <Typography.Text type="secondary" style={{ fontSize: 11.5 }} copyable={{ text: row.principalId }}>
                  {row.principalId.slice(0, 8)}…
                </Typography.Text>
              ),
            },
            {
              title: '权限',
              dataIndex: 'permission',
              width: 80,
              render: (value: string) => (
                <Tag>{({ read: '只读', write: '编辑', manage: '管理' } as Record<string, string>)[value] ?? value}</Tag>
              ),
            },
            {
              title: '操作',
              width: 96,
              render: (_, row) => (
                <Button
                  size="small"
                  danger
                  type="link"
                  loading={revokeMutation.isPending && revokeMutation.variables?.memberId === row.id}
                  onClick={() => memberKb && revokeMutation.mutate({ kbId: memberKb.id, memberId: row.id })}
                >
                  取消授权
                </Button>
              ),
            },
          ]}
          scroll={{ x: 520 }}
        />
      </Drawer>

      <Modal
        title="回收站"
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={null}
        width={680}
        destroyOnHidden
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 8,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            这里是被删除的知识库；恢复到「已下架」，需重新上架才会被检索。彻底删除不可恢复。
          </Typography.Text>
          <Popconfirm
            title="清空回收站？"
            description="会彻底删除回收站里所有空库；库内仍有文档的会被跳过。此操作不可恢复。"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={(deleted.data ?? []).length === 0}
            onConfirm={() => purgeAllMutation.mutate()}
          >
            <Button
              size="small"
              danger
              disabled={(deleted.data ?? []).length === 0}
              loading={purgeAllMutation.isPending}
            >
              清空回收站
            </Button>
          </Popconfirm>
        </div>
        <Table<KbView>
          rowKey="id"
          size="small"
          loading={deleted.isLoading}
          dataSource={deleted.data ?? []}
          pagination={false}
          locale={{ emptyText: <EmptyState title="回收站是空的" /> }}
          columns={[
            { title: '知识库', dataIndex: 'name', key: 'name' },
            { title: '编码', dataIndex: 'code', key: 'code', width: 160 },
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
                    title={`彻底删除「${record.name}」？`}
                    description="不可恢复；库内仍有文档时会被拒绝。"
                    okText="彻底删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => purgeMutation.mutate(record.id)}
                  >
                    <Button
                      size="small"
                      type="link"
                      danger
                      loading={purgeMutation.isPending && purgeMutation.variables === record.id}
                    >
                      彻底删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
