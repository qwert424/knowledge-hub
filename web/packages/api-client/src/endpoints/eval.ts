import type { ApiClient } from '../http';
import type {
  CreateEvalCaseRequest,
  CreateEvalDatasetRequest,
  CreateEvalRunRequest,
  EvalCase,
  EvalDataset,
  EvalRun,
} from '../types';

/**
 * 评测接口契约（platform-eval `EvalController`）：
 * 列表直接返回数组（非分页），新建用例是批量语义并只返回 `{added}`。
 */
export function createEvalApi(client: ApiClient) {
  return {
    listDatasets: () => client.request<EvalDataset[]>('/api/v1/eval/datasets'),
    createDataset: (body: CreateEvalDatasetRequest) =>
      client.request<EvalDataset>('/api/v1/eval/datasets', { method: 'POST', body }),
    listCases: (datasetId: string) =>
      client.request<EvalCase[]>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/cases`),
    addCases: (datasetId: string, cases: CreateEvalCaseRequest[]) =>
      client.request<{ added: number }>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/cases`, {
        method: 'POST',
        body: cases,
      }),
    /** 修改一条用例（问题 / 期望答案 / 期望文档） */
    updateCase: (datasetId: string, caseId: string, body: CreateEvalCaseRequest) =>
      client.request<void>(
        `/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/cases/${encodeURIComponent(caseId)}`,
        { method: 'PUT', body },
      ),
    deleteCase: (datasetId: string, caseId: string) =>
      client.request<void>(
        `/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/cases/${encodeURIComponent(caseId)}`,
        { method: 'DELETE' },
      ),
    /** 取消一次评测（排队中的直接取消，执行中的会在下一个用例前停止） */
    cancelRun: (runId: string) =>
      client.request<void>(`/api/v1/eval/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
    /** 删除一条运行记录（只是评测结果，不动数据集与用例） */
    deleteRun: (runId: string) =>
      client.request<void>(`/api/v1/eval/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
    /** 删除数据集（连带用例与运行记录） */
    deleteDataset: (datasetId: string) =>
      client.request<void>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}`, { method: 'DELETE' }),
    listRuns: () => client.request<EvalRun[]>('/api/v1/eval/runs'),
    createRun: (body: CreateEvalRunRequest) =>
      client.request<{ runIds: string[] }>('/api/v1/eval/runs', { method: 'POST', body }),
    /** 回收站：被软删的数据集与运行记录 */
    trash: () =>
      client.request<{ datasets: EvalTrashDataset[]; runs: EvalTrashRun[] }>('/api/v1/eval/trash'),
    restoreDataset: (datasetId: string) =>
      client.request<void>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/restore`, {
        method: 'POST',
      }),
    purgeDataset: (datasetId: string) =>
      client.request<void>(`/api/v1/eval/datasets/${encodeURIComponent(datasetId)}/purge`, {
        method: 'DELETE',
      }),
    restoreRun: (runId: string) =>
      client.request<void>(`/api/v1/eval/runs/${encodeURIComponent(runId)}/restore`, { method: 'POST' }),
    purgeRun: (runId: string) =>
      client.request<void>(`/api/v1/eval/runs/${encodeURIComponent(runId)}/purge`, { method: 'DELETE' }),
    purgeTrash: () => client.request<{ purged: number }>('/api/v1/eval/trash', { method: 'DELETE' }),
  };
}

export interface EvalTrashDataset {
  id: string;
  name: string;
  deletedAt: string;
}

export interface EvalTrashRun {
  id: string;
  datasetId: string;
  status: string;
  deletedAt: string;
}

export type EvalApi = ReturnType<typeof createEvalApi>;
