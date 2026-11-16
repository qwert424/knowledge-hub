import type { AuthUserProfile, LoginResult } from './types';

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  user?: AuthUserProfile;
  expiresAt?: number;
}

/**
 * 存储抽象：Admin 用 localStorage，Portal 用内存（+ cookie 镜像）。
 * 不引入任何框架依赖，便于 SSR 场景注入。
 */
export interface SessionStorage {
  read(): StoredSession | null;
  write(session: StoredSession | null): void;
}

export const SESSION_STORAGE_KEY = 'kh.session';

export function sessionFromLogin(result: LoginResult): StoredSession {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    user: result.user,
    expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
  };
}

export function createLocalStorageSession(key: string = SESSION_STORAGE_KEY): SessionStorage {
  const safeRead = (): StoredSession | null => {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null;
    }
  };
  return {
    read: safeRead,
    write: (session) => {
      if (typeof window === 'undefined') {
        return;
      }
      if (!session) {
        window.localStorage.removeItem(key);
        return;
      }
      window.localStorage.setItem(key, JSON.stringify(session));
    },
  };
}

export function createMemorySession(initial: StoredSession | null = null): SessionStorage {
  let current = initial;
  return {
    read: () => current,
    write: (session) => {
      current = session;
    },
  };
}
