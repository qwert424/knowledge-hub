'use client';

import { ApiError, createApi, createApiClient, sessionFromLogin } from '@kh/api-client';
import type { ApiBundle, AuthUserProfile, SessionStorage, StoredSession } from '@kh/api-client';
import { KhThemeProvider } from '@kh/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthModal } from '@/components/AuthModal';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8088';
const COOKIE_NAME = 'kh_session';

/**
 * Portal 约定：令牌只存在内存 + 轻量 cookie（不含用户信息），刷新页面时用 /auth/me 重建档案。
 */
function createCookieSession(): SessionStorage {
  let cache: StoredSession | null = null;
  return {
    read: () => {
      if (cache) {
        return cache;
      }
      if (typeof document === 'undefined') {
        return null;
      }
      const prefix = `${COOKIE_NAME}=`;
      const raw = document.cookie
        .split('; ')
        .find((item) => item.startsWith(prefix))
        ?.slice(prefix.length);
      if (!raw) {
        return null;
      }
      try {
        cache = JSON.parse(decodeURIComponent(raw)) as StoredSession;
        return cache;
      } catch {
        return null;
      }
    },
    write: (session) => {
      cache = session;
      if (typeof document === 'undefined') {
        return;
      }
      if (!session) {
        document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
        return;
      }
      const minimal: StoredSession = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
      };
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(
        JSON.stringify(minimal),
      )}; path=/; max-age=86400; SameSite=Lax`;
    },
  };
}

export interface AuthInput {
  tenantId?: string;
  username: string;
  password: string;
  displayName?: string;
}

interface PortalAuthValue {
  ready: boolean;
  session: StoredSession | null;
  user: AuthUserProfile | null;
  signedIn: boolean;
  api: ApiBundle;
  login: (input: AuthInput) => Promise<AuthUserProfile>;
  register: (input: AuthInput) => Promise<AuthUserProfile>;
  logout: () => void;
  /** 已登录返回 true；未登录则弹出登录框并返回 false（不跳转、不打断浏览）。 */
  ensureSignedIn: (reason?: string) => boolean;
  openAuth: (reason?: string) => void;
}

const AuthContext = createContext<PortalAuthValue | null>(null);

export function usePortalAuth(): PortalAuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('usePortalAuth 必须在 PortalProviders 内使用');
  }
  return value;
}

export function useApi(): ApiBundle {
  return usePortalAuth().api;
}

const bareClient = createApiClient({ baseUrl: API_BASE_URL });

export function PortalProviders({ children }: { children: ReactNode }) {
  const storage = useMemo(() => createCookieSession(), []);
  const sessionRef = useRef<StoredSession | null>(null);
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authReason, setAuthReason] = useState<string>('登录后即可开始提问');
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
          // 令牌过期只清登录态并弹框，不把用户从当前页面踢走。
          setSession(null);
          setAuthReason('登录已过期，请重新登录');
          setAuthOpen(true);
        },
      }),
    [setSession],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (input: AuthInput) => {
      const result = await api.auth.login({
        tenantId: input.tenantId,
        username: input.username,
        password: input.password,
      });
      const profile = (result.user ?? (await api.auth.me())) as AuthUserProfile;
      setSession({ ...sessionFromLogin(result), user: profile });
      setAuthOpen(false);
      return profile;
    },
    [api, setSession],
  );

  const register = useCallback(
    async (input: AuthInput) => {
      const result = await api.auth.register({
        tenantId: input.tenantId,
        username: input.username,
        password: input.password,
        displayName: input.displayName,
      });
      const profile = (result.user ?? (await api.auth.me())) as AuthUserProfile;
      setSession({ ...sessionFromLogin(result), user: profile });
      setAuthOpen(false);
      return profile;
    },
    [api, setSession],
  );

  const logout = useCallback(() => {
    setSession(null);
    router.replace('/');
  }, [router, setSession]);

  const openAuth = useCallback((reason?: string) => {
    if (reason) {
      setAuthReason(reason);
    }
    setAuthOpen(true);
  }, []);

  const ensureSignedIn = useCallback(
    (reason?: string) => {
      if (sessionRef.current?.accessToken) {
        return true;
      }
      openAuth(reason ?? '登录后即可开始提问');
      return false;
    },
    [openAuth],
  );

  const value = useMemo<PortalAuthValue>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      signedIn: Boolean(session?.accessToken),
      api,
      login,
      register,
      logout,
      ensureSignedIn,
      openAuth,
    }),
    [api, ensureSignedIn, login, logout, openAuth, ready, register, session],
  );

  return (
    <AuthContext.Provider value={value}>
      <KhThemeProvider>
        {children}
        <AuthModal open={authOpen} reason={authReason} onClose={() => setAuthOpen(false)} />
      </KhThemeProvider>
    </AuthContext.Provider>
  );
}

export function PortalQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
