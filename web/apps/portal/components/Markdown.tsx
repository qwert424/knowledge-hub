'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 消息流 Markdown 渲染：支持 GFM 表格、列表、代码块与链接 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          // 知识库图片常带原图尺寸：直接渲染会把回答撞开。
          // 限宽 + 圆角 + 可点开看原图，保证流式排版不乱。
          img: ({ src, alt }) => (
            <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener">
              <img
                src={typeof src === 'string' ? src : undefined}
                alt={alt ?? ''}
                style={{
                  display: 'block',
                  maxWidth: 'min(420px, 100%)',
                  maxHeight: 320,
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  borderRadius: 10,
                  border: '1px solid rgba(0,0,0,0.06)',
                  margin: '8px 0',
                  cursor: 'zoom-in',
                }}
              />
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
