import type { ReactNode } from 'react';
import { AdminChrome } from '@/components/AdminChrome';
import { AuthGate } from '@/lib/providers';

/** 服务端外壳：仅负责组合客户端 chrome 与登录守卫 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <AdminChrome>
      <AuthGate>{children}</AuthGate>
    </AdminChrome>
  );
}
