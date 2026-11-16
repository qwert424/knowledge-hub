import { AntdRegistry } from '@ant-design/nextjs-registry';
import '@ant-design/v5-patch-for-react-19';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminProviders, AdminQueryProvider } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Knowledge Hub 管理端',
  description: '知识库运营、索引治理、检索调试与权限管理',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <AdminQueryProvider>
            <AdminProviders>{children}</AdminProviders>
          </AdminQueryProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
