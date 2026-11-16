'use client';

import {
  ApiError,
  createApi,
  createApiClient,
  createLocalStorageSession,
  sessionFromLogin,
} from '@kh/api-client';
import type { ApiBundle, AuthUserProfile, StoredSession } from '@kh/api-client';
import { KhThemeProvider } from '@kh/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8088';

interface AuthContextValue {
  ready: boolean;
  session: StoredSession | null;
  user: AuthUserProfile | null;
  api: ApiBundle;
  login: (input: { tenantId?: string; username: string; password: string }) => Promise<AuthUserProfile>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth 必须在 AdminProviders 内使用');
  }
  return value;
}

export function useApi(): ApiBundle {
  return useAuth().api;
}

/** 刷新令牌用的裸客户端，避免递归进入拦截器 */
const bareClient = createApiClient({ baseUrl: API_BASE_URL });

export function AdminProviders({ children }: { children: ReactNode }) {
  const storage = useMemo(() => createLocalStorageSession(), []);
  const sessionRef = useRef<StoredSession | null>(null);
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  const setSession = useCallback(
    (next: StoredSession | null) => {
      sessionRef.current = next;
      setSessionState(next);
      storage.write(next);
    },
    [storage],
  );

  const api = useMemo(
    () =>
      createApi({
        baseUrl: API_BASE_URL,
        getToken: () => sessionRef.current?.accessToken ?? null,
        refreshToken: async () => {
          const refreshToken = sessionRef.current?.refreshToken;
          if (!refreshToken) {
            return null;
          }
          try {
            const result = await bareClient.request<Parameters<typeof sessionFromLogin>[0]>(
              '/api/v1/auth/refresh',
              { method: 'POST', body: { refreshToken }, allowRefresh: false },
            );
            const next = sessionFromLogin(result);
            setSession(next);
            return next.accessToken;
          } catch {
            return null;
          }
        },
        onUnauthorized: () => {
          setSession(null);
          router.replace('/login');
        },
      }),
    [router, setSession],
  );

  useEffect(() => {
    const stored = storage.read();
    if (!stored?.accessToken) {
      setReady(true);
      return;
    }
    sessionRef.current = stored;
    setSessionState(stored);
    api.auth
      .me()
      .then((profile) => setSession({ ...stored, user: profile }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.isAuthError) {
          setSession(null);
        }
      })
      .finally(() => setReady(true));
    // 只在挂载时校验一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (input: { tenantId?: string; username: string; password: string }) => {
      const result = await api.auth.login(input);
      const next = sessionFromLogin(result);
      const profile = result.user ?? (await api.auth.me());
      setSession({ ...next, user: profile });
      return profile;
    },
    [api.auth, setSession],
  );

  const logout = useCallback(() => {
    setSession(null);
    router.replace('/login');
  }, [router, setSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ ready, session, user: session?.user ?? null, api, login, logout }),
    [api, login, logout, ready, session],
  );

  return (
    <AuthContext.Provider value={value}>
      <KhThemeProvider>{children}</KhThemeProvider>
    </AuthContext.Provider>
  );
}

export function AdminQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 未登录时挡在业务页外，避免页面发出无效请求 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, session } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (ready && !session) {
      router.replace('/login');
    }
  }, [ready, router, session]);

  if (!ready || !session) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 120 }}>
        <Spin size="large" />
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>
          {ready ? '正在跳转登录…' : '正在校验登录状态…'}
        </span>
      </div>
    );
  }
  return <>{children}</>;
}
