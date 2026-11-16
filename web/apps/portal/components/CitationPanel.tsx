'use client';

import type { ChatCitation } from '@kh/api-client';
import { EmptyState } from '@kh/ui';
import { Card, Drawer, Space, Tag, Typography } from 'antd';
import { FileTextOutlined, LinkOutlined } from '@ant-design/icons';

function hostOf(url?: string): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function CitationPanel({
  open,
  onClose,
  citations,
  title,
}: {
  open: boolean;
  onClose: () => void;
  citations: ChatCitation[];
  title?: string;
}) {
  return (
    <Drawer
      title={title ?? `引用来源（${citations.length}）`}
      placement="right"
      width={380}
      open={open}
      onClose={onClose}
      mask={false}
      styles={{ body: { padding: 16, background: '#f8fafc' } }}
    >
      {citations.length === 0 ? (
        <EmptyState title="暂无引用" description="回答命中知识库切片后会在此展示来源" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {citations.map((citation, index) => (
            <Card
              key={`${citation.chunkId ?? citation.docId ?? index}-${index}`}
              size="small"
              style={{ borderRadius: 10 }}
              title={
                <Space size={6}>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    [{citation.index ?? index + 1}]
                  </Tag>
                  <Typography.Text ellipsis style={{ maxWidth: 240 }}>
                    {citation.title ?? '未命名文档'}
                  </Typography.Text>
                </Space>
              }
              extra={
                typeof citation.score === 'number' ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {citation.score.toFixed(3)}
                  </Typography.Text>
                ) : null
              }
            >
              <Typography.Paragraph
                style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.7 }}
                ellipsis={{ rows: 6, expandable: true, symbol: '展开' }}
              >
                {citation.snippet ?? '无片段内容'}
              </Typography.Paragraph>
              <Space size={12} wrap>
                {citation.docId ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <FileTextOutlined /> {citation.docId.slice(0, 8)}
                  </Typography.Text>
                ) : null}
                {citation.url ? (
                  <a href={citation.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}>
                    <LinkOutlined /> 打开原文{hostOf(citation.url) ? `（${hostOf(citation.url)}）` : ''}
                  </a>
                ) : null}
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </Drawer>
  );
}
