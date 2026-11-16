'use client';

import type { IndexJobView } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, StatusTag, formatDate, progressStatus, resolveStatus } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Dropdown, Input, Popconfirm, Progress, Select, Space, Table, Tooltip, Typography } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/providers';

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '排队中', value: 'queued' },
  { label: '执行中', value: 'running' },
  { label: '成功', value: 'succeeded' },
  { label: '失败', value: 'failed' },
  { label: '已取消', value: 'canceled' },
];

const JOB_TYPE_TEXT: Record<string, string> = {
  index: '首次索引',
  reindex: '重建索引',
};

const JOB_TYPE_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '首次索引', value: 'index' },
  { label: '重建索引', value: 'reindex' },
];

export default function IndexJobsPage() {
  const api = useApi();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const search = useSearchParams();
  // 从概览的「运行中 / 失败」卡片点进来时带 ?status=，直接落到对应筛选结果
  const initialStatus = search?.get('status') ?? '';
  const [status, setStatus] = useState(initialStatus);
  const [documentId, setDocumentId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 选中行的状态快照：翻页/自动刷新后仍能判断"能不能取消" */
  const [selectedJobs, setSelectedJobs] = useState<Record<string, IndexJobView>>({});
  const [refreshing, setRefreshing] = useState(false);

  const manualRefresh = async () => {
    setRefreshing(true);
    try {
      await list.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const list = useQuery({
    queryKey: ['index-jobs', { status, page, pageSize }],
    queryFn: () => api.indexJobs.list({ status: status || undefined, page, pageSize }),
    refetchInterval: 5000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });

  const retry = useMutation({
    mutationFn: (id: string) => api.indexJobs.retry(id),
    onSuccess: () => {
      message.success('已重新入队');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.indexJobs.cancel(id),
    onSuccess: () => {
      message.success('任务已取消');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.indexJobs.remove(id),
    onSuccess: () => {
      message.success('任务记录已删除');
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const batchCancel = useMutation({
    mutationFn: (ids: string[]) => api.indexJobs.batchCancel(ids),
    onSuccess: (result) => {
      message.success(`已取消 ${result.canceled} 个任务`);
      setSelectedIds([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const batchRemove = useMutation({
    mutationFn: (ids: string[]) => api.indexJobs.batchRemove(ids),
    onSuccess: (result) => {
      message.success(`已删除 ${result.deleted} 条记录（执行中的任务已跳过）`);
      setSelectedIds([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message),
  });

  const rows = (list.data?.items ?? []).filter((job) => {
    const keyword = documentId.trim().toLowerCase();
    if (!keyword) {
      return true;
    }
    return (
      job.documentId.toLowerCase().includes(keyword) ||
      (job.documentTitle ?? '').toLowerCase().includes(keyword)
    );
  });

  const cancelableSelected = selectedIds.filter((id) => {
    const status = selectedJobs[id]?.status;
    return status === 'queued' || status === 'running';
  });

  const columns: ColumnsType<IndexJobView> = [
    {
      title: '任务',
      dataIndex: 'id',
      key: 'id',
      width: 220,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{JOB_TYPE_TEXT[record.jobType] ?? record.jobType}</Typography.Text>
          <Tooltip title={`任务 ID ${value}`}>
            <Typography.Text type="secondary" copyable={{ text: value }} style={{ fontSize: 12 }}>
              #{value.slice(0, 8)}
            </Typography.Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '文档',
      dataIndex: 'documentTitle',
      key: 'documentTitle',
      width: 220,
      render: (_: string | null, record) => (
        <Tooltip title={`文档 ID ${record.documentId}`}>
          <Typography.Text
            ellipsis
            type={record.documentTitle ? undefined : 'secondary'}
            style={{ maxWidth: 200, display: 'inline-block' }}
          >
            {record.documentTitle || '文档已删除'}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: string) => <StatusTag kind="job" status={value} />,
    },
    {
      title: '阶段 / 进度',
      key: 'progress',
      width: 220,
      render: (_, record) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Progress
            percent={record.progress}
            size="small"
            status={progressStatus(record.status)}
            format={(percent) => `${percent ?? 0}%`}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.stage ? (
              record.status === 'failed' ? (
                // 失败任务停在哪个阶段是有效信息，但用"解析中"这种蓝标签会让人以为还在跑
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  失败于「{resolveStatus('document', record.stage).text}」
                </Typography.Text>
              ) : (
                <StatusTag kind="document" status={record.stage} />
              )
            ) : (
              '等待调度'
            )}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '重试',
      dataIndex: 'attempt',
      key: 'attempt',
      width: 80,
      align: 'center',
    },
    {
      title: '错误',
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      width: 220,
      render: (value: string | null, record) =>
        value ? (
          <Tooltip title={value}>
            <Space direction="vertical" size={0}>
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {record.errorCode ?? 'ERROR'}
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 200 }}>
                {value}
              </Typography.Text>
            </Space>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    {
      title: '创建 / 完成',
      key: 'time',
      width: 170,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>{formatDate(record.createdAt)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.finishedAt ? formatDate(record.finishedAt) : '进行中'}
          </Typography.Text>
        </Space>
      ),
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
            disabled={record.status !== 'failed' && record.status !== 'canceled'}
            loading={retry.isPending && retry.variables === record.id}
            onClick={() => retry.mutate(record.id)}
          >
            重试
          </Button>
          <Button
            size="small"
            type="link"
            danger
            disabled={record.status !== 'queued' && record.status !== 'running'}
            loading={cancel.isPending && cancel.variables === record.id}
            onClick={() => cancel.mutate(record.id)}
          >
            取消
          </Button>
          <Popconfirm
            title="删除这条任务记录？"
            description="只删记录，不影响文档与已生成的向量；执行中的任务需先取消。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove.mutate(record.id)}
          >
            <Button
              size="small"
              type="link"
              danger
              disabled={record.status === 'queued' || record.status === 'running'}
              loading={remove.isPending && remove.variables === record.id}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="索引任务"
        description="解析 → 归一化 → 切片 → 增强 → 向量化 → 写入 → 发布；列表每 5 秒自动刷新，删除只清任务记录、不动文档与向量"
        extra={
          <Space wrap>
            <Select
              style={{ width: 140 }}
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_OPTIONS}
            />
            <Input
              allowClear
              placeholder="按文档标题或 ID 过滤"
              style={{ width: 240 }}
              value={documentId}
              onChange={(event) => setDocumentId(event.target.value)}
            />
            <Button loading={refreshing} onClick={() => void manualRefresh()}>
              立即刷新
            </Button>
            <Dropdown
              disabled={selectedIds.length === 0}
              menu={{
                items: [
                  {
                    key: 'cancel',
                    label:
                      cancelableSelected.length > 0
                        ? `取消任务（${cancelableSelected.length}）`
                        : '取消任务（选中的都不是排队/执行中）',
                    disabled: cancelableSelected.length === 0 || batchCancel.isPending,
                  },
                  {
                    key: 'delete',
                    label: `删除记录（${selectedIds.length}）`,
                    danger: true,
                    disabled: batchRemove.isPending,
                  },
                ],
                onClick: ({ key }) => {
                  if (key === 'cancel') {
                    batchCancel.mutate(cancelableSelected);
                    return;
                  }
                  modal.confirm({
                    title: `删除选中的 ${selectedIds.length} 条任务记录？`,
                    content:
                      '只删任务记录，不动文档，也不删已写入向量库的数据；执行中的任务会被跳过。想让某篇文档下线，请到文档页删除它。',
                    okText: '删除记录',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => batchRemove.mutateAsync(selectedIds),
                  });
                },
              }}
            >
              <Button>
                批量操作 <DownOutlined />
              </Button>
            </Dropdown>
          </Space>
        }
      />

      {list.error ? <ErrorState error={list.error} title="索引任务加载失败" onRetry={() => void list.refetch()} /> : null}

      <Table<IndexJobView>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={list.isLoading}
        scroll={{ x: 1300 }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys, picked) => {
            setSelectedIds(keys as string[]);
            setSelectedJobs((previous) => {
              const next = { ...previous };
              for (const row of picked) {
                next[row.id] = row;
              }
              return next;
            });
          },
          preserveSelectedRowKeys: true,
        }}
        locale={{
          emptyText: (
            <EmptyState title="暂无索引任务" description="上传并提交文档后，索引任务会自动出现在这里" />
          ),
        }}
        pagination={{
          current: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个任务`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
      />
    </div>
  );
}
