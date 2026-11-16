'use client';

import type { GraphQueryResult } from '@kh/api-client';
import { EmptyState, ErrorState, JsonView, PageHeader, StatusTag, formatDate } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useApi } from '@/lib/providers';
import { useKbOptions } from '@/lib/useKbOptions';

/** 构建图谱的返回：只有这几个字段对界面有意义 */
interface GraphBuildResult {
  documents?: number;
  chunks?: number;
  entities?: number;
  relations?: number;
  status?: string;
  reason?: string;
}

interface GraphDocRow {
  id: string;
  kbId: string;
  documentId: string;
  status: string;
  entityCount?: number | null;
  relationCount?: number | null;
  /** 最近一次抽取失败的原因（成功时为空） */
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export default function GraphPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { kbs, options: kbOptions } = useKbOptions();

  const [kbId, setKbId] = useState<string | undefined>(undefined);
  const [buildResult, setBuildResult] = useState<GraphBuildResult | null>(null);
  /** 选完一篇就重建选择器：否则最后那一篇的标题会残留在框里，点下去又是空的 */
  const [pickerKey, setPickerKey] = useState(0);
  const [detail, setDetail] = useState<GraphDocRow | null>(null);
  /** 默认增量：只处理待抽取/失败的文档，避免每次都把已抽取的重抽一遍 */
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [queryResult, setQueryResult] = useState<GraphQueryResult | null>(null);
  const [queryForm] = Form.useForm<{ query: string; hops: number }>();

  const kbLabel = kbId
    ? (kbs.find((item) => item.id === kbId)?.name ?? '当前选中的知识库')
    : '';
  // 不选库也要能看：默认列出全部已精选文档，避免“进来是空的”。
  const documents = useQuery({
    queryKey: ['graph-documents', kbId],
    queryFn: () => api.graph.listDocuments(kbId),
    // 有文档在抽取中就自动刷新，让「进度 / 什么时候完成」能看见
    refetchInterval: (query) => {
      const list = (query.state.data as GraphDocRow[] | undefined) ?? [];
      const busy = list.some(
        (row) => row.status === 'building' || row.status === 'pending' || row.status === 'selected',
      );
      return busy ? 2000 : false;
    },
  });

  const summary = useQuery({
    queryKey: ['graph-summary', kbId],
    queryFn: () => api.graph.summary(kbId),
    refetchInterval: 5000,
  });

  // 标题映射需要跨库：不选库时也要能把 documentId 换成标题，否则整列都是“文档已删除”
  const kbDocuments = useQuery({
    queryKey: ['documents', 'graph-candidates', 'all'],
    queryFn: () => api.documents.list({ page: 1, pageSize: 500 }),
  });

  const selectDocument = useMutation({
    mutationFn: (documentId: string) => {
      if (!kbId) {
        throw new Error('请先在上方选一个知识库，再把文档加入图谱');
      }
      return api.graph.selectDocument({ kbId, documentId });
    },
    onSuccess: () => {
      message.success('已加入图谱抽取队列');
      setPickerKey((prev) => prev + 1);
      void queryClient.invalidateQueries({ queryKey: ['graph-documents', kbId] });
      void queryClient.invalidateQueries({ queryKey: ['graph-summary', kbId] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const unselectDocument = useMutation({
    // 取消精选用行自带的 kbId：列表里已经有了，不该再逗用户先选一遍库
    mutationFn: (row: { kbId: string; documentId: string }) =>
      api.graph.unselectDocument({ kbId: row.kbId, documentId: row.documentId }),
    onSuccess: () => {
      message.success('已取消精选');
      void queryClient.invalidateQueries({ queryKey: ['graph-documents', kbId] });
      void queryClient.invalidateQueries({ queryKey: ['graph-summary', kbId] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const build = useMutation({    mutationFn: () => {
      if (!kbId) {
        throw new Error('请先选择知识库');
      }
      return api.graph.build(kbId, onlyMissing);
    },
    onSuccess: (result) => {
      const entities = result.entities ?? 0;
      const relations = result.relations ?? 0;
      if ((result.documents ?? 0) === 0) {
        setBuildResult(result);
        message.info(result.reason || '没有需要抽取的文档');
      } else if (result.status === 'running' || result.started) {
        // 后端已改成后台抽取：不拿「已开始」当结果，等列表轮询出真实状态
        setBuildResult(null);
        message.info(result.reason || '已开始抽取，下表会自动刷新状态');
      } else {
        setBuildResult(result);
        message.success(`抽取完成：实体 ${entities} 个，关系 ${relations} 条`);
      }
      void queryClient.invalidateQueries({ queryKey: ['graph-documents', kbId] });
      void queryClient.invalidateQueries({ queryKey: ['graph-summary', kbId] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const rows = documents.data ?? [];
  const buildingCount = rows.filter((row: GraphDocRow) => row.status === 'building').length;
  const pendingCount = rows.filter((row: GraphDocRow) => row.status === 'pending' || row.status === 'selected').length;
  const anyBuilding = buildingCount > 0 || build.isPending;

  const cancelBuild = useMutation({
    mutationFn: () => api.graph.cancelBuild(kbId as string),
    onSuccess: (result) => {
      message.info(result.reason || '已请求取消');
      void queryClient.invalidateQueries({ queryKey: ['graph-documents', kbId] });
    },
  });

  const query = useMutation({
    mutationFn: (values: { query: string; hops: number }) => {
      if (!kbId) {
        throw new Error('请先选择知识库');
      }
      return api.graph.query({ kbId, query: values.query, hops: values.hops });
    },
    onSuccess: (result) => setQueryResult(result),
    onError: (error: Error) => message.error(error.message),
  });

  /** 抽取状态来自索引/图谱任务，取值不统一：这里映射成人话，未识别就原样显示 */
  const EXTRACT_STATUS: Record<string, { label: string; color: string }> = {
    selected: { label: '已选中（待抽取）', color: 'gold' },
    building: { label: '抽取中', color: 'blue' },
    skipped: { label: '无可用切片', color: 'default' },
    queued: { label: '排队中', color: 'default' },
    pending: { label: '排队中', color: 'default' },
    running: { label: '抽取中', color: 'blue' },
    extracting: { label: '抽取中', color: 'blue' },
    extracted: { label: '已抽取', color: 'green' },
    done: { label: '已抽取', color: 'green' },
    succeeded: { label: '已抽取', color: 'green' },
    failed: { label: '失败', color: 'red' },
  };

  const docColumns: ColumnsType<GraphDocRow> = [
    {
      title: '文档',
      dataIndex: 'documentId',
      key: 'documentId',
      width: 320,
      ellipsis: true,
      render: (value: string) => {
        const title = (kbDocuments.data?.items ?? []).find((doc) => doc.id === value)?.title;
        return (
          <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
            <Typography.Text ellipsis style={{ maxWidth: 290 }}>
              {title ?? '（文档已删除或不在当前库）'}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value.slice(0, 12)}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '抽取状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (value: string) => {
        const meta = EXTRACT_STATUS[value] ?? { label: value || '-', color: 'default' };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '实体',
      dataIndex: 'entityCount',
      key: 'entityCount',
      width: 80,
      align: 'right',
      render: (value?: number | null) => value ?? '-',
    },
    {
      title: '关系',
      dataIndex: 'relationCount',
      key: 'relationCount',
      width: 80,
      align: 'right',
      render: (value?: number | null) => value ?? '-',
    },
    {
      title: '结果',
      key: 'result',
      width: 220,
      render: (_, record) => {
        if (record.status === 'building') {
          return <Typography.Text type="secondary">抽取中…</Typography.Text>;
        }
        if (record.status === 'failed') {
          return (
            <Typography.Text type="danger" ellipsis style={{ maxWidth: 200 }} title={record.lastError ?? ''}>
              {record.lastError || '抽取失败'}
            </Typography.Text>
          );
        }
        if (record.status === 'extracted') {
          return (
            <Typography.Text type="success">
              实体 {record.entityCount ?? 0} · 关系 {record.relationCount ?? 0}
            </Typography.Text>
          );
        }
        if (record.status === 'skipped') {
          return (
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }} title={record.lastError ?? ''}>
              {record.lastError || '无可用切片'}
            </Typography.Text>
          );
        }
        return <Typography.Text type="secondary">待抽取</Typography.Text>;
      },
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      render: (value?: string | null) => formatDate(value),
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
            disabled={record.status === 'building' || build.isPending}
            title={record.status === 'building' ? '抽取完成后才能看结果' : undefined}
            onClick={() => setDetail(record)}
          >
            查看结果
          </Button>
          <Popconfirm
            title="取消精选？"
            disabled={record.status === 'building'}
            description="取消后不再参与图谱抽取；已经抽出来的实体不会删除。"
            okText="取消精选"
            cancelText="保留"
            okButtonProps={{ danger: true }}
            onConfirm={() => unselectDocument.mutate(record)}
          >
            <Button
              size="small"
              type="link"
              danger
              disabled={record.status === 'building'}
              loading={
                unselectDocument.isPending &&
                unselectDocument.variables?.documentId === record.documentId
              }
            >
              取消精选
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const docTitle = (documentId: string) =>
    (kbDocuments.data?.items ?? []).find((doc) => doc.id === documentId)?.title ??
    `文档 ${documentId.slice(0, 8)}`;

  const selectedGraphDocs = documents.data ?? [];
  const selectedIds = new Set(selectedGraphDocs.map((item) => item.documentId));

  const candidateOptions = (kbDocuments.data?.items ?? [])
    .filter((doc) => (kbId ? doc.kbId === kbId : false))
    .filter((doc) => !selectedIds.has(doc.id))
    .map((doc) => ({ label: `${doc.title}（${doc.status}）`, value: doc.id }));

  return (
    <div>
      <PageHeader
        title="图谱"
        description="仅精选文档入图；抽取实体与关系后可按 k 跳子图或社区摘要查询。注意：这里只管「抽不抽」；检索时要不要走图，看「检索策略」里的 graph.enabled"
        extra={
          <Space wrap>
            <Select
              style={{ width: 260 }}
              allowClear
              placeholder="全部知识库（可选具体查看）"
              value={kbId}
              onChange={(value) => {
                setKbId(value);
                setBuildResult(null);
                setQueryResult(null);
              }}
              // 只有开了图谱抽取的库才可能入图，关着的库在这里没有意义
              options={kbs
                .filter((kb) => kb.graphEnabled)
                .map((kb) => ({ label: kb.name, value: kb.id }))}
              showSearch
              optionFilterProp="label"
              notFoundContent="没有开启图谱抽取的知识库"
            />
            <Tooltip title="已抽取的文档默认跳过；模型或提示词改了才需要全量重建">
              <Space size={4}>
                <Switch size="small" checked={onlyMissing} onChange={setOnlyMissing} />
                <Typography.Text style={{ fontSize: 12 }}>只处理未抽取</Typography.Text>
              </Space>
            </Tooltip>
            <Button
              type="primary"
              disabled={!kbId || selectedGraphDocs.length === 0 || anyBuilding}
              loading={build.isPending}
              onClick={() => build.mutate()}
              title={!kbId ? '先选一个知识库' : undefined}
            >
              构建图谱
            </Button>
            {anyBuilding ? (
              <Button danger loading={cancelBuild.isPending} onClick={() => cancelBuild.mutate()}>
                取消抽取
              </Button>
            ) : null}
            {buildingCount > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                抽取中 {buildingCount} 篇，完成后本行会自动变成「已抽取」
              </Typography.Text>
            ) : null}
          </Space>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {[
          { label: '精选文档', value: summary.data?.selected ?? 0, hint: '参与抽取的文档数' },
          { label: '已抽取', value: summary.data?.extracted ?? 0, hint: '完成抽取的文档数' },
          { label: '实体', value: summary.data?.entities ?? 0, hint: '全部文档累计' },
          { label: '关系', value: summary.data?.relations ?? 0, hint: '全部文档累计' },
        ].map((item) => (
          <Col xs={12} md={6} key={item.label}>
            <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {item.label}
              </Typography.Text>
              <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.4 }}>{item.value}</div>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {item.hint}
              </Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card
              title="精选文档"
              styles={{ body: { paddingTop: 12 } }}
              extra={
                <Select
                  key={pickerKey}
                  style={{ width: 260 }}
                  disabled={!kbId}
                  placeholder={kbId ? '选择文档加入图谱' : '先在上方选一个知识库'}
                  showSearch
                  optionFilterProp="label"
                  options={candidateOptions}
                  loading={kbDocuments.isLoading}
                  onSelect={(value) => selectDocument.mutate(String(value))}
                  value={undefined}
                />
              }
            >
              {documents.error ? (
                <ErrorState error={documents.error} title="图谱文档加载失败" onRetry={() => void documents.refetch()} />
              ) : null}
              <Table<GraphDocRow>
                rowKey="id"
                size="small"
                loading={documents.isLoading}
                columns={docColumns}
                dataSource={selectedGraphDocs}
                pagination={{ pageSize: 10 }}
                tableLayout="fixed"
                scroll={{ x: 1200 }}
                locale={{ emptyText: <EmptyState title="暂无精选文档" description="从右上角选择文档加入图谱" /> }}
              />
            </Card>

            <Card title="构建结果" style={{ marginTop: 16 }} styles={{ body: { paddingTop: 12 } }}>
              {build.error ? <ErrorState error={build.error} title="构建失败" /> : null}
              {buildResult ? (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Tag color="blue">文档 {buildResult.documents ?? 0}</Tag>
                    <Tag color="blue">切片 {buildResult.chunks ?? 0}</Tag>
                    <Tag color={(buildResult.entities ?? 0) > 0 ? 'green' : 'default'}>
                      实体 {buildResult.entities ?? 0}
                    </Tag>
                    <Tag color={(buildResult.relations ?? 0) > 0 ? 'green' : 'default'}>
                      关系 {buildResult.relations ?? 0}
                    </Tag>
                    <StatusTag
                      kind="result"
                      status={buildResult.status === 'ok' ? 'SUCCESS' : 'FAILED'}
                    />
                  </Space>
                  {buildResult.reason && buildResult.status !== 'ok' ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {buildResult.reason}
                    </Typography.Text>
                  ) : null}
                  {(buildResult.entities ?? 0) === 0 && buildResult.status === 'ok' ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      模型没抽到实体：常见于文档正文太短、全是表格字段，或切片没入库（先看「文档」里的切片数）。
                    </Typography.Text>
                  ) : null}
                </Space>
              ) : (
                <Typography.Text type="secondary">点「构建图谱」后这里显示本次结果</Typography.Text>
              )}
            </Card>
          </Col>

          <Col xs={24} xl={12}>
            <Card title="图谱查询" styles={{ body: { paddingTop: 12 } }}>
              <Form
                form={queryForm}
                layout="inline"
                initialValues={{ hops: 2 }}
                onFinish={(values) => query.mutate(values)}
                style={{ marginBottom: 12, rowGap: 8 }}
              >
                <Form.Item name="query" rules={[{ required: true, message: '请输入查询' }]} style={{ flex: 1, minWidth: 220 }}>
                  <Input placeholder="实体或问题，例如：退款政策的负责人" />
                </Form.Item>
                <Form.Item name="hops" label="跳数">
                  <InputNumber min={1} max={4} style={{ width: 70 }} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={query.isPending}>
                  查询
                </Button>
              </Form>

              {query.error ? <ErrorState error={query.error} title="图谱查询失败" /> : null}

              {queryResult ? (
                <Tabs
                  size="small"
                  items={[
                    {
                      key: 'entities',
                      label: `实体 ${queryResult.entities?.length ?? 0}`,
                      children: (
                        <Table
                          rowKey={(record, index) => String(record.id ?? index)}
                          size="small"
                          pagination={{ pageSize: 8 }}
                          dataSource={queryResult.entities ?? []}
                          locale={{ emptyText: <EmptyState title="无实体" /> }}
                          columns={[
                            {
                              title: '名称',
                              key: 'name',
                              render: (_, record) => (
                                <Space direction="vertical" size={0}>
                                  <Typography.Text strong>{String(record.name ?? record.id ?? '-')}</Typography.Text>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {String(record.type ?? '')}
                                  </Typography.Text>
                                </Space>
                              ),
                            },
                            {
                              title: '说明',
                              key: 'description',
                              render: (_, record) => (
                                <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
                                  {String(record.description || '-')}
                                </Typography.Paragraph>
                              ),
                            },
                            {
                              title: '匹配度',
                              key: 'score',
                              width: 100,
                              align: 'right',
                              render: (_, record) =>
                                typeof record.score === 'number' && record.score > 0 ? (
                                  <Space size={4}>
                                    <Tag color={record.seed === false ? 'default' : 'green'}>
                                      {record.seed === false ? '邻居' : '命中'}
                                    </Tag>
                                    {(record.score * 100).toFixed(0)}%
                                  </Space>
                                ) : (
                                  <Tag>邻居</Tag>
                                ),
                            },
                          ]}
                        />
                      ),
                    },
                    {
                      key: 'relations',
                      label: `关系 ${queryResult.relations?.length ?? 0}`,
                      children: (
                        <Table
                          rowKey={(record, index) => String(record.id ?? index)}
                          size="small"
                          pagination={{ pageSize: 8 }}
                          dataSource={queryResult.relations ?? []}
                          locale={{ emptyText: <EmptyState title="无关系" /> }}
                          columns={[
                            {
                              title: '两端实体',
                              key: 'endpoints',
                              render: (_, record) => (
                                <Typography.Text>
                                  {String(record.source ?? '-')} → {String(record.target ?? '-')}
                                </Typography.Text>
                              ),
                            },
                            {
                              title: '关系',
                              key: 'type',
                              width: 180,
                              render: (_, record) => <Tag color="blue">{String(record.type ?? 'RELATED')}</Tag>,
                            },
                          ]}
                        />
                      ),
                    },
                    {
                      key: 'communities',
                      label: `社区 ${queryResult.communities?.length ?? 0}`,
                      children: (
                        <Table
                          rowKey={(record, index) => String(record.id ?? index)}
                          size="small"
                          pagination={{ pageSize: 8 }}
                          dataSource={queryResult.communities ?? []}
                          locale={{ emptyText: <EmptyState title="无社区摘要" /> }}
                          columns={[
                            { title: 'ID', dataIndex: 'id', key: 'id', width: 140 },
                            {
                              title: '摘要',
                              key: 'summary',
                              render: (_, record) => (
                                <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                                  {String(record.summary ?? '-')}
                                </Typography.Paragraph>
                              ),
                            },
                          ]}
                        />
                      ),
                    },
                    {
                      key: 'raw',
                      label: '原始响应',
                      children: <JsonView value={queryResult} maxHeight={320} />,
                    },
                  ]}
                />
              ) : (
                <Typography.Text type="secondary">
                  输入实体名或一句话，会返回命中的实体、它们之间的关系，以及这些实体出自哪些切片（当前可查：
                  {kbLabel || '全部已构建图谱的知识库'}）
                </Typography.Text>
              )}
            </Card>
          </Col>
        </Row>

      <Drawer
        title={detail ? '构建结果' : ''}
        width={520}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        destroyOnHidden
      >
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="文档">
                {docTitle(detail.documentId)}
              </Descriptions.Item>
              <Descriptions.Item label="抽取状态">
                <Tag color={(EXTRACT_STATUS[detail.status] ?? {}).color ?? 'default'}>
                  {(EXTRACT_STATUS[detail.status] ?? { label: detail.status }).label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="实体 / 关系">
                {detail.entityCount ?? 0} / {detail.relationCount ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="最后更新">
                {formatDate(detail.updatedAt)}
              </Descriptions.Item>
              {detail.lastError ? (
                <Descriptions.Item label="失败原因">
                  <Typography.Text type="danger">{detail.lastError}</Typography.Text>
                </Descriptions.Item>
              ) : null}
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              实体与关系写在 Neo4j，下面的「图谱查询」输入实体名（例如产品型号）就能回链到证据切片。
            </Typography.Paragraph>
            <Button
              onClick={() => {
                setDetail(null);
                queryForm.setFieldsValue({ query: docTitle(detail.documentId) });
              }}
            >
              用这个标题去图谱查询
            </Button>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
