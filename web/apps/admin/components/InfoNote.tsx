'use client';

import { InfoCircleOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 说明块。
 *
 * 之前各页面都用 `<Alert type="info">` 讲规则，蓝色大块、占一整屏、还带图标底色，
 * 一屏三四个非常吵。这里统一成一行式的中性提示：灰底、单行说明、可选要点列表。
 */
export function InfoNote({
  title,
  children,
  items,
  extra,
}: {
  title?: ReactNode;
  children?: ReactNode;
  /** 需要多条规则时用列表，比塞一个长句子好读 */
  items?: ReactNode[];
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 12px',
        marginBottom: 16,
        borderRadius: 10,
        background: 'rgba(15, 23, 42, 0.03)',
        border: '1px solid rgba(15, 23, 42, 0.06)',
        fontSize: 12.5,
        lineHeight: 1.7,
        color: 'rgba(15, 23, 42, 0.72)',
      }}
    >
      <InfoCircleOutlined style={{ marginTop: 4, color: 'rgba(15, 23, 42, 0.35)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <Typography.Text strong style={{ marginRight: 6 }}>
            {title}
          </Typography.Text>
        ) : null}
        {children}
        {items && items.length > 0 ? (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {extra ? <div style={{ flex: '0 0 auto' }}>{extra}</div> : null}
    </div>
  );
}
