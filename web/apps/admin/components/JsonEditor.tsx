'use client';

import { Typography } from 'antd';
import { useEffect, useState } from 'react';

/** 文本域 JSON 编辑器：实时校验并回传解析结果，策略配置页复用 */
export function JsonEditor({
  value,
  onChange,
  rows = 16,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value.trim()) {
      setError(null);
      return;
    }
    try {
      JSON.parse(value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'JSON 解析失败');
    }
  }, [value]);

  return (
    <div>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: "'JetBrains Mono', Consolas, Monaco, monospace",
          fontSize: 12.5,
          lineHeight: 1.6,
          padding: 12,
          borderRadius: 8,
          border: `1px solid ${error ? '#d64545' : 'rgba(15,23,42,0.15)'}`,
          outline: 'none',
          resize: 'vertical',
          background: 'rgba(15,23,42,0.02)',
        }}
      />
      {error ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          JSON 格式错误：{error}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          JSON 格式有效
        </Typography.Text>
      )}
    </div>
  );
}

export function isJsonValid(value: string): boolean {
  if (!value.trim()) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
