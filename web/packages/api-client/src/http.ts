import type { ApiEnvelope } from './types';

/** 契约错误码（03 §6.5） */
export type ErrorCode =
  | 'AUTH_401'
  | 'AUTH_403'
  | 'TENANT_MISMATCH'
  | 'KB_NOT_FOUND'
  | 'DOC_STATE_INVALID'
  | 'INDEX_ALREADY_RUNNING'
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_LARGE'
  | 'QUOTA_EXCEEDED'
  | 'RETRIEVAL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'
  | 'BAD_RESPONSE';

export const ERROR_CODE_TEXT: Record<string, string> = {
  AUTH_401: '未登录或登录已过期',
  AUTH_403: '没有操作权限',
  TENANT_MISMATCH: '跨租户访问被拒绝',
  KB_NOT_FOUND: '知识库不存在',
  DOC_STATE_INVALID: '文档当前状态不允许该操作',
  INDEX_ALREADY_RUNNING: '已有索引任务在运行',
  UNSUPPORTED_FILE: '不支持的文件类型',
  FILE_TOO_LARGE: '文件超出大小限制',
  QUOTA_EXCEEDED: '配额或频率超限',
  RETRIEVAL_TIMEOUT: '检索超时',
  MODEL_UNAVAILABLE: '模型网关不可用',
  INTERNAL_ERROR: '服务内部错误',
  NETWORK_ERROR: '网络不可达或后端未启动',
  BAD_RESPONSE: '响应格式不符合契约',
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string | null;
  readonly details?: unknown;

  constructor(options: {
    code: string;
    message?: string;
    status?: number;
    requestId?: string | null;
    details?: unknown;
  }) {
    const fallback = ERROR_CODE_TEXT[options.code] ?? '请求失败';
    super(options.message && options.message.length > 0 ? options.message : fallback);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status ?? 0;
    this.requestId = options.requestId ?? null;
    this.details = options.details;
  }

  get isAuthError(): boolean {
    return this.code === 'AUTH_401' || this.status === 401;
  }
}

/** 从任意异常中提取可展示文案 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError({ code: 'ABORTED', message: '请求已取消' });
  }
  if (error instanceof Error) {
    return new ApiError({ code: 'NETWORK_ERROR', message: error.message });
  }
  return new ApiError({ code: 'NETWORK_ERROR' });
}

/**
 * 拆开统一包裹：`code !== "OK"` 抛 `ApiError`。
 * 纯函数，便于在任意上下文复用。
 */
export function unwrap<T>(envelope: ApiEnvelope<T> | null | undefined): T {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.code !== 'string') {
    throw new ApiError({ code: 'BAD_RESPONSE', message: '响应缺少统一包裹结构' });
  }
  if (envelope.code !== 'OK') {
    throw new ApiError({
      code: envelope.code,
      message: envelope.message,
      requestId: envelope.requestId,
      details: envelope.data,
    });
  }
  return envelope.data;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export function buildQuery(params?: QueryParams): string {
  if (!params) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null || raw === undefined || raw === '') {
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

export type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

export interface ApiClientConfig {
  baseUrl?: string;
  /** 每次请求前读取访问令牌 */
  getToken?: TokenProvider;
  /** 401 时尝试刷新一次，返回新的访问令牌（返回空则放弃） */
  refreshToken?: () => Promise<string | null | undefined>;
  /** 刷新失败或未配置时回调（通常用于登出跳转） */
  onUnauthorized?: (error: ApiError) => void;
  /** 额外请求头（租户、追踪等） */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  /** 默认 30s；SSE 走单独的 raw 请求不受此限制 */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: QueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 401 后是否允许刷新重试，默认 true */
  allowRefresh?: boolean;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8088';

export class ApiClient {
  readonly baseUrl: string;
  private readonly config: ApiClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ApiClientConfig = {}) {
    this.config = config;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  url(path: string, query?: QueryParams): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalized}${buildQuery(query)}`;
  }

  /** 发起请求并返回原始 Response（不解析包裹），失败时抛 ApiError */
  async raw(path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await this.send(path, options, true);
    return response;
  }

  /** 发起请求并拆包，`code!=="OK"` 抛 ApiError */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options, false);
    const payload = await this.readEnvelope<T>(response);
    return unwrap<T>(payload);
  }

  private async send(
    path: string,
    options: RequestOptions,
    raw: boolean,
  ): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      const headers: Record<string, string> = { Accept: raw ? 'text/event-stream, application/json' : 'application/json' };
      const token = await this.config.getToken?.();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (this.config.headers) {
        Object.assign(headers, await this.config.headers());
      }
      Object.assign(headers, options.headers ?? {});
      if (options.body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }

      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort);

      try {
        const response = await this.fetchImpl(this.url(path, options.query), {
          method: options.method ?? 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          throw await this.toHttpError(response);
        }
        return response;
      } catch (error) {
        throw toApiError(error);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        options.signal?.removeEventListener('abort', onAbort);
      }
    };

    try {
      return await attempt();
    } catch (error) {
      const apiError = toApiError(error);
      const canRefresh =
        apiError.isAuthError && options.allowRefresh !== false && typeof this.config.refreshToken === 'function';
      if (!canRefresh) {
        if (apiError.isAuthError) {
          this.config.onUnauthorized?.(apiError);
        }
        throw apiError;
      }
      const nextToken = await this.config.refreshToken?.();
      if (!nextToken) {
        this.config.onUnauthorized?.(apiError);
        throw apiError;
      }
      try {
        return await attempt();
      } catch (retryError) {
        const finalError = toApiError(retryError);
        if (finalError.isAuthError) {
          this.config.onUnauthorized?.(finalError);
        }
        throw finalError;
      }
    }
  }

  /** 错误分支：优先读取统一包裹，拿不到就按 HTTP 状态码兜底 */
  private async toHttpError(response: Response): Promise<ApiError> {
    let requestId: string | null = response.headers.get('X-Request-Id');
    let code = statusToCode(response.status);
    let message = ERROR_CODE_TEXT[code] ?? `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text) as Partial<ApiEnvelope<unknown>>;
        if (typeof parsed.code === 'string') {
          code = parsed.code;
        }
        if (typeof parsed.message === 'string' && parsed.message.length > 0) {
          message = parsed.message;
        }
        if (parsed.requestId) {
          requestId = parsed.requestId;
        }
      }
    } catch {
      // 非 JSON 错误体（如网关 HTML），保留状态码文案
    }
    return new ApiError({ code, message, status: response.status, requestId });
  }

  private async readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
    const text = await response.text();
    if (!text) {
      return { code: 'OK', message: 'success', data: undefined as unknown as T };
    }
    try {
      return JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new ApiError({ code: 'BAD_RESPONSE', message: '响应不是合法 JSON', status: response.status });
    }
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'AUTH_401';
    case 403:
      return 'AUTH_403';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'DOC_STATE_INVALID';
    case 413:
      return 'FILE_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_FILE';
    case 429:
      return 'QUOTA_EXCEEDED';
    case 503:
      return 'MODEL_UNAVAILABLE';
    case 504:
      return 'RETRIEVAL_TIMEOUT';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}

export function createApiClient(config: ApiClientConfig = {}): ApiClient {
  return new ApiClient(config);
}
