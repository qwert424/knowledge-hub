'use client';

import type { AdminConversationMessage, AdminConversationRow } from '@kh/api-client';
import { EmptyState, ErrorState, PageHeader, formatDateTime } from '@kh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { defaultModelOf, modelLabelOf } from '@/lib/models';
import { useApi } from '@/lib/providers';
import { Markdown } from '@/components/Markdown';

/**
 * 会话审计。
 *
 * 用户端只能看自己的会话；这里给管理员看全租户的问答（含引用片段），
 * 用来判断回答质量，并把典型问答一键沉淀成评测用例。
 */
export default function ConversationsPage() {
  const api = useApi();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [caseTarget, setCaseTarget] = useState<{
    question: string;
    answer: string;
    docIds: string[];
  } | null>(null);
  const [datasetId, setDatasetId] = useState<string | undefined>();

  const list = useQuery({
    queryKey: ['admin-conversations', keyword, page],
    queryFn: () => api.integrations.adminConversations({ page, pageSize: 20, keyword: keyword || undefined }),
  });

  const detail = useQuery({
    queryKey: ['admin-conversation', openId],
    queryFn: () => api.integrations.adminConversationMessages(openId as string),
    enabled: Boolean(openId),
  });

  const datasets = useQuery({
    queryKey: ['eval-datasets'],
    queryFn: () => api.evalApi.listDatasets(),
  });

  const gatewayModels = useQuery({
    queryKey: ['gateway-models'],
    queryFn: () => api.integrations.models(),
    staleTime: 5 * 60_000,
  });
  const defaultModel = defaultModelOf((gatewayModels.data ?? []).map((model) => ({ id: model.id, mode: model.mode })));

  const addCase = useMutation({
    mutationFn: (payload: { datasetId: string; question: string; answer: string; docIds: string[] }) =>
      api.evalApi.addCases(payload.datasetId, [
        {
          question: payload.question,
          expectedAnswer: payload.answer,
          // 回答里 [cN] 命中的文档就是"应该被检索到"的文档，直接写进用例，省得再手工挑
          expectedDocIds: payload.docIds,
        },
      ]),
    onSuccess: () => {
      message.success('已加入评测集');
      setCaseTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['eval-datasets'] });
    },
    onError: (error: Error) => message.error(error.message || '加入评测集失败'),
  });

  const columns: ColumnsType<AdminConversationRow> = [
    {
      title: '会话',
      dataIndex: 'title',
      render: (title: string, row) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(row.id)}>
          {title || '未命名会话'}
        </Button>
      ),
    },
    { title: '用户', dataIndex: 'owner', width: 140 },
    {
      title: '消息数',
      dataIndex: 'messageCount',
      width: 90,
      render: (value: number | null) => value ?? 0,
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 150,
      render: (value: string | null) => (
        <Tag color={value ? 'blue' : undefined}>{modelLabelOf(value, defaultModel)}</Tag>
      ),
    },
    {
      title: '最后活动',
      dataIndex: 'lastMessageAt',
      width: 180,
      render: (value: string | null) => (value ? formatDateTime(value) : '-'),
    },
    {
      title: '操作',
      width: 110,
      render: (_, row) => (
        <Button size="small" onClick={() => setOpenId(row.id)}>
          查看问答
        </Button>
      ),
    },
  ];

  const messages: AdminConversationMessage[] = detail.data ?? [];
  const pairs = messages
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.role === 'assistant')
    .map(({ item, index }) => {
      const question = [...messages.slice(0, index)].reverse().find((m) => m.role === 'user');
      return {
        question: question?.content ?? '',
        answer: item.content,
        citations: item.citations,
        at: item.createdAt,
      };
    });

  return (
    <div>
      <PageHeader
        title="会话审计"
        description="看全租户的真实问答与引用来源；典型问答可以直接加入评测集"
        extra={
          <Space>
            <Input.Search
              allowClear
              placeholder="按标题搜索"
              style={{ width: 240 }}
              onSearch={(value) => {
                setKeyword(value);
                setPage(1);
              }}
            />
            <Button onClick={() => void list.refetch()}>刷新</Button>
          </Space>
        }
      />

      {list.isError ? (
        <ErrorState error={list.error} title="读取会话失败" onRetry={() => void list.refetch()} />
      ) : (
        <Card>
          <Table
            rowKey="id"
            size="small"
            loading={list.isLoading}
            dataSource={list.data?.items ?? []}
            columns={columns}
            pagination={{
              current: page,
              pageSize: 20,
              total: list.data?.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
          />
        </Card>
      )}

      <Drawer title="问答记录" width={780} open={Boolean(openId)} onClose={() => setOpenId(null)}>
        {detail.isLoading ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : pairs.length === 0 ? (
          <EmptyState title="这条会话还没有回答" />
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {pairs.map((pair, index) => (
              <Card
                key={`${index}-${pair.at}`}
                size="small"
                title={<Typography.Text ellipsis>{pair.question || '（无提问）'}</Typography.Text>}
                extra={
                  <Button
                    size="small"
                    onClick={() =>
                      setCaseTarget({
                        question: pair.question,
                        answer: pair.answer,
                        // 从正文的 [cN] 反查命中的文档 id
                        docIds: [
                          ...new Set(
                            [...pair.answer.matchAll(/\[c(\d+)\]/g)]
                              .map((match) => pair.citations[Number(match[1]) - 1]?.docId)
                              .filter((id): id is string => Boolean(id)),
                          ),
                        ],
                      })
                    }
                  >
                    加入评测集
                  </Button>
                }
              >
                <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                  <Markdown content={pair.answer} />
                </div>
                {pair.citations.length ? (
                  <Descriptions size="small" column={1} bordered>
                    {pair.citations.map((citation, citationIndex) => (
                      <Descriptions.Item
                        key={`${citation.chunkId}-${citationIndex}`}
                        label={`[${citationIndex + 1}] ${citation.title || '来源'}`}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                          {citation.snippet}
                        </Typography.Text>
                      </Descriptions.Item>
                    ))}
                  </Descriptions>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    这条回答没有引用资料
                  </Typography.Text>
                )}
              </Card>
            ))}
          </Space>
        )}
      </Drawer>

      <Modal
        title="加入评测集"
        open={Boolean(caseTarget)}
        onCancel={() => setCaseTarget(null)}
        onOk={() => {
          if (!datasetId || !caseTarget) {
            message.warning('先选一个评测集');
            return;
          }
          addCase.mutate({
            datasetId,
            question: caseTarget.question,
            answer: caseTarget.answer,
            docIds: caseTarget.docIds,
          });
        }}
        confirmLoading={addCase.isPending}
        okText="加入"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            问题以这条真实提问为准，期望答案用当时的回答；回答里引用到的文档会自动写进「期望命中」。
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            placeholder="选择评测集"
            value={datasetId}
            onChange={setDatasetId}
            options={(datasets.data ?? []).map((dataset) => ({
              value: dataset.id,
              label: dataset.name,
            }))}
          />
          <Input.TextArea
            value={caseTarget?.question ?? ''}
            readOnly
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </Space>
      </Modal>
    </div>
  );
}
