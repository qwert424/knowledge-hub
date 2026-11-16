'use client';

import type { DocumentView } from '@kh/api-client';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  StatusTag,
  formatBytes,
  formatDate,
} from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOutlined, DownOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Alert, Button, Dropdown, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { useState } from 'react';
import { DocumentUploadDrawer } from '@/components/DocumentUpload';
import { useApi } from '@/lib/providers';
import { useKbOptions } from '@/lib/useKbOptions';

/** 来源枚举 -> 人话：这些值来自上传、飞书导入和接口推送 */
const SOURCE_LABELS: Record<string, string> = {
  upload: '本地上传',
  uploaded: '本地上传',
  feishu: '飞书导入',
  feishu_import: '飞书导入',
  api: '接口推送',
  url: '网页抓取',
  datasource: '数据源同步',
};

function sourceLabel(value?: string | null): string {
  if (!value) {
    return '未知';
  }
  return SOURCE_LABELS[value] ?? value;
}

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '待处理', value: 'uploaded' },
  { label: '索引中', value: 'indexing' },
  { label: '已上线', value: 'active' },
  { label: '失败', value: 'failed' },
  { label: '已下线', value: 'offline' },
];

export default function DocumentsPage() {
  const api = useApi();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const { kbs, options: kbOptions, activeOptions: kbActiveOptions, nameById } = useKbOptions();

  const [kbId, setKbId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [feishuForm] = Form.useForm<{ kbId: string; url: string }>();
  const [spaceId, setSpaceId] = useState<string | undefined>(undefined);
  const [parentToken, setParentToken] = useState<string | undefined>(undefined);
  const [batchKbId, setBatchKbId] = useState<string | undefined>(undefined);
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  /** 正在转移知识库的文档（弹窗里选目标库） */
  const [movingDoc, setMovingDoc] = useState<DocumentView | null>(null);
  const [moveTargetKb, setMoveTargetKb] = useState<string | undefined>(undefined);
  const moveDoc = useMutation({
    mutationFn: (payload: { docId: string; kbId: string }) => api.documents.moveToKb(payload.docId, payload.kbId),
    onSuccess: () => {
      message.success('已提交转移：文档换库后会重新建索引，进度看「索引任务」');
      setMovingDoc(null);
      setMoveTargetKb(undefined);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });
    },
    onError: (error: Error) => message.error(error.message || '转移失败'),
  });

  const spaces = useQuery({
    queryKey: ['feishu-spaces'],
    queryFn: () => api.documents.feishuSpaces(),
    enabled: feishuOpen,
    retry: false,
  });
  const nodes = useQuery({
    queryKey: ['feishu-nodes', spaceId, parentToken],
    queryFn: () => api.documents.feishuNodes(spaceId as string, parentToken),
    enabled: feishuOpen && Boolean(spaceId),
    retry: false,
  });

  const importFeishu = useMutation({
    mutationFn: (values: { kbId: string; url: string }) =>
      api.documents.importFeishu(values.kbId, values.url.trim()),
    onSuccess: (doc) => {
      message.success(`已导入「${doc.title}」，正在索引`);
      setFeishuOpen(false);
      feishuForm.resetFields();
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const importBatch = useMutation({
    mutationFn: (payload: { kbId: string; urls: string[] }) =>
      api.documents.importFeishuBatch(payload.kbId, payload.urls),
    onSuccess: (results) => {
      const ok = results.filter((row) => row.ok).length;
      const failed = results.length - ok;
      if (failed === 0) {
        message.success(`已导入 ${ok} 篇，正在索引`);
      } else {
        message.warning(`成功 ${ok} 篇，失败 ${failed} 篇（失败原因见控制台提示）`);
        results
          .filter((row) => !row.ok)
          .slice(0, 3)
          .forEach((row) => message.error(`${row.url}：${row.error ?? '导入失败'}`));
      }
      setSelectedUrls([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const list = useQuery({
    queryKey: ['documents', { kbId, status, keyword, page, pageSize }],
    queryFn: () =>
      api.documents.list({
        kbId,
        status: status || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
    void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });
  };

  const reindex = useMutation({
    mutationFn: (payload: { id: string; force?: boolean }) =>
      api.documents.reindex(payload.id, payload.force ?? false),
    onSuccess: (result) => {
      if (result.skipped) {
        // 内容与切片/向量参数都没变：指纹一致，秒级跳过，不用白跑一遍 embedding
        message.info(result.reason || '内容没变，已跳过重建（需要强制重建请用「强制重索引」）');
        return;
      }
      message.success(`已提交重索引任务：${result.jobId ?? '-'}`);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const toggleGraph = useMutation({
    mutationFn: ({ id, selected }: { id: string; selected: boolean }) =>
      api.documents.setGraphSelection(id, selected),
    onSuccess: () => {
      message.success('已更新精选标记');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.documents.remove(id),
    onSuccess: () => {
      message.success('文档已删除（软删，可在审计中追溯）');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const columns: ColumnsType<DocumentView> = [
    {
      title: '文档',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, record) => (
        <Space direction="vertical" size={0}>
          <Link href={`/documents/${record.id}`}>
            <Typography.Text strong>{title}</Typography.Text>
          </Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.mimeType ?? '未知类型'}
            {record.sizeBytes ? ` · ${formatBytes(record.sizeBytes)}` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '知识库',
      dataIndex: 'kbId',
      key: 'kbId',
      width: 160,
      render: (value: string) => (
        <Typography.Text type={nameById.get(value) ? undefined : 'secondary'}>
          {nameById.get(value) ?? '知识库已删除'}
        </Typography.Text>
      ),
    },
    {
      title: '来源',
      dataIndex: 'sourceType',
      key: 'sourceType',
      width: 100,
      render: (value: string) => <Tag>{sourceLabel(value)}</Tag>,
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      width: 100,
      align: 'right',
      render: (value: number | null) => formatBytes(value),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: string) => <StatusTag kind="document" status={value} />,
    },
    {
      title: '图谱',
      dataIndex: 'graphSelected',
      key: 'graphSelected',
      width: 80,
      render: (value: boolean) => (value ? <Tag color="blue">精选</Tag> : <Typography.Text type="secondary">-</Typography.Text>),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 160,
      render: (value: string[] | null | undefined) =>
        value && value.length > 0 ? (
          <Space size={4} wrap>
            {value.slice(0, 3).map((tag) => (
              <Tag key={tag} color="geekblue">
                {tag}
              </Tag>
            ))}
            {value.length > 3 ? <Tag>+{value.length - 3}</Tag> : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      // 以前一行铺 4~5 个文字按钮，列表看着很吵；常用动作留一个，其余收进「更多」
      render: (_, record) => {
        // 库被删了就没法重建索引（集合名/维度都拿不到）：直接禁掉，别让人点了报错
        const kbMissing = !nameById.get(record.kbId);
        const busy = reindex.isPending && reindex.variables?.id === record.id;
        return (
          <Space size={2}>
            <Link href={`/documents/${record.id}`}>
              <Button size="small" type="link">
                详情
              </Button>
            </Link>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'reindex',
                    label: '重建索引',
                    disabled: kbMissing,
                    onClick: () => reindex.mutate({ id: record.id }),
                  },
                  {
                    key: 'force',
                    label: '强制重建（忽略指纹）',
                    disabled: kbMissing,
                    onClick: () => reindex.mutate({ id: record.id, force: true }),
                  },
                  {
                    key: 'move',
                    label: '转移到其它知识库',
                    onClick: () => setMovingDoc(record),
                  },
                  { type: 'divider' as const },
                  {
                    key: 'delete',
                    label: '删除文档',
                    danger: true,
                    onClick: () =>
                      modal.confirm({
                        title: '确认删除该文档？',
                        content: '软删除后可在回收站恢复，切片会下线并移出检索范围。',
                        okText: '删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => remove.mutate(record.id),
                      }),
                  },
                ],
              }}
            >
              <Button size="small" type="link" loading={busy}>
                更多
              </Button>
            </Dropdown>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="文档"
        description="预签名直传对象存储后提交索引；列表可按知识库、状态与关键字过滤"
        extra={
          <Space wrap>
            <Select
              allowClear
              style={{ width: 180 }}
              placeholder="全部知识库"
              value={kbId}
              onChange={(value) => {
                setKbId(value);
                setPage(1);
              }}
              options={kbOptions}
              showSearch
              optionFilterProp="label"
            />
            <Select
              style={{ width: 130 }}
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
            />
            <Input.Search
              allowClear
              placeholder="按标题搜索"
              style={{ width: 200 }}
              onSearch={(value) => {
                setKeyword(value.trim());
                setPage(1);
              }}
            />
            <Dropdown
              menu={{
                items: [
                  { key: 'upload', label: '上传本地文件', icon: <UploadOutlined /> },
                  { key: 'feishu', label: '从飞书导入', icon: <CloudOutlined /> },
                ],
                onClick: ({ key }) => (key === 'upload' ? setUploadOpen(true) : setFeishuOpen(true)),
              }}
            >
              <Button type="primary">
                添加文档 <DownOutlined />
              </Button>
            </Dropdown>
          </Space>
        }
      />

      {list.error ? <ErrorState error={list.error} title="文档列表加载失败" onRetry={() => void list.refetch()} /> : null}

      <Table<DocumentView>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={list.data?.items ?? []}
        loading={list.isLoading}
        scroll={{ x: 1180 }}
        locale={{
          emptyText: (
            <EmptyState
              title="没有匹配的文档"
              description="调整筛选条件，或上传新文档"
              action={<Button type="primary" onClick={() => setUploadOpen(true)}>上传文档</Button>}
            />
          ),
        }}
        pagination={{
          current: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 篇文档`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
      />

      <DocumentUploadDrawer
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        kbs={kbs}
      />

      <Modal
        title={`转移知识库${movingDoc ? ` · ${movingDoc.title ?? ''}` : ''}`}
        open={Boolean(movingDoc)}
        confirmLoading={moveDoc.isPending}
        onCancel={() => {
          setMovingDoc(null);
          setMoveTargetKb(undefined);
        }}
        okText="转移并重建索引"
        okButtonProps={{ disabled: !moveTargetKb }}
        onOk={() => {
          if (movingDoc && moveTargetKb) {
            moveDoc.mutate({ docId: movingDoc.id, kbId: moveTargetKb });
          }
        }}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
          目标库必须处于上架状态。转移后文档会在新库重新建索引（旧的切片会下线），进度可在「索引任务」里看。
        </Typography.Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder="选择目标知识库"
          showSearch
          optionFilterProp="label"
          value={moveTargetKb}
          onChange={setMoveTargetKb}
          options={kbActiveOptions.filter((option) => option.value !== movingDoc?.kbId)}
        />
      </Modal>

      <Modal
        title="从飞书导入文档"
        open={feishuOpen}
        confirmLoading={importFeishu.isPending || importBatch.isPending}
        onCancel={() => setFeishuOpen(false)}
        footer={null}
        width={720}
        destroyOnHidden
      >
        <Tabs
          items={[
            {
              key: 'link',
              label: '粘贴链接',
              children: (
                <Form<{ kbId: string; url: string }>
                  form={feishuForm}
                  layout="vertical"
                  onFinish={(values) => importFeishu.mutate(values)}
                >
                  <Form.Item label="目标知识库" name="kbId" rules={[{ required: true, message: '请选择知识库' }]}>
                    <Select showSearch optionFilterProp="label" placeholder="选择知识库" options={kbActiveOptions} />
                  </Form.Item>
                  <Form.Item
                    label="飞书文档链接"
                    name="url"
                    rules={[{ required: true, message: '请粘贴飞书文档链接' }]}
                    extra="支持 /docx/… 与知识库 /wiki/… 链接；拖 blocks 结构化解析，标题层级和表格都会保留"
                  >
                    <Input placeholder="https://xxx.feishu.cn/docx/xxxxxxxx" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={importFeishu.isPending}>
                    导入并索引
                  </Button>
                </Form>
              ),
            },
            {
              key: 'space',
              label: '浏览知识空间',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Select
                      style={{ width: 220 }}
                      placeholder="选择知识空间"
                      value={spaceId}
                      onChange={(value) => setSpaceId(value)}
                      loading={spaces.isLoading}
                      options={(spaces.data ?? []).map((space) => ({
                        value: space.spaceId,
                        label: space.name || space.spaceId,
                      }))}
                    />
                    <Select
                      style={{ width: 220 }}
                      placeholder="导入到哪个知识库"
                      value={batchKbId}
                      onChange={(value) => setBatchKbId(value)}
                      options={kbOptions}
                      showSearch
                      optionFilterProp="label"
                    />
                    <Button
                      type="primary"
                      disabled={selectedUrls.length === 0 || !batchKbId}
                      loading={importBatch.isPending}
                      onClick={() => importBatch.mutate({ kbId: batchKbId as string, urls: selectedUrls })}
                    >
                      导入选中的 {selectedUrls.length} 篇
                    </Button>
                  </Space>
                  {spaces.error ? (
                    <Alert
                      type="warning"
                      showIcon
                      message="读不到飞书知识空间"
                      description={`${(spaces.error as Error).message}；请确认应用已开通 wiki:wiki:readonly 并被加入该知识空间。`}
                    />
                  ) : null}
                  <Table
                    rowKey={(record) => record.url}
                    size="small"
                    loading={nodes.isLoading}
                    dataSource={nodes.data ?? []}
                    pagination={{ pageSize: 8, size: 'small' }}
                    locale={{
                      emptyText: (
                        <EmptyState
                          title={spaceId ? '该目录没有可导入的文档' : '先选择一个知识空间'}
                          description="支持飞书新版文档（docx）；表格、多维表格等暂不支持"
                        />
                      ),
                    }}
                    rowSelection={{
                      selectedRowKeys: selectedUrls,
                      onChange: (keys) => setSelectedUrls(keys as string[]),
                      getCheckboxProps: (record) => ({
                        disabled: record.objType !== 'docx',
                      }),
                    }}
                    columns={[
                      {
                        title: '文档',
                        dataIndex: 'title',
                        render: (value: string, record) => (
                          <Space size={6}>
                            <Typography.Text>{value || record.nodeToken}</Typography.Text>
                            {record.objType !== 'docx' ? <Tag>暂不支持</Tag> : null}
                          </Space>
                        ),
                      },
                      {
                        title: '子目录',
                        dataIndex: 'hasChild',
                        width: 80,
                        render: (value: boolean, record) =>
                          value ? (
                            <Button size="small" type="link" onClick={() => setParentToken(record.nodeToken)}>
                              进入
                            </Button>
                          ) : (
                            '-'
                          ),
                      },
                    ]}
                  />
                  {parentToken ? (
                    <Button size="small" onClick={() => setParentToken(undefined)}>
                      ← 返回上级目录
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
