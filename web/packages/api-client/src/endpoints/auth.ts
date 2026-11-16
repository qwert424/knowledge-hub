import type { ApiClient } from '../http';
import type {
  AuthUserProfile,
  LoginRequest,
  LoginResult,
  RefreshRequest,
  RegisterRequest,
} from '../types';

export function createAuthApi(client: ApiClient) {
  return {
    login: (body: LoginRequest) => client.request<LoginResult>('/api/v1/auth/login', { method: 'POST', body }),
    register: (body: RegisterRequest) =>
      client.request<LoginResult>('/api/v1/auth/register', { method: 'POST', body }),
    refresh: (body: RefreshRequest) =>
      client.request<LoginResult>('/api/v1/auth/refresh', {
        method: 'POST',
        body,
        allowRefresh: false,
      }),
    me: () => client.request<AuthUserProfile>('/api/v1/auth/me'),
    changePassword: (body: { oldPassword: string; newPassword: string }) =>
      client.request<void>('/api/v1/auth/password', { method: 'POST', body }),
    issueTicket: (kbIds: string[]) =>
      client.request<{ ticket: string }>('/api/v1/auth/ticket', { method: 'POST', body: { kbIds } }),
    /** 登录前需要的租户列表（公开接口，只暴露 id/code/name） */
    tenants: () =>
      client.request<{ items: Array<{ id: string; code: string; name: string }> }>('/api/v1/public/tenants', {
        timeoutMs: 10_000,
      }),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
