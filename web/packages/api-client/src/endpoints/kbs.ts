import type { ApiClient } from '../http';
import type {
  CreateKbRequest,
  KbListQuery,
  KbMemberRequest,
  KbStats,
  KbView,
  PageResult,
  UpdateKbRequest,
} from '../types';

export function createKbApi(client: ApiClient) {
  return {
    list: (query: KbListQuery = {}) =>
      client.request<PageResult<KbView>>('/api/v1/kbs', {
        query: { keyword: query.keyword, page: query.page ?? 1, pageSize: query.pageSize ?? 20 },
      }),
    get: (id: string) => client.request<KbView>(`/api/v1/kbs/${encodeURIComponent(id)}`),
    /** 用户端可选库：后端已按"启用 + 我有权限"过滤，前端不再自己筛 */
    available: () => client.request<KbView[]>('/api/v1/kbs/available'),
    create: (body: CreateKbRequest) => client.request<KbView>('/api/v1/kbs', { method: 'POST', body }),
    update: (id: string, body: UpdateKbRequest) =>
      client.request<KbView>(`/api/v1/kbs/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    remove: (id: string) =>
      client.request<void>(`/api/v1/kbs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 回收站：被软删除的知识库 */
    listDeleted: () => client.request<KbView[]>('/api/v1/kbs/deleted'),
    restore: (id: string) =>
      client.request<KbView>(`/api/v1/kbs/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
    /** 彻底删除回收站里的库（不可恢复） */
    purge: (id: string) =>
      client.request<void>(`/api/v1/kbs/${encodeURIComponent(id)}/purge`, { method: 'DELETE' }),
    /** 清空回收站：有文档的库会被跳过 */
    purgeAll: () =>
      client.request<{ purged: number; skipped: string[] }>('/api/v1/kbs/deleted', { method: 'DELETE' }),
    /** 上架/下架：下架后用户端不再检索这个库 */
    updateStatus: (id: string, status: 'active' | 'disabled') =>
      client.request<KbView>(`/api/v1/kbs/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: { status },
      }),
    listMembers: (id: string) =>
      client.request<KbMemberView[]>(`/api/v1/kbs/${encodeURIComponent(id)}/members`),
    removeMember: (id: string, memberId: string) =>
      client.request<void>(
        `/api/v1/kbs/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`,
        { method: 'DELETE' },
      ),
    addMember: (id: string, body: KbMemberRequest) =>
      client.request<void>(`/api/v1/kbs/${encodeURIComponent(id)}/members`, { method: 'POST', body }),
    stats: (id: string) => client.request<KbStats>(`/api/v1/kbs/${encodeURIComponent(id)}/stats`),
  };
}

export type KbApi = ReturnType<typeof createKbApi>;

export interface KbMemberView {
  id: string;
  principalType: string;
  principalId: string;
  permission: string;
  createdAt?: string;
}
