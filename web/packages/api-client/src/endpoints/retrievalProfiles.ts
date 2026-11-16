import type { ApiClient } from '../http';
import type {
  CreateProfileRequest,
  ProfileTestRequest,
  RetrievalProfileView,
  RetrievalTestResult,
  RetrievalTraceView,
  UpdateProfileRequest,
} from '../types';

export function createRetrievalProfileApi(client: ApiClient) {
  return {
    list: () => client.request<RetrievalProfileView[]>('/api/v1/retrieval-profiles'),
    create: (body: CreateProfileRequest) =>
      client.request<RetrievalProfileView>('/api/v1/retrieval-profiles', { method: 'POST', body }),
    update: (id: string, body: UpdateProfileRequest) =>
      client.request<RetrievalProfileView>(`/api/v1/retrieval-profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body,
      }),
    publish: (id: string) =>
      client.request<RetrievalProfileView>(`/api/v1/retrieval-profiles/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
      }),
    /** 停用策略（至少要保留一条已发布策略） */
    disable: (id: string) =>
      client.request<RetrievalProfileView>(`/api/v1/retrieval-profiles/${encodeURIComponent(id)}/disable`, {
        method: 'POST',
      }),
    /** 删除 = 进回收站（软删除），已发布的策略要先停用 */
    softDelete: (id: string) =>
      client.request<RetrievalProfileView>(`/api/v1/retrieval-profiles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    listDeleted: () => client.request<RetrievalProfileView[]>('/api/v1/retrieval-profiles/deleted'),
    restore: (id: string) =>
      client.request<RetrievalProfileView>(
        `/api/v1/retrieval-profiles/${encodeURIComponent(id)}/restore`,
        { method: 'POST' },
      ),
    purge: (id: string) =>
      client.request<{ id: string; purged: boolean }>(
        `/api/v1/retrieval-profiles/${encodeURIComponent(id)}/purge`,
        { method: 'DELETE' },
      ),
    purgeAllDeleted: () =>
      client.request<{ purged: number }>('/api/v1/retrieval-profiles/deleted', { method: 'DELETE' }),
    /** 调试记录清理：单条或批量 */
    deleteTraces: (ids: string[]) =>
      client.request<{ deleted: number }>('/api/v1/retrieval-profiles/traces', {
        method: 'DELETE',
        body: { ids },
      }),
    /** 调试台：走真实检索链路，返回召回与耗时埋点 */
    test: (id: string, body: ProfileTestRequest) =>
      client.request<RetrievalTestResult>(
        `/api/v1/retrieval-profiles/${encodeURIComponent(id)}/test`,
        { method: 'POST', body, timeoutMs: 60_000 },
      ),
    traces: (limit = 20) =>
      client.request<RetrievalTraceView[]>('/api/v1/retrieval-profiles/traces', { query: { limit } }),
  };
}

export type RetrievalProfileApi = ReturnType<typeof createRetrievalProfileApi>;
