/**
 * 模型别名 -> 人话。
 *
 * 网关里的别名（chat-basic / chat-standard ...）对管理员也不直观，
 * 统一映射成「用途 · 别名」，用户端与管理端保持同一套说法。
 */
const KNOWN: Array<{ match: RegExp; label: string }> = [
  { match: /^chat-basic$/i, label: '轻量模型' },
  { match: /^chat-standard$/i, label: '标准模型' },
  { match: /^chat-(pro|plus|max)$/i, label: '增强模型' },
  { match: /^chat-/i, label: '对话模型' },
  { match: /embed/i, label: '向量模型' },
  { match: /rerank/i, label: '重排模型' },
  { match: /image|vision|vl/i, label: '图像理解' },
];

export function modelLabelOf(model?: string | null, defaultModel?: string): string {
  const value = (model ?? '').trim();
  // 跟随默认时直接展示默认模型的真实名字，不再套一层"跟随默认（…）"
  const effective = value || defaultModel || '';
  if (!effective) {
    return '跟随默认';
  }
  const hit = KNOWN.find((item) => item.match.test(effective));
  const label = hit ? `${hit.label} · ${effective}` : effective;
  return value ? label : `${label}（默认）`;
}

/** 系统默认模型：优先 chat-standard，否则取网关第一个对话模型 */
export function defaultModelOf(models: Array<{ id: string; mode?: string }>): string {
  const chat = models.filter((model) => !model.mode || model.mode === 'chat');
  const preferred = chat.find((model) => /^chat-standard$/i.test(model.id));
  return preferred?.id ?? chat[0]?.id ?? '';
}
