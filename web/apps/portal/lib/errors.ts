import { ApiError } from '@kh/api-client';

/**
 * 把内部错误码翻译成用户能看懂的话。
 *
 * 用户端不该出现 RETRIEVAL_TIMEOUT、ECONNREFUSED、TypeError 这类东西；
 * 认不出来的错误统一给一句可操作的提示，原始信息只留在控制台。
 */
const MESSAGES: Record<string, string> = {
  AUTH_401: '登录已过期，请重新登录',
  AUTH_403: '没有权限执行这个操作',
  BAD_REQUEST: '请求参数有误，请调整后重试',
  QUOTA_EXCEEDED: '本月额度已用完，请联系管理员',
  RETRIEVAL_TIMEOUT: '查找资料超时了，请重新提问',
  RETRIEVAL_UNAVAILABLE: '知识库暂时不可用，请稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂时不可用，请稍后重试',
  ENGINE_UNAVAILABLE: '回答服务暂时不可用，请稍后重试',
  ABORTED: '已停止生成',
  INTERNAL_ERROR: '服务出了点问题，请稍后重试',
  NETWORK_ERROR: '网络不稳定，请检查连接后重试',
};

export function friendlyError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError) {
    const mapped = MESSAGES[error.code];
    // 后端给了具体中文原因时优先用它（例如"知识库已停用，请换一个库"），
    // 这类提示比通用文案更能指导用户下一步。
    const backendText = unwrapEnvelopeText(error.message);
    if (backendText) {
      return backendText;
    }
    if (mapped) {
      return mapped;
    }
    return fallback;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return MESSAGES.ABORTED;
    }
    const text = unwrapEnvelopeText(error.message);
    if (text) {
      return text;
    }
  }
  return fallback;
}

/**
 * 有些错误路径会把整个响应体塞进 message（例如 `{"code":"BAD_REQUEST","message":"…"}`），
 * 直接展示给用户很难看：这里把包裹拆掉，只留里面的中文原因。
 */
function unwrapEnvelopeText(raw?: string): string | null {
  const text = (raw ?? '').trim();
  if (!text) {
    return null;
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown; code?: unknown };
      const inner = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (inner && /[\u4e00-\u9fa5]/.test(inner)) {
        return inner;
      }
      return null;
    } catch {
      return null;
    }
  }
  return /[\u4e00-\u9fa5]/.test(text) ? text : null;
}
