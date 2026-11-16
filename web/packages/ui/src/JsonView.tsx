'use client';

import { Button, Space, Typography } from 'antd';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { prettyJson } from './format';

export interface JsonViewProps {
  value: unknown;
  /** 默认折叠高度（px），0 表示不折叠 */
  maxHeight?: number;
  title?: string;
  style?: CSSProperties;
}

/** 只读 JSON 查看器：审计前后值、策略配置、图谱查询结果共用 */
export function JsonView({ value, maxHeight = 320, title, style }: JsonViewProps) {
  const [expanded, setExpanded] = useState(false);
  const text = prettyJson(value);
  if (!text) {
    return (
      <Typography.Text type="secondary" style={style}>
        无内容
      </Typography.Text>
    );
  }
  const collapsible = maxHeight > 0 && text.split('\n').length > 12;

  return (
    <div style={style}>
      {title ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
          {title}
        </Typography.Text>
      ) : null}
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: 'rgba(15, 23, 42, 0.04)',
          border: '1px solid rgba(15, 23, 42, 0.08)',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          overflow: 'auto',
          maxHeight: collapsible && !expanded ? maxHeight : undefined,
        }}
      >
        {text}
      </pre>
      {collapsible ? (
        <Space style={{ marginTop: 8 }}>
          <Button size="small" type="link" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? '收起' : '展开全部'}
          </Button>
          <Typography.Text
            type="secondary"
            copyable={{ text }}
            style={{ fontSize: 12 }}
          >
            复制
          </Typography.Text>
        </Space>
      ) : (
        <Typography.Text type="secondary" copyable={{ text }} style={{ fontSize: 12 }}>
          复制
        </Typography.Text>
      )}
    </div>
  );
}
