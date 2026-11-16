'use client';

import type { ChatCitation, ChatUsage } from '@kh/api-client';
import {
  BulbOutlined,
  CheckOutlined,
  CopyOutlined,
  DislikeFilled,
  DislikeOutlined,
  DownOutlined,
  EditOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  LikeFilled,
  LikeOutlined,
  RedoOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { Alert, Button, Popover, Select, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import { modelShortLabel } from '@/lib/models';
import { Markdown } from './Markdown';

export type UiMessageStatus = 'streaming' | 'completed' | 'stopped' | 'failed';

export interface UiMessage {
  /** 本地 id（乐观消息用），服务端返回后不变 */
  id: string;
  serverId?: string;
  role: 'user' | 'assistant';
  content: string;
  status: UiMessageStatus;
  citations: ChatCitation[];
  error?: string;
  usage?: ChatUsage;
  createdAt?: string;
  feedback?: 'up' | 'down';
  /** 服务端 status 事件里的阶段，用于展示"正在做什么" */
  stage?: string;
  /** 过程记录（阶段 + 工具调用），可折叠展示，让用户看到"思考链" */
  steps?: string[];
  /** 发这条提问时实际用的模型别名（null = 跟随系统默认），编辑重答据此还原条件 */
  model?: string | null;
  /** 发这条提问时选中的知识库；空数组表示"按需自动检索" */
  kbIds?: string[];
  /** 主 Agent 请用户补充信息：界面把候选渲染成可点选按钮 */
  ask?: { question: string; options: string[] };
}

function citationIndex(citation: ChatCitation, index: number): number {
  return citation.index ?? index + 1;
}

/**
 * 首字前那段等待最容易让人以为卡住，所以把服务端的阶段事件翻译成一句话。
 */
const STAGE_LABELS: Record<string, string> = {
  route: '判断是否需要检索',
  retrieve: '检索知识库',
  direct: '直接作答',
  agent: '交给主 Agent 处理',
  plan: '规划步骤',
  generate: '整理答案',
  resume: '继续生成',
  review: '复核答案',
  security: '安全检查',
  awaiting_user: '等待你补充信息',
};

/** 过程记录：只展示有意义的阶段，避免把内部细节糊到界面上 */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/**
 * 只列出回答正文真正引用到的片段（按 [cN] 标记）。
 * "资料不足"之类没有标记的回答不展示引用列表——这正是之前最刺眼的问题。
 */
export function usedCitations(content: string, citations: ChatCitation[]): ChatCitation[] {
  if (citations.length === 0) {
    return [];
  }
  const marks = new Set<number>();
  for (const match of content.matchAll(/\[c(\d+)\]/g)) {
    marks.add(Number(match[1]));
  }
  if (marks.size === 0) {
    return [];
  }
  return citations.filter((citation, index) => marks.has(citationIndex(citation, index)));
}

export function MessageBubble({
  message,
  hasFollowing,
  onOpenCitations,
  onFeedback,
  onRetry,
  onQuickReply,
  onEdit,
  onResume,
  onCheckpoint,
  canOperate,
  editContext,
}: {
  message: UiMessage;
  /** 这条后面还有消息：中断提示就不必再强调，交给操作按钮 */
  hasFollowing?: boolean;
  onOpenCitations: (citations: ChatCitation[]) => void;
  onFeedback: (message: UiMessage, rating: 'up' | 'down', comment?: string) => void;
  onRetry?: (message: UiMessage) => void;
  /** 点选主 Agent 给出的候选后，直接作为下一条提问发出 */
  onQuickReply?: (text: string) => void;
  onEdit?: (message: UiMessage, content: string, options: { model: string | null; kbIds: string[] }) => void;
  onResume?: (message: UiMessage) => void;
  onCheckpoint?: (message: UiMessage) => void;
  canOperate: boolean;
  /** 编辑提问时可直接改"这条用哪个模型、查哪些库"，默认是这条当时的条件 */
  editContext?: {
    models: Array<{ id: string; label: string }>;
    kbs: Array<{ id: string; name: string }>;
    defaultModel?: string | null;
    defaultKbIds: string[];
  };
}) {
  const { token } = theme.useToken();
  const [copied, setCopied] = useState(false);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  /** 编辑时可选：默认沿用消息里记下的模型/知识库 */
  const [editModel, setEditModel] = useState<string | null>(message.model ?? null);
  const [editKbIds, setEditKbIds] = useState<string[]>(message.kbIds ?? []);
  const [showSteps, setShowSteps] = useState(false);
  // 溯源只展开这一条自己的片段，点别的消息不会连带把这条也摊开。
  const [showSources, setShowSources] = useState(false);

  const streaming = message.status === 'streaming';
  const isUser = message.role === 'user';
  const currentStage = message.stage ? stageLabel(message.stage) : '';
  const statusLabel = message.content ? '正在整理答案…' : `${currentStage || '正在准备回答'}…`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (isUser) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {editing ? (
          <div style={{ width: '78%' }}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              style={{
                width: '100%',
                resize: 'vertical',
                padding: '10px 12px',
                borderRadius: token.borderRadiusLG,
                border: `1px solid ${token.colorBorder}`,
                background: token.colorBgContainer,
                fontSize: 14,
                lineHeight: 1.7,
                outline: 'none',
              }}
            />
            <Space size={8} style={{ marginTop: 6, width: '100%' }} wrap>
              <Typography.Text style={{ fontSize: 12 }}>模型</Typography.Text>
              <Select
                size="small"
                style={{ width: 190 }}
                value={editModel ?? '__default__'}
                onChange={(value) => setEditModel(value === '__default__' ? null : (value as string))}
                options={[
                  {
                    value: '__default__',
                    label: `跟随系统默认${editContext?.defaultModel ? `（${editContext.defaultModel}）` : ''}`,
                  },
                  ...(editContext?.models ?? []).map((model) => ({ value: model.id, label: model.label })),
                ]}
              />
              <Typography.Text style={{ fontSize: 12 }}>检索范围</Typography.Text>
              <Select
                size="small"
                mode="multiple"
                allowClear
                maxTagCount={1}
                style={{ minWidth: 200, maxWidth: 280 }}
                placeholder="不指定（按需自动检索）"
                value={editKbIds}
                onChange={(values) => setEditKbIds(values as string[])}
                options={(editContext?.kbs ?? []).map((kb) => ({ value: kb.id, label: kb.name }))}
              />
            </Space>
            <Space size={8} style={{ marginTop: 6, width: '100%', justifyContent: 'flex-end' }}>
              <Button
                type="primary"
                size="small"
                onClick={() => {
                  setEditing(false);
                  onEdit?.(message, draft.trim(), { model: editModel, kbIds: editKbIds });
                }}
                disabled={!draft.trim()}
              >
                保存并重答
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                  setEditModel(message.model ?? null);
                  setEditKbIds(message.kbIds ?? []);
                }}
              >
                取消
              </Button>
            </Space>
          </div>
        ) : (
          <div
            style={{
              maxWidth: '78%',
              background: token.colorPrimary,
              color: '#fff',
              padding: '10px 14px',
              borderRadius: '14px 14px 4px 14px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.7,
              fontSize: 14.5,
            }}
          >
            {message.content}
          </div>
        )}

        {!editing && canOperate ? (
          <Space size={2}>
            <Tooltip title="编辑后重新回答">
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
              />
            </Tooltip>
            <Tooltip title={copied ? '已复制' : '复制'}>
              <Button size="small" type="text" icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={copy} />
            </Tooltip>
            {onCheckpoint ? (
              <Tooltip title="回到这条提问，改完直接发送">
                <Button size="small" type="text" icon={<HistoryOutlined />} onClick={() => onCheckpoint(message)} />
              </Tooltip>
            ) : null}
          </Space>
        ) : null}
      </div>
    );
  }

  const used = usedCitations(message.content, message.citations);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: '4px 14px 14px 14px',
          padding: '12px 16px',
          fontSize: 14.5,
          lineHeight: 1.75,
        }}
      >
        {message.steps && message.steps.length > 0 ? (
          <div style={{ marginBottom: message.content ? 10 : 0 }}>
            <button
              type="button"
              onClick={() => setShowSteps((prev) => !prev)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: 'none',
                background: token.colorFillQuaternary,
                color: token.colorTextSecondary,
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              <BulbOutlined />
              {streaming ? `正在${currentStage || '处理'}` : `思考过程（${message.steps.length} 步）`}
              {showSteps ? <UpOutlined style={{ fontSize: 10 }} /> : <DownOutlined style={{ fontSize: 10 }} />}
            </button>
            {showSteps ? (
              <ol
                style={{
                  margin: '8px 0 0',
                  paddingLeft: 18,
                  fontSize: 12.5,
                  lineHeight: 1.8,
                  color: token.colorTextSecondary,
                }}
              >
                {message.steps.map((step, index) => (
                  <li key={`${step}-${index}`}>{step}</li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
        {message.content ? (
          <Markdown content={message.content} />
        ) : streaming ? (
          <Space size={8}>
            <span className="kh-dots">
              <i />
              <i />
              <i />
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {statusLabel}
            </Typography.Text>
          </Space>
        ) : message.status === 'stopped' ? (
          <Typography.Text type="secondary">已停止，这次没有生成内容</Typography.Text>
        ) : (
          <Typography.Text type="secondary">没有生成内容，可以重新生成一次</Typography.Text>
        )}

        {message.error ? (
          <Alert type="error" showIcon style={{ marginTop: 10 }} message="生成失败" description={message.error} />
        ) : null}
      </div>

      {used.length > 0 ? (
        <Space size={6} wrap>
          {used.map((citation, index) => (
            <Tag
              key={`${citation.chunkId ?? index}`}
              style={{ cursor: 'pointer', borderRadius: 10, marginInlineEnd: 0, fontSize: 12 }}
              onClick={() => onOpenCitations(used)}
            >
              [{citationIndex(citation, index)}] {citation.title ?? '来源'}
            </Tag>
          ))}
        </Space>
      ) : null}

      {showSources && used.length > 0 ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {used.slice(0, 3).map((citation, index) => (
            <div
              key={`${citation.chunkId ?? index}-snippet`}
              style={{
                background: token.colorFillQuaternary,
                borderLeft: `3px solid ${token.colorPrimaryBorder}`,
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 12.5,
                lineHeight: 1.65,
                color: token.colorTextSecondary,
              }}
            >
              <Typography.Text strong style={{ fontSize: 12, marginRight: 6 }}>
                [{citationIndex(citation, index)}]
              </Typography.Text>
              {citation.snippet ?? '（无片段）'}
            </div>
          ))}
        </div>
      ) : null}

      {message.status === 'stopped' && !hasFollowing && canOperate ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '6px 10px',
            borderRadius: token.borderRadius,
            background: token.colorFillQuaternary,
            fontSize: 12.5,
            color: token.colorTextSecondary,
            flexWrap: 'wrap',
          }}
        >
          <span>{message.content ? '已停止，回答还没写完' : '已停止，还没有生成内容'}</span>
          <Space size={6}>
            {onResume && message.content ? (
              <Button size="small" type="primary" onClick={() => onResume(message)}>
                继续生成
              </Button>
            ) : null}
            <Button size="small" onClick={() => onRetry?.(message)}>
              重新回答
            </Button>
          </Space>
        </div>
      ) : null}

      {message.ask && message.ask.options.length > 0 ? (
        <Space size={8} wrap style={{ marginTop: 8 }}>
          {message.ask.options.map((option) => (
            <Button
              key={option}
              size="small"
              onClick={() => onQuickReply?.(option)}
              disabled={!onQuickReply}
            >
              {option}
            </Button>
          ))}
        </Space>
      ) : null}

      {!streaming ? (
        <Space size={2} wrap>
          {message.status === 'stopped' && hasFollowing ? (
            <Tag color="warning" style={{ borderRadius: 10, marginInlineEnd: 4, fontSize: 11.5 }}>
              已中断
            </Tag>
          ) : null}
          {/* 中断提示只在"最后一条"用横幅；后面还有消息时用一行小按钮，避免两处重复 */}
          {message.status === 'stopped' && hasFollowing && onResume && message.content ? (
            <Button size="small" type="link" style={{ fontSize: 12 }} onClick={() => onResume(message)}>
              继续生成
            </Button>
          ) : null}
          {canOperate ? (
            <>
              <Tooltip title="回答有帮助">
                <Button
                  size="small"
                  type="text"
                  icon={
                    message.feedback === 'up' ? <LikeFilled style={{ color: token.colorSuccess }} /> : <LikeOutlined />
                  }
                  onClick={() => onFeedback(message, 'up')}
                />
              </Tooltip>
              <Popover
                trigger="click"
                title="这回答哪里不对？"
                content={
                  <div style={{ width: 240 }}>
                    <textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      rows={3}
                      placeholder="补充说明（可选）"
                      style={{
                        width: '100%',
                        padding: 8,
                        borderRadius: 6,
                        border: `1px solid ${token.colorBorder}`,
                        background: token.colorBgContainer,
                        resize: 'vertical',
                        fontSize: 13,
                      }}
                    />
                    <Button
                      type="primary"
                      size="small"
                      block
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        onFeedback(message, 'down', comment || undefined);
                        setComment('');
                      }}
                    >
                      提交反馈
                    </Button>
                  </div>
                }
              >
                <Button
                  size="small"
                  type="text"
                  icon={
                    message.feedback === 'down' ? (
                      <DislikeFilled style={{ color: token.colorError }} />
                    ) : (
                      <DislikeOutlined />
                    )
                  }
                />
              </Popover>
              <Tooltip title="用输入框当前选择的模型重新生成（未选择则沿用这条的模型）">
                <Button size="small" type="text" icon={<RedoOutlined />} onClick={() => onRetry?.(message)} />
              </Tooltip>
              <Tooltip title={copied ? '已复制' : '复制'}>
                <Button
                  size="small"
                  type="text"
                  icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={copy}
                />
              </Tooltip>
              {used.length > 0 ? (
                <Tooltip title={showSources ? '收起这条的出处片段' : '只看这条回答的出处片段'}>
                  <Button
                    size="small"
                    type="text"
                    icon={<FileSearchOutlined />}
                    style={{ fontSize: 12, color: showSources ? token.colorPrimary : undefined }}
                    onClick={() => setShowSources((prev) => !prev)}
                  >
                    {showSources ? '收起' : '溯源'}
                  </Button>
                </Tooltip>
              ) : null}
            </>
          ) : null}
          {message.usage ? (
            <Typography.Text type="secondary" style={{ fontSize: 11.5, marginLeft: 4 }}>
              {modelShortLabel(message.usage.model)}
              {message.usage.output_tokens || message.usage.outputTokens
                ? ` · ${message.usage.output_tokens ?? message.usage.outputTokens} tokens`
                : ''}
            </Typography.Text>
          ) : null}
        </Space>
      ) : null}
    </div>
  );
}
