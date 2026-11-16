'use client';

import { Alert, Button, Empty, Result, Skeleton, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  image?: ReactNode;
}

export function EmptyState({ title = '暂无数据', description, action, image }: EmptyStateProps) {
  return (
    <Empty
      image={image ?? Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{title}</Typography.Text>
          {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
        </Space>
      }
    >
      {action}
    </Empty>
  );
}

export interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  extra?: ReactNode;
}

function describe(error: unknown): { code?: string; message: string } {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; code?: unknown; requestId?: unknown };
    const message = typeof record.message === 'string' ? record.message : '请求失败';
    const code = typeof record.code === 'string' ? record.code : undefined;
    const requestId = typeof record.requestId === 'string' ? `（requestId: ${record.requestId}）` : '';
    return { code, message: `${message}${requestId}` };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return { message: '请求失败' };
}

/** 列表/详情的统一失败态：显示错误码 + requestId，可重试 */
export function ErrorState({ error, title = '加载失败', onRetry, extra }: ErrorStateProps) {
  const { code, message } = describe(error);
  return (
    <Alert
      type="error"
      showIcon
      message={
        <Space size={8}>
          <span>{title}</span>
          {code ? <Typography.Text code>{code}</Typography.Text> : null}
        </Space>
      }
      description={
        <Space direction="vertical" size={8}>
          <span>{message}</span>
          <Space>
            {onRetry ? (
              <Button size="small" onClick={onRetry}>
                重试
              </Button>
            ) : null}
            {extra}
          </Space>
        </Space>
      }
      style={{ marginBottom: 16 }}
    />
  );
}

export function InlineError({ error }: { error: unknown }) {
  const { code, message } = describe(error);
  return (
    <Alert
      type="error"
      showIcon
      message={`${message}${code ? ` [${code}]` : ''}`}
      style={{ marginTop: 8 }}
    />
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} />;
}

export function PageResultFallback({
  status,
  onRetry,
}: {
  status: 'error' | 'empty' | 'unknown';
  onRetry?: () => void;
}) {
  if (status === 'error') {
    return <Result status="error" title="数据加载失败" extra={onRetry ? <Button onClick={onRetry}>重试</Button> : null} />;
  }
  return <Result status="info" title="暂无数据" />;
}
