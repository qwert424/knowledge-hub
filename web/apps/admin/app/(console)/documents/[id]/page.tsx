'use client';

import type { ChunkView, DocumentVersionView } from '@kh/api-client';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  StatusTag,
  formatBytes,
  formatDate,
  formatNumber,
  parseJsonArray,
} from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/providers';
import { useKbOptions } from '@/lib/useKbOptions';

/** 来源枚举 -> 人话（与文档列表保持一致） */
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

/** 切片块类型：解析器产出的是英文枚举，界面要给中文 */
const BLOCK_LABELS: Record<string, string> = {
  title: '标题',
  heading: '标题',
  paragraph: '正文段落',
  text: '正文段落',
  list: '列表',
  'list-item': '列表项',
  table: '表格',
  code: '代码块',
  quote: '引用',
  callout: '高亮块',
  image: '图片',
};

function blockLabel(value?: string | null): string {
  if (!value) {
    return '-';
  }
  return BLOCK_LABELS[value] ?? value;
}

const VERSION_STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  published: '已发布',
  indexing: '索引中',
  draft: '草稿',
  superseded: '已被替换',
  failed: '失败',
};

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const documentId = params?.id ?? '';
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { nameById } = useKbOptions();
  const [versionId, setVersionId] = useState<string | undefined>(undefined);
  const [limit, setLimit] = useState(500);
  const [previewOpen, setPreviewOpen] = useState(false);

  /** 原文预览：能直接渲染的（PDF/图片）走预签名地址，其余展示抽取后的纯文本 */
  const preview = useQuery({
    queryKey: ['documents', 'preview', documentId],
    queryFn: async () => {
      const [target, text] = await Promise.all([
        api.documents.previewUrl(documentId).catch(() => null),
        api.documents.textContent(documentId).catch(() => null),
      ]);
      return { target, text };
    },
    enabled: Boolean(documentId) && previewOpen,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ['documents', 'detail', documentId],
    queryFn: () => api.documents.get(documentId),
    enabled: Boolean(documentId),
  });

  const versions = useQuery({
    queryKey: ['documents', 'versions', documentId],
    queryFn: () => api.documents.versions(documentId),
    enabled: Boolean(documentId),
  });

  const chunks = useQuery({
    queryKey: ['documents', 'chunks', documentId, versionId, limit],
    queryFn: () => api.documents.chunks(documentId, { versionId, limit }),
    enabled: Boolean(documentId),
  });

  const reindex = useMutation({
    mutationFn: () => api.documents.reindex(documentId),
    onSuccess: (result) => {
      message.success(`已提交重索引任务：${result.jobId}`);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const graph = useMutation({
    mutationFn: (selected: boolean) => api.documents.setGraphSelection(documentId, selected),
    onSuccess: (_data, selected) => {
      message.success(selected ? '已加入图谱抽取范围' : '已从图谱抽取范围移除');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const setTags = useMutation({
    mutationFn: (tags: string[]) => api.documents.setTags(documentId, tags),
    onSuccess: () => {
      message.success('标签已保存，正在按新标签重建索引');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['index-jobs'] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const versionColumns: ColumnsType<DocumentVersionView> = [
    {
      title: '版本',
      dataIndex: 'id',
      key: 'id',
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text code>{value.slice(0, 8)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.revision ?? '无修订号'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (value: string) => <StatusTag kind="document" status={value} />,
    },
    {
      title: '切片数',
      dataIndex: 'chunkCount',
      key: 'chunkCount',
      width: 100,
      align: 'right',
      render: (value: number) => formatNumber(value),
    },
    {
      title: 'Token 数',
      dataIndex: 'tokenCount',
      key: 'tokenCount',
      width: 110,
      align: 'right',
      render: (value: number) => formatNumber(value),
    },
    {
      title: '内容哈希',
      dataIndex: 'contentHash',
      key: 'contentHash',
      width: 200,
      render: (value?: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {value ? value.slice(0, 16) : '-'}
        </Typography.Text>
      ),
    },
    {
      title: '发布时间',
      dataIndex: 'publishedAt',
      key: 'publishedAt',
      width: 160,
      render: (value?: string) => formatDate(value),
    },
  ];

  const chunkColumns: ColumnsType<ChunkView> = [
    {
      title: '#',
      dataIndex: 'chunkIndex',
      key: 'chunkIndex',
      width: 70,
      render: (value: number) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: '标题路径',
      dataIndex: 'titlePath',
      key: 'titlePath',
      render: (value?: string) => {
        const path = parseJsonArray(value);
        if (path.length > 0) {
          return <Typography.Text>{path.join(' / ')}</Typography.Text>;
        }
        // 没有标题层级时回落到文档标题：PDF/纯文本本来就没有小节结构
        return (
          <Tooltip title="这份文档没有小节标题（PDF、纯文本常见），所以按文档标题展示">
            <Typography.Text type="secondary">{docTitle || '无标题'}</Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: '块类型',
      key: 'blockType',
      width: 130,
      render: (_, record) => {
        // kind 才是检索契约里的语义类型；老数据没有 kind 时回落到 blockType
        const kind = record.kind ?? record.blockType ?? '';
        const extras: string[] = [];
        if (record.tableRowIndex != null && record.tableRowIndex >= 0) {
          // 这是原表的物理行号（表头是 0），与下面的「本块第几片」不是一回事
          extras.push(`原表第 ${record.tableRowIndex} 行`);
        }
        if ((record.chunkCount ?? 1) > 1) {
          // 块内序号：与原表行号分开写，避免「第 9/5 片」这种看上去矛盾的组合
          extras.push(`本块 ${record.chunkIndex + 1}/${record.chunkCount} 片`);
        }
        return (
          <Space direction="vertical" size={0}>
            <Tag>{blockLabel(kind)}</Tag>
            {extras.length > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                {extras.join(' · ')}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Token',
      dataIndex: 'tokenCount',
      key: 'tokenCount',
      width: 90,
      align: 'right',
      render: (value?: number | null) => formatNumber(value),
    },
    {
      title: '质量标记',
      dataIndex: 'qualityFlags',
      key: 'qualityFlags',
      width: 200,
      render: (value?: string) => {
        if (!value) {
          return <Typography.Text type="secondary">-</Typography.Text>;
        }
        const flags = parseJsonArray(value);
        return (
          <Space size={4} wrap>
            {(flags.length > 0 ? flags : [value]).map((flag) => (
              <Tag key={flag} color="warning">
                {flag}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Milvus PK',
      dataIndex: 'milvusPk',
      key: 'milvusPk',
      width: 160,
      render: (value?: string | null) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {value ? value.slice(0, 12) : '未写入'}
        </Typography.Text>
      ),
    },
  ];

  const hasQualityFlags = (chunks.data ?? []).some((chunk) => Boolean(chunk.qualityFlags));
  const visibleChunkColumns = hasQualityFlags
    ? chunkColumns
    : chunkColumns.filter((column) => column.key !== 'qualityFlags');

  if (detail.error) {
    return (
      <div>
        <PageHeader
          title="文档详情"
          extra={
            <Link href="/documents">
              <Button>返回列表</Button>
            </Link>
          }
        />
        <ErrorState error={detail.error} title="文档加载失败" onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const doc = detail.data;
  const docTitle = doc?.title ?? '';
  const kbName = doc ? nameById.get(doc.kbId) : undefined;

  return (
    <div>
      <PageHeader
        title={doc?.title ?? '文档详情'}
        description={doc ? `ID：${doc.id}` : undefined}
        extra={
          <Space>
            <Link href="/documents">
              <Button>返回列表</Button>
            </Link>
            <Button type="primary" loading={reindex.isPending} onClick={() => reindex.mutate()}>
              重索引
            </Button>
            <Button onClick={() => setPreviewOpen(true)}>查看原文</Button>
          </Space>
        }
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginBottom: 12 }}>
        索引 = 稠密 + 稀疏向量，缺一不可检索；没有索引或没跑完的文档不会出现在检索结果里。删除是软删除：
        切片立即下线并移出检索，数据仍可追溯恢复。
      </Typography.Paragraph>

      <Card loading={detail.isLoading} styles={{ body: { paddingBottom: 8 } }}>
        {doc ? (
          <Descriptions column={{ xs: 1, sm: 2, xl: 3 }} size="small" bordered>
            <Descriptions.Item label="状态">
              <StatusTag kind="document" status={doc.status} />
            </Descriptions.Item>
            <Descriptions.Item label="知识库">
              {kbName ?? <Typography.Text type="secondary">知识库已删除</Typography.Text>}
            </Descriptions.Item>
            <Descriptions.Item label="来源">
              <Tag color={doc.sourceType === 'feishu' ? 'geekblue' : undefined}>
                {sourceLabel(doc.sourceType)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="MIME">{doc.mimeType ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="大小">{formatBytes(doc.sizeBytes ?? undefined)}</Descriptions.Item>
            <Descriptions.Item label="图谱精选">
              {doc.graphSelected ? <Tag color="blue">已入图</Tag> : '未入图'}
            </Descriptions.Item>
            <Descriptions.Item label="当前版本">
              <Typography.Text code>{doc.activeVersionId?.slice(0, 8) ?? '-'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="待生效版本">
              <Typography.Text code>{doc.pendingVersionId?.slice(0, 8) ?? '-'}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">{formatDate(doc.updatedAt)}</Descriptions.Item>
            <Descriptions.Item label="标签" span={2}>
              <Space size={4} wrap>
                <Select
                  mode="tags"
                  style={{ minWidth: 260 }}
                  placeholder="输入后回车添加标签，例如 财务"
                  size="small"
                  value={doc.tags ?? []}
                  onChange={(values) => setTags.mutate(values as string[])}
                  loading={setTags.isPending}
                  tokenSeparators={[',', '，']}
                  options={(doc.tags ?? []).map((tag) => ({ label: tag, value: tag }))}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  标签写进向量切片，检索时可用于收窄范围；能否看到仍由授权决定
                </Typography.Text>
              </Space>
            </Descriptions.Item>
            {doc.sourceUrl ? (
              <Descriptions.Item label="原始链接">
                <Typography.Link href={doc.sourceUrl} target="_blank" rel="noreferrer">
                  {doc.sourceUrl.length > 48 ? `${doc.sourceUrl.slice(0, 48)}…` : doc.sourceUrl}
                </Typography.Link>
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        ) : null}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Tabs
          items={[
            {
              key: 'chunks',
              label: `切片（${chunks.data?.length ?? 0}）`,
              children: (
                <div>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Select
                      allowClear
                      placeholder="全部版本"
                      style={{ width: 220 }}
                      value={versionId}
                      onChange={setVersionId}
                      options={(versions.data ?? []).map((version, index) => ({
                        label: `v${(versions.data?.length ?? 0) - index} · ${VERSION_STATUS_LABELS[version.status] ?? version.status}`,
                        value: version.id,
                      }))}
                    />
                    <Select
                      style={{ width: 130 }}
                      value={limit}
                      onChange={setLimit}
                      options={[200, 500, 1000].map((value) => ({ label: `最多取 ${value} 条`, value }))}
                    />
                    <Button onClick={() => void chunks.refetch()} loading={chunks.isFetching}>
                      刷新
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      切片正文存放在对象存储快照中，此处展示可检索元数据
                    </Typography.Text>
                  </Space>
                  {chunks.error ? (
                    <ErrorState error={chunks.error} title="切片加载失败" onRetry={() => void chunks.refetch()} />
                  ) : null}
                  <Table<ChunkView>
                    rowKey="id"
                    size="small"
                    loading={chunks.isLoading}
                    columns={visibleChunkColumns}
                    dataSource={chunks.data ?? []}
                    pagination={{
                      defaultPageSize: 50,
                      pageSizeOptions: [50, 100, 200, 500],
                      showSizeChanger: true,
                      showTotal: (total) => `共 ${total} 条`,
                    }}
                    scroll={{ x: 1000 }}
                    locale={{ emptyText: <EmptyState title="暂无切片" description="索引完成后切片元数据会出现在这里" /> }}
                  />
                </div>
              ),
            },
            {
              key: 'versions',
              label: `版本（${versions.data?.length ?? 0}）`,
              children: (
                <div>
                  {versions.error ? (
                    <ErrorState error={versions.error} title="版本加载失败" onRetry={() => void versions.refetch()} />
                  ) : null}
                  <Table<DocumentVersionView>
                    rowKey="id"
                    size="small"
                    loading={versions.isLoading}
                    columns={versionColumns}
                    dataSource={versions.data ?? []}
                    pagination={false}
                    scroll={{ x: 900 }}
                    locale={{ emptyText: <EmptyState title="暂无版本记录" /> }}
                  />
                </div>
              ),
            },
          ]}
        />
      </div>

      <Drawer
        title={`原文预览 · ${docTitle}`}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        width={760}
        destroyOnHidden
      >
        {preview.isLoading ? (
          <Typography.Text type="secondary">读取中…</Typography.Text>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {preview.data?.target ? (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  文件：{preview.data.target.filename}（{preview.data.target.kind}）
                </Typography.Text>
                <div style={{ marginTop: 6 }}>
                  <Button href={preview.data.target.url} target="_blank">
                    在新窗口打开原件
                  </Button>
                </div>
              </div>
            ) : null}
            {preview.data?.text ? (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  解析后的正文{preview.data.text.truncated === 'true' ? '（已截断，仅展示前 200KB）' : ''}
                </Typography.Text>
                <pre
                  style={{
                    marginTop: 6,
                    maxHeight: '58vh',
                    overflow: 'auto',
                    padding: 12,
                    borderRadius: 8,
                    background: 'rgba(15, 23, 42, 0.03)',
                    fontSize: 12.5,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {preview.data.text.text}
                </pre>
              </div>
            ) : null}
            {!preview.data?.target && !preview.data?.text ? (
              <EmptyState title="没有可预览的原文" description="原件可能已从对象存储清理，切片与向量不受影响" />
            ) : null}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
