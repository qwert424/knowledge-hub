'use client';

import type { GatewayModel, KbView } from '@kh/api-client';
import {
  BookOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DownOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Dropdown, Input, Popover, Space, Tooltip, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultModelOf, modelLabelOf, modelShortLabel } from '@/lib/models';

const MAX_CHARS = 4000;

/**
 * 提问输入区。
 *
 * 知识库与模型都在输入框内切换（参考主流的对话产品）：选择立即生效并写回会话，
 * 不需要先建"新会话表单"。Enter 发送、Shift+Enter 换行、Cmd/Ctrl+Enter 强制发送。
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onSteer,
  streaming,
  kbs,
  selectedKbIds,
  onKbChange,
  models,
  selectedModel,
  onModelChange,
  disabled,
  needLogin,
  focusToken,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  kbs: KbView[];
  selectedKbIds: string[];
  onKbChange: (ids: string[]) => void;
  models: GatewayModel[];
  selectedModel?: string | null;
  onModelChange: (model: string | null) => void;
  /** 正在回答时再次发送：interrupt = 打断当前；queue = 等这条答完 */
  onSteer?: (mode: 'interrupt' | 'queue') => void;
  disabled?: boolean;
  needLogin?: boolean;
  /** 每次变化把焦点落到输入框（点「其他（我来描述）」这类候选用） */
  focusToken?: number;
}) {
  const { token } = theme.useToken();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [composing, setComposing] = useState(false);
  /** 知识库是可多选的：用 Popover 持有自己的开关，点一项不会像菜单那样收起来 */
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    if (!focusToken) {
      return;
    }
    textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const kbLabel = useMemo(() => {
    if (selectedKbIds.length === 0) {
      return '不使用知识库';
    }
    const names = selectedKbIds
      .map((id) => kbs.find((kb) => kb.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) {
      return `${selectedKbIds.length} 个知识库`;
    }
    if (names.length <= 2) {
      return names.join('、');
    }
    return `${names.slice(0, 2).join('、')} 等 ${names.length} 个`;
  }, [kbs, selectedKbIds]);

  const defaultModel = defaultModelOf(models.map((model) => ({ id: model.id, mode: model.mode })));
  const modelLabel = modelLabelOf(selectedModel, defaultModel);
  const canSend = value.trim().length > 0 && !disabled;

  /** 知识库选择器：可多选，点一项不关闭；第一项是"不使用知识库" */
  const kbPicker = (
    <div style={{ minWidth: 240, maxWidth: 320 }}>
      <div
        onClick={() => onKbChange([])}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 4px',
          cursor: 'pointer',
          borderRadius: 6,
          color: selectedKbIds.length === 0 ? token.colorPrimary : undefined,
          fontWeight: selectedKbIds.length === 0 ? 600 : 400,
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            border: `1.5px solid ${selectedKbIds.length === 0 ? token.colorPrimary : token.colorBorder}`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selectedKbIds.length === 0 ? (
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorPrimary }} />
          ) : null}
        </span>
        <span style={{ fontSize: 13 }}>不使用知识库（按需自动检索）</span>
      </div>
      <div style={{ height: 1, background: token.colorSplit, margin: '4px 0' }} />
      {kbs.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12.5, padding: '4px' }}>
          暂无可访问的知识库
        </Typography.Text>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {kbs.map((kb) => {
            const checked = selectedKbIds.includes(kb.id);
            return (
              <div
                key={kb.id}
                onClick={() =>
                  onKbChange(
                    checked ? selectedKbIds.filter((id) => id !== kb.id) : [...selectedKbIds, kb.id],
                  )
                }
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '6px 4px',
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
              >
                <Checkbox checked={checked} style={{ marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.4 }}>{kb.name}</div>
                  {kb.description ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11.5, display: 'block', lineHeight: 1.4 }}
                      ellipsis
                    >
                      {kb.description}
                    </Typography.Text>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ height: 1, background: token.colorSplit, margin: '4px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Space size={2}>
          <Button
            size="small"
            type="link"
            style={{ padding: '0 4px' }}
            onClick={() => onKbChange(kbs.map((kb) => kb.id))}
          >
            全选
          </Button>
          <Button
            size="small"
            type="link"
            style={{ padding: '0 4px' }}
            disabled={selectedKbIds.length === 0}
            onClick={() => onKbChange([])}
          >
            清空
          </Button>
        </Space>
        <Button size="small" type="link" onClick={() => setKbOpen(false)}>
          完成
        </Button>
      </div>
    </div>
  );

  const modelMenu = {
    items: [
      {
        key: '__default__',
        label: (
          <Space size={8} style={{ minWidth: 220, justifyContent: 'space-between' }}>
            <span>系统默认</span>
            {!selectedModel ? <CheckOutlined style={{ color: token.colorPrimary }} /> : null}
          </Space>
        ),
        onClick: () => onModelChange(null),
      },
      { type: 'divider' as const },
      ...models.map((model) => ({
        key: model.id,
        label: (
          <Space size={8} style={{ minWidth: 220, justifyContent: 'space-between' }}>
            <span>{modelLabelOf(model.id)}</span>
            {selectedModel === model.id ? <CheckOutlined style={{ color: token.colorPrimary }} /> : null}
          </Space>
        ),
        onClick: () => onModelChange(model.id),
      })),
    ],
  };
  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        borderRadius: token.borderRadiusLG + 4,
        boxShadow: '0 6px 24px rgba(15, 23, 42, 0.06)',
        padding: '10px 12px 8px',
        transition: 'border-color .15s',
      }}
    >
      <Input.TextArea
        ref={(node) => {
          textareaRef.current = node?.resizableTextArea?.textArea ?? null;
        }}
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, MAX_CHARS))}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') {
            return;
          }
          if (composing) {
            return;
          }
          // Shift+Enter 换行；Ctrl/⌘+Enter 与单独 Enter 一样立即发送。
          if (event.shiftKey && !(event.ctrlKey || event.metaKey)) {
            return;
          }
          event.preventDefault();
          if (canSend) {
            onSend();
          }
        }}
        autoSize={{ minRows: 1, maxRows: 8 }}
        placeholder={needLogin ? '输入问题，发送前会请你登录' : '向知识库提问，Enter 发送 / Shift+Enter 换行'}
        variant="borderless"
        style={{ fontSize: 14.5, lineHeight: 1.7, padding: 0 }}
        disabled={disabled}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <Space size={4} wrap>
          <Popover
            content={kbPicker}
            trigger="click"
            placement="topLeft"
            open={kbOpen}
            onOpenChange={setKbOpen}
          >
            <Button size="small" type="text" icon={<BookOutlined />}>
              {kbLabel}
              <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Popover>
          <Dropdown menu={modelMenu} trigger={['click']} placement="topLeft">
            <Button size="small" type="text" icon={<RobotOutlined />}>
              {modelLabel}
              <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
          {selectedKbIds.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              检索范围：{selectedKbIds.length > 1 ? `${selectedKbIds.length} 个知识库（一起查）` : kbLabel}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              未指定知识库：需要时自动检索
            </Typography.Text>
          )}
        </Space>

        <Space size={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {value.length}/{MAX_CHARS}
          </Typography.Text>
          {streaming ? (
            <Space size={8}>
              {canSend ? (
                <>
                  <Tooltip title="停止当前回答，立刻用新内容重新提问">
                    <Button size="small" type="primary" icon={<SendOutlined />} onClick={() => onSteer?.('interrupt')}>
                      打断并发送
                    </Button>
                  </Tooltip>
                  <Tooltip title="当前这条答完后再自动发送">
                    <Button size="small" icon={<ClockCircleOutlined />} onClick={() => onSteer?.('queue')}>
                      排队
                    </Button>
                  </Tooltip>
                </>
              ) : null}
              <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>
                停止
              </Button>
            </Space>
          ) : (
            <Tooltip title="Enter 发送，Shift+Enter 换行">
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!canSend}
                onClick={onSend}
              >
                发送
              </Button>
            </Tooltip>
          )}
        </Space>
      </div>
      {kbs.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          <ThunderboltOutlined /> 暂无可用知识库，将按通用能力回答。
        </Typography.Text>
      ) : null}
    </div>
  );
}
