import { AntdRegistry } from '@ant-design/nextjs-registry';
import '@ant-design/v5-patch-for-react-19';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PortalProviders, PortalQueryProvider } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Knowledge Hub 智能问答',
  description: '基于企业知识库的可溯源问答工作台',
};

/** 服务端外壳：仅注入 AntD 样式注册与客户端 Provider */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <PortalQueryProvider>
            <PortalProviders>{children}</PortalProviders>
          </PortalQueryProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
