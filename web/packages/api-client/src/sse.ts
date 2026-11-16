import { ApiError, toApiError } from './http';
import type { ChatCitation, ChatStreamEvent, ChatUsage } from './types';

export interface RawSseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * 逐行解析 SSE 响应体。`EventSource` 无法 POST，因此这里手工读流。
 * 单条事件以空行分隔；`data:` 多行按规范用 `\n` 连接。
 */
export async function* iterateSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<RawSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new ApiError({ code: 'ABORTED', message: '生成已停止' });
      }
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      let boundary = findBoundary(buffer);
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^(\r?\n){2}/, '');
        const parsed = parseEventChunk(chunk);
        if (parsed) {
          yield parsed;
        }
        boundary = findBoundary(buffer);
      }
      if (done) {
        buffer += decoder.decode();
        const parsed = parseEventChunk(buffer);
        if (parsed) {
          yield parsed;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) {
    return crlf;
  }
  if (crlf < 0) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function parseEventChunk(chunk: string): RawSseEvent | null {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return null;
  }
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        event = value || 'message';
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      default:
        break;
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join('\n'), id };
}

/** 引擎事件为 snake_case，Java 补发事件为 camelCase，这里统一成前端模型 */
export function normalizeCitation(raw: Record<string, unknown>): ChatCitation {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  };
  const score = raw.score;
  const index = raw.index;
  return {
    chunkId: pick('chunkId', 'chunk_id'),
    docId: pick('docId', 'doc_id'),
    title: pick('title', 'doc_title'),
    url: pick('url', 'source_url'),
    snippet: pick('snippet', 'text'),
    score: typeof score === 'number' ? score : undefined,
    index: typeof index === 'number' ? index : undefined,
  };
}

/** 把原始 SSE 事件映射为强类型事件 */
export function toChatStreamEvent(raw: RawSseEvent): ChatStreamEvent | null {
  const parsed = safeJson(raw.data);
  switch (raw.event) {
    case 'start': {
      const record = asRecord(parsed);
      return { event: 'start', data: { messageId: asString(record?.messageId ?? record?.message_id) } };
    }
    case 'status': {
      const record = asRecord(parsed);
      return {
        event: 'status',
        data: {
          stage: asString(record?.stage),
          detail: asString(record?.detail),
        },
      };
    }
    case 'notice': {
      const record = asRecord(parsed);
      return {
        event: 'notice',
        data: {
          level: asString(record?.level) ?? 'info',
          message: asString(record?.message) ?? '',
        },
      };
    }
    case 'token': {
      const record = asRecord(parsed);
      const delta = asString(record?.delta) ?? '';
      return { event: 'token', data: { delta } };
    }
    case 'citation': {
      const record = asRecord(parsed) ?? {};
      return { event: 'citation', data: normalizeCitation(record) };
    }
    case 'error': {
      const record = asRecord(parsed) ?? {};
      return {
        event: 'error',
        data: {
          code: asString(record.code) ?? 'INTERNAL_ERROR',
          message: asString(record.message) ?? '生成失败',
          retryable: typeof record.retryable === 'boolean' ? record.retryable : undefined,
        },
      };
    }
    case 'done': {
      const record = asRecord(parsed) ?? {};
      return {
        event: 'done',
        data: {
          messageId: asString(record.messageId ?? record.message_id),
          citationCount: typeof record.citationCount === 'number' ? record.citationCount : undefined,
          usage: asRecord(record.usage) as ChatUsage | undefined,
        },
      };
    }
    case 'heartbeat':
    case 'ping':
      return null;
    default:
      return { event: 'unknown', data: parsed };
  }
}

function safeJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * POST + 读流：返回 `done` 事件后结束；`error` 事件以抛错形式交给调用方。
 * 取消能力由传入的 AbortSignal（AbortController.signal）提供。
 */
export async function consumeChatStream(
  response: Response,
  handlers: {
    onEvent: (event: ChatStreamEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!response.body) {
    throw new ApiError({ code: 'BAD_RESPONSE', message: '服务端未返回可读流' });
  }
  try {
    for await (const raw of iterateSse(response.body, handlers.signal)) {
      const event = toChatStreamEvent(raw);
      if (!event) {
        continue;
      }
      handlers.onEvent(event);
      if (event.event === 'done') {
        return;
      }
      if (event.event === 'error') {
        throw new ApiError({ code: event.data.code, message: event.data.message });
      }
    }
  } catch (error) {
    throw toApiError(error);
  }
}
