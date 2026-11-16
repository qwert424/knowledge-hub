'use client';

import type { ConversationView } from '@kh/api-client';
import {
  DeleteOutlined,
  EditOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Empty, Input, Modal, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';

function relativeTime(value?: string | null): string {
  if (!value) {
    return '';
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const diff = Date.now() - time;
  const minute = 60_000;
  if (diff < minute) {
    return '刚刚';
  }
  if (diff < 60 * minute) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < 24 * 60 * minute) {
    return `${Math.floor(diff / (60 * minute))} 小时前`;
  }
  if (diff < 30 * 24 * 60 * minute) {
    return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  }
  return new Date(value).toLocaleDateString('zh-CN');
}

/**
 * 会话列表：新建即建空会话（不弹表单），标题由首个提问自动生成；支持双击改名与删除。
 */
export function SessionSidebar({
  sessions,
  activeId,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  collapsed,
  loading,
}: {
  sessions: ConversationView[];
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  loading?: boolean;
}) {
  const { token } = theme.useToken();
  const [renaming, setRenaming] = useState<ConversationView | null>(null);
  const [title, setTitle] = useState('');

  if (collapsed) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          height: '100%',
          minHeight: 0,
        }}
      >
        <Tooltip title="新建对话" placement="right">
          <Button type="primary" shape="circle" icon={<PlusOutlined />} onClick={onCreate} />
        </Tooltip>
        <div style={{ width: 24, height: 1, background: token.colorBorderSecondary, margin: '4px 0' }} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            paddingBottom: 12,
          }}
        >
          {sessions.map((session) => {
            const active = session.id === activeId;
            const label = session.title?.trim() || '新对话';
            return (
              <Tooltip key={session.id} title={label} placement="right">
                <button
                  type="button"
                  aria-label={label}
                  onClick={() => onSelect(session.id)}
                  style={{
                    width: 34,
                    height: 34,
                    display: 'grid',
                    placeItems: 'center',
                    border: 'none',
                    borderRadius: token.borderRadius,
                    cursor: 'pointer',
                    background: active ? token.colorFillSecondary : 'transparent',
                    color: active ? token.colorPrimary : token.colorTextTertiary,
                  }}
                >
                  <MessageOutlined />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '0 4px 10px' }}>
        <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate} loading={loading}>
          新建对话
        </Button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '0 4px 12px 2px',
        }}
      >
        {sessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ fontSize: 12 }}>还没有对话</span>}
            style={{ marginTop: 24 }}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 2 }}>
            {sessions.map((session) => {
              const active = session.id === activeId;
              const label = session.title?.trim() || '新对话';
              return (
                <div
                  key={session.id}
                  onDoubleClick={() => {
                    setRenaming(session);
                    setTitle(label);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 8px',
                    borderRadius: token.borderRadius,
                    cursor: 'pointer',
                    background: active ? token.colorFillSecondary : 'transparent',
                    minWidth: 0,
                    overflow: 'hidden',
                  }}
                  onClick={() => onSelect(session.id)}
                >
                  <MessageOutlined
                    style={{
                      fontSize: 13,
                      flex: '0 0 auto',
                      color: active ? token.colorPrimary : token.colorTextTertiary,
                    }}
                  />
                  <div style={{ flex: '1 1 0%', minWidth: 0, overflow: 'hidden' }}>
                    <Typography.Text
                      style={{
                        fontSize: 13,
                        fontWeight: active ? 600 : 400,
                        display: 'block',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {label}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {relativeTime(session.updatedAt)}
                    </Typography.Text>
                  </div>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        {
                          key: 'rename',
                          icon: <EditOutlined />,
                          label: '重命名',
                          onClick: () => {
                            setRenaming(session);
                            setTitle(label);
                          },
                        },
                        {
                          key: 'delete',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: '删除',
                          onClick: () => onDelete(session.id),
                        },
                      ],
                    }}
                  >
                    <Button
                      size="small"
                      type="text"
                      aria-label="更多操作"
                      icon={<MoreOutlined />}
                      style={{ flex: '0 0 auto', marginInlineEnd: -4 }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Dropdown>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(renaming)}
        title="重命名对话"
        okText="保存"
        cancelText="取消"
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (renaming) {
            onRename(renaming.id, title.trim() || '新对话');
          }
          setRenaming(null);
        }}
        destroyOnHidden
      >
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={60}
          showCount
          placeholder="对话标题"
          onPressEnter={() => {
            if (renaming) {
              onRename(renaming.id, title.trim() || '新对话');
            }
            setRenaming(null);
          }}
        />
      </Modal>
    </div>
  );
}
