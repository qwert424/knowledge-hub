import type { ApiClient } from '../http';
import type {
  ChunkView,
  CommitDocumentRequest,
  DocumentListQuery,
  DocumentPreviewTarget,
  DocumentTextContent,
  DocumentVersionView,
  DocumentView,
  PageResult,
  ReindexResult,
  UploadIntent,
  UploadIntentRequest,
} from '../types';

export function createDocumentApi(client: ApiClient) {
  return {
    /** 两段式上传第一步：拿 MinIO 预签名 PUT 地址与 documentId */
    uploadIntent: (body: UploadIntentRequest) =>
      client.request<UploadIntent>('/api/v1/documents/upload-intent', { method: 'POST', body }),
    /** 第二步：通知后端上传完成，触发索引 */
    commit: (id: string, body: CommitDocumentRequest = {}) =>
      client.request<DocumentView>(`/api/v1/documents/${encodeURIComponent(id)}/commit`, {
        method: 'POST',
        body,
      }),
    list: (query: DocumentListQuery = {}) =>
      client.request<PageResult<DocumentView>>('/api/v1/documents', {
        query: {
          kbId: query.kbId,
          status: query.status,
          keyword: query.keyword,
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 20,
        },
      }),
    get: (id: string) => client.request<DocumentView>(`/api/v1/documents/${encodeURIComponent(id)}`),
    versions: (id: string) =>
      client.request<DocumentVersionView[]>(`/api/v1/documents/${encodeURIComponent(id)}/versions`),
    chunks: (id: string, query: { versionId?: string; limit?: number } = {}) =>
      client.request<ChunkView[]>(`/api/v1/documents/${encodeURIComponent(id)}/chunks`, {
        query: { versionId: query.versionId, limit: query.limit ?? 200 },
      }),
    /** 原文预签名地址（PDF/图片可新窗口打开，其他类型作为下载链接） */
    previewUrl: (id: string) =>
      client.request<DocumentPreviewTarget>(`/api/v1/documents/${encodeURIComponent(id)}/preview-url`),
    /** Markdown / 纯文本原文，供页面内渲染 */
    textContent: (id: string) =>
      client.request<DocumentTextContent>(`/api/v1/documents/${encodeURIComponent(id)}/content`, {
        timeoutMs: 30_000,
      }),
    blocks: (id: string) =>
      client.request<unknown>(`/api/v1/documents/${encodeURIComponent(id)}/blocks`),
    /** 重索引：内容与切片/向量参数都没变时会自动跳过（force=true 才无条件重建） */
    reindex: (id: string, force = false) =>
      client.request<ReindexResult>(
        `/api/v1/documents/${encodeURIComponent(id)}/reindex${force ? '?force=true' : ''}`,
        { method: 'POST' },
      ),
    remove: (id: string) =>
      client.request<void>(`/api/v1/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 「精选」标记：只有标记的文档才做图谱抽取（人工控制，不随机抽样） */
    setGraphSelection: (id: string, selected: boolean) =>
      client.request<void>(`/api/v1/documents/${encodeURIComponent(id)}/graph-selection`, {
        method: 'PATCH',
        body: { selected },
      }),
    /** 文档标签：写进向量库切片字段，检索时可用于收窄范围（不是 ACL） */
    setTags: (id: string, tags: string[]) =>
      client.request<DocumentView>(`/api/v1/documents/${encodeURIComponent(id)}/tags`, {
        method: 'PATCH',
        body: { tags },
      }),
    /** 转移知识库：换库后自动重建索引（删除知识库前用它把文档挪走） */
    moveToKb: (id: string, kbId: string) =>
      client.request<{ jobId: string }>(`/api/v1/documents/${encodeURIComponent(id)}/kb`, {
        method: 'PATCH',
        body: { kbId },
      }),
    /** 从飞书文档链接直接建档（后端拉 blocks/正文 → 索引） */
    importFeishu: (kbId: string, url: string) =>
      client.request<DocumentView>('/api/v1/documents/import-feishu', {
        method: 'POST',
        body: { kbId, url },
        timeoutMs: 60_000,
      }),
    /** 飞书知识空间（应用身份可访问的），用于浏览式导入 */
    feishuSpaces: () =>
      client.request<{ spaceId: string; name: string; description?: string }[]>(
        '/api/v1/documents/feishu/spaces',
        { timeoutMs: 30_000 },
      ),
    /** 某个知识空间下的一层节点 */
    feishuNodes: (spaceId: string, parentToken?: string) =>
      client.request<
        { nodeToken: string; objToken: string; objType: string; title: string; hasChild: boolean; url: string }[]
      >(`/api/v1/documents/feishu/spaces/${encodeURIComponent(spaceId)}/nodes`, {
        query: { parentToken },
        timeoutMs: 30_000,
      }),
    /** 批量导入：逐条处理，返回每条的成功/失败 */
    importFeishuBatch: (kbId: string, urls: string[]) =>
      client.request<{ url: string; ok: boolean; title?: string; documentId?: string; error?: string }[]>(
        '/api/v1/documents/import-feishu/batch',
        { method: 'POST', body: { kbId, urls }, timeoutMs: 300_000 },
      ),

    /** 直传 MinIO：预签名地址不能带 Authorization，否则签名不匹配 */
    uploadToPresigned: async (intent: UploadIntent, file: Blob, contentType?: string) => {
      const fetcher = globalThis.fetch.bind(globalThis);
      const response = await fetcher(intent.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: contentType ? { 'Content-Type': contentType } : undefined,
      });
      if (!response.ok) {
        throw new Error(`对象存储上传失败（HTTP ${response.status}）`);
      }
    },
  };
}

export type DocumentApi = ReturnType<typeof createDocumentApi>;
