import type { ApiClient } from '../http';
import type { IndexJobListQuery, IndexJobView, PageResult } from '../types';

export function createIndexJobApi(client: ApiClient) {
  return {
    list: (query: IndexJobListQuery = {}) =>
      client.request<PageResult<IndexJobView>>('/api/v1/index-jobs', {
        query: {
          status: query.status,
          documentId: query.documentId,
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 20,
        },
      }),
    get: (id: string) => client.request<IndexJobView>(`/api/v1/index-jobs/${encodeURIComponent(id)}`),
    retry: (id: string) =>
      client.request<void>(`/api/v1/index-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    remove: (id: string) =>
      client.request<void>(`/api/v1/index-jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    batchCancel: (ids: string[]) =>
      client.request<{ canceled: number }>('/api/v1/index-jobs/batch-cancel', { method: 'POST', body: { ids } }),
    batchRemove: (ids: string[]) =>
      client.request<{ deleted: number }>('/api/v1/index-jobs/batch-delete', { method: 'POST', body: { ids } }),
    cancel: (id: string) =>
      client.request<void>(`/api/v1/index-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  };
}

export type IndexJobApi = ReturnType<typeof createIndexJobApi>;
