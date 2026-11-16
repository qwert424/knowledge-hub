import type { ApiClient } from '../http';
import type { CreateDatasourceRequest, DatasourceView, SyncRun } from '../types';

export function createDatasourceApi(client: ApiClient) {
  return {
    list: () => client.request<DatasourceView[]>('/api/v1/datasources'),
    create: (body: CreateDatasourceRequest) =>
      client.request<DatasourceView>('/api/v1/datasources', { method: 'POST', body }),
    test: (id: string) =>
      client.request<{ result: string }>(`/api/v1/datasources/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        timeoutMs: 60_000,
      }),
    sync: (id: string) =>
      client.request<{ syncRunId: string }>(`/api/v1/datasources/${encodeURIComponent(id)}/sync`, {
        method: 'POST',
      }),
    runs: (id: string) => client.request<SyncRun[]>(`/api/v1/datasources/${encodeURIComponent(id)}/runs`),
  };
}

export type DatasourceApi = ReturnType<typeof createDatasourceApi>;
