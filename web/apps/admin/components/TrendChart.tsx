'use client';

import type { MetricsTrendPoint } from '@kh/api-client';
import { Empty, Segmented, Space, Spin, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type MetricKey = 'messages' | 'conversations' | 'documents' | 'tokens' | 'failedJobs';

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: 'messages', label: '消息' },
  { key: 'conversations', label: '会话' },
  { key: 'documents', label: '新增文档' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'failedJobs', label: '失败任务' },
];

const HEIGHT = 220;
const PAD = { top: 16, right: 16, bottom: 26, left: 40 };

/** 无图表库依赖的轻量趋势图：面积 + 折线 + 悬停竖线提示 */
export function TrendChart({ points, loading }: { points: MetricsTrendPoint[]; loading?: boolean }) {
  const { token } = theme.useToken();
  const [metric, setMetric] = useState<MetricKey>('messages');
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = boxRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) {
        setWidth(next);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const values = useMemo(() => points.map((point) => Number(point[metric] ?? 0)), [metric, points]);
  const max = Math.max(1, ...values);
  const innerWidth = Math.max(60, width - PAD.left - PAD.right);
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  const coords = values.map((value, index) => ({
    x: PAD.left + index * step,
    y: PAD.top + innerHeight - (value / max) * innerHeight,
    value,
  }));

  const linePath = coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
  const areaPath = coords.length
    ? `${linePath} L${coords[coords.length - 1].x},${PAD.top + innerHeight} L${coords[0].x},${PAD.top + innerHeight} Z`
    : '';

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left - PAD.left;
      if (step <= 0) {
        setActive(0);
        return;
      }
      const index = Math.round(x / step);
      setActive(Math.max(0, Math.min(values.length - 1, index)));
    },
    [step, values.length],
  );

  const activePoint = active != null ? coords[active] : null;
  const activeLabel = active != null ? points[active]?.date : undefined;
  const gradientId = `kh-trend-${metric}`;

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <Segmented
          size="small"
          value={metric}
          onChange={(value) => {
            setMetric(value as MetricKey);
            setActive(null);
          }}
          options={METRICS.map((item) => ({ label: item.label, value: item.key }))}
        />
        <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
          峰值 {max.toLocaleString('zh-CN')} · 近 {points.length} 天
        </span>
      </Space>

      <div ref={boxRef} style={{ position: 'relative', minHeight: HEIGHT }}>
        {loading ? (
          <div style={{ height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : points.length === 0 ? (
          <div style={{ height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
          </div>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="近 7 天趋势"
            onMouseMove={handleMove}
            onMouseLeave={() => setActive(null)}
            style={{ display: 'block' }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={token.colorPrimary} stopOpacity={0.32} />
                <stop offset="100%" stopColor={token.colorPrimary} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            {[0, 0.5, 1].map((ratio) => {
              const y = PAD.top + innerHeight * ratio;
              return (
                <g key={ratio}>
                  <line
                    x1={PAD.left}
                    x2={PAD.left + innerWidth}
                    y1={y}
                    y2={y}
                    stroke={token.colorSplit}
                    strokeDasharray={ratio === 1 ? undefined : '3 4'}
                  />
                  <text x={4} y={y + 4} fontSize={11} fill={token.colorTextTertiary}>
                    {Math.round(max * (1 - ratio)).toLocaleString('zh-CN')}
                  </text>
                </g>
              );
            })}

            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path d={linePath} fill="none" stroke={token.colorPrimary} strokeWidth={2.2} strokeLinejoin="round" />

            {coords.map((point, index) => (
              <g key={points[index]?.date ?? index}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={active === index ? 5 : 3.2}
                  fill={token.colorBgContainer}
                  stroke={token.colorPrimary}
                  strokeWidth={2}
                />
                {index % Math.ceil(points.length / 7) === 0 || index === points.length - 1 ? (
                  <text
                    x={point.x}
                    y={HEIGHT - 8}
                    fontSize={11}
                    textAnchor="middle"
                    fill={token.colorTextTertiary}
                  >
                    {(points[index]?.date ?? '').slice(5)}
                  </text>
                ) : null}
              </g>
            ))}

            {activePoint ? (
              <line
                x1={activePoint.x}
                x2={activePoint.x}
                y1={PAD.top}
                y2={PAD.top + innerHeight}
                stroke={token.colorPrimary}
                strokeDasharray="3 3"
                strokeOpacity={0.6}
              />
            ) : null}
          </svg>
        )}

        {activePoint && !loading ? (
          <div
            style={{
              position: 'absolute',
              left: Math.min(Math.max(activePoint.x - 60, 0), Math.max(0, width - 140)),
              top: 0,
              pointerEvents: 'none',
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              boxShadow: token.boxShadowSecondary,
              padding: '6px 10px',
              fontSize: 12,
              whiteSpace: 'nowrap',
            }}
          >
            <div style={{ color: token.colorTextTertiary }}>{activeLabel}</div>
            <div style={{ fontWeight: 600 }}>
              {METRICS.find((item) => item.key === metric)?.label} {activePoint.value.toLocaleString('zh-CN')}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
