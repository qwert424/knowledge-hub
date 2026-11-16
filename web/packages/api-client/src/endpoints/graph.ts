import type { ApiClient } from '../http';
import type { GraphDocument, GraphQueryRequest, GraphSelectRequest } from '../types';

export interface GraphQueryResult {
  entities?: Array<Record<string, unknown>>;
  relations?: Array<Record<string, unknown>>;
  communities?: Array<Record<string, unknown>>;
  evidence_chunk_ids?: string[];
  [key: string]: unknown;
}

export function createGraphApi(client: ApiClient) {
  return {
    listDocuments: (kbId?: string) =>
      client.request<GraphDocument[]>('/api/v1/graph/documents', { query: { kbId } }),
    selectDocument: (body: GraphSelectRequest) =>
      client.request<GraphDocument>('/api/v1/graph/documents', { method: 'POST', body }),
    /** 取消精选：不再参与图谱抽取，已抽出的实体保留 */
    unselectDocument: (body: GraphSelectRequest) =>
      client.request<{ unselected: boolean }>('/api/v1/graph/documents', { method: 'DELETE', body }),
    build: (kbId: string, onlyMissing = true) =>
      client.request<{
        documents?: number;
        started?: boolean;
        done?: number;
        cancelled?: number;
        chunks?: number;
        entities?: number;
        relations?: number;
        status?: string;
        reason?: string;
      }>('/api/v1/graph/build', { method: 'POST', body: { kbId, onlyMissing }, timeoutMs: 300_000 }),
    /** 取消抽取：当前文档抽完就停，剩余回到待抽取 */
    cancelBuild: (kbId: string) =>
      client.request<{ kbId: string; cancelling: boolean; reason: string }>(
        '/api/v1/graph/build/cancel',
        { method: 'POST', body: { kbId } },
      ),
    /** 图谱总览：精选/已抽取/失败 文档数与实体、关系总数 */
    summary: (kbId?: string) =>
      client.request<{
        selected: number;
        extracted: number;
        failed: number;
        entities: number;
        relations: number;
      }>('/api/v1/graph/summary', { query: { kbId } }),
    query: (body: GraphQueryRequest) =>
      client.request<GraphQueryResult>('/api/v1/graph/query', {
        method: 'POST',
        body,
        timeoutMs: 60_000,
      }),
    listEntities: (query: { kbId?: string; keyword?: string } = {}) =>
      client.request<Array<Record<string, unknown>>>('/api/v1/graph/entities', {
        query: { kbId: query.kbId, keyword: query.keyword },
      }),
  };
}

export type GraphApi = ReturnType<typeof createGraphApi>;
