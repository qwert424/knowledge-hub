import type { ApiClient } from '../http';
import { consumeChatStream } from '../sse';
import type {
  ChatQuotaRow,
  ChatStreamEvent,
  ChatUsageQuota,
  ConversationView,
  CreateSessionRequest,
  FeedbackRequest,
  MessageView,
} from '../types';

export interface StreamHandlers {
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

export function createChatApi(client: ApiClient) {
  return {
    listSessions: () => client.request<ConversationView[]>('/api/v1/chat/sessions'),
    createSession: (body: CreateSessionRequest) =>
      client.request<ConversationView>('/api/v1/chat/sessions', { method: 'POST', body }),
    updateSession: (sessionId: string, body: { title?: string; model?: string; kbIds?: string[] }) =>
      client.request<ConversationView>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body,
      }),
    deleteSession: (sessionId: string) =>
      client.request<void>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
    listMessages: (sessionId: string) =>
      client.request<MessageView[]>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`),
    /** 当月用量与配额 */
    usage: () => client.request<ChatUsageQuota>('/api/v1/chat/usage'),
    feedback: (messageId: string, body: FeedbackRequest) =>
      client.request<void>(`/api/v1/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: 'POST',
        body,
      }),

    /** 管理端：查看本租户本月额度配置与用量 */
    quotaOverview: () =>
      client.request<{ period: string; items: ChatQuotaRow[]; unlimitedHint: string }>(
        '/api/v1/admin/chat-quota',
      ),

    /** 用户端空状态推荐问题（管理端可配置） */
    suggestions: () => client.request<{ items: string[] }>('/api/v1/chat/suggestions'),

    /** 管理端：读取/保存用户端推荐问题（空列表 = 恢复默认） */
    portalSettings: () =>
      client.request<{ suggestions: string[]; defaults: string[] }>('/api/v1/admin/portal-settings'),
    savePortalSettings: (suggestions: string[]) =>
      client.request<{ suggestions: string[]; defaults: string[] }>('/api/v1/admin/portal-settings', {
        method: 'PUT',
        body: { suggestions },
      }),
    /** 管理端：设置额度（0 表示不限；subjectType=tenant 时 subjectId 可省略） */
    setQuota: (body: {
      subjectType: 'tenant' | 'user' | 'role' | 'group';
      subjectId?: string;
      limitTokens: number;
      limitRequests: number;
    }) => client.request<{ period: string; items: ChatQuotaRow[] }>('/api/v1/admin/chat-quota', {
      method: 'PUT',
      body,
    }),

    /** 管理端：清除某对象的额度配置（清除后回落到上一层） */
    clearQuota: (params: { subjectType: 'tenant' | 'user' | 'role' | 'group'; subjectId: string }) =>
      client.request<{ period: string; items: ChatQuotaRow[] }>('/api/v1/admin/chat-quota', {
        method: 'DELETE',
        query: params,
      }),

    /**
     * POST 后读取响应体流（EventSource 不支持 POST）。
     * `token` 增量、`citation` 引用、`error` 失败、`done` 结束。
     * `parentMessageId` 给出时表示时间旅行：服务端先截断到该消息再继续。
     */
    streamMessage: async (
      sessionId: string,
      content: string,
      handlers: StreamHandlers,
      parentMessageId?: string | null,
    ): Promise<void> => {
      const response = await client.raw(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: 'POST',
          body: parentMessageId ? { content, parentMessageId } : { content },
          signal: handlers.signal,
          allowRefresh: false,
          timeoutMs: 0,
          headers: { Accept: 'text/event-stream' },
        },
      );
      await consumeChatStream(response, handlers);
    },

    /** 重答某条回答（丢弃它及其后的消息后重新生成） */
    retryMessage: async (sessionId: string, messageId: string, handlers: StreamHandlers): Promise<void> => {
      const response = await client.raw(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/retry`,
        {
          method: 'POST',
          signal: handlers.signal,
          allowRefresh: false,
          timeoutMs: 0,
          headers: { Accept: 'text/event-stream' },
        },
      );
      await consumeChatStream(response, handlers);
    },

    /** 编辑提问并重答（可顺带切换这一条用的模型与检索范围） */
    editMessage: async (
      sessionId: string,
      messageId: string,
      content: string,
      handlers: StreamHandlers,
      options: { model?: string | null; kbIds?: string[] } = {},
    ): Promise<void> => {
      const response = await client.raw(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/edit`,
        {
          method: 'POST',
          body: {
            content,
            ...(options.model !== undefined ? { model: options.model ?? '' } : {}),
            ...(options.kbIds !== undefined ? { kbIds: options.kbIds } : {}),
          },
          signal: handlers.signal,
          allowRefresh: false,
          timeoutMs: 0,
          headers: { Accept: 'text/event-stream' },
        },
      );
      await consumeChatStream(response, handlers);
    },

    /** 断点续传：被中断的回答接着写完（不产生新消息） */
    resumeMessage: async (
      sessionId: string,
      messageId: string,
      handlers: StreamHandlers,
    ): Promise<void> => {
      const response = await client.raw(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/resume`,
        {
          method: 'POST',
          signal: handlers.signal,
          allowRefresh: false,
          timeoutMs: 0,
          headers: { Accept: 'text/event-stream' },
        },
      );
      await consumeChatStream(response, handlers);
    },

    /** 主动停止：把这条回答落成 stopped（可带上已显示的内容，避免库里是空的） */
    stopMessage: (sessionId: string, messageId: string, content?: string) =>
      client.request<void>(
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/stop`,
        { method: 'POST', body: { content: content ?? '' } },
      ),
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
