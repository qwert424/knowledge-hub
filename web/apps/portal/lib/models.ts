/** 网关别名 -> 用户能看懂的名字；未知模型原样展示，不做猜测。 */
const MODEL_LABELS: Record<string, string> = {
  'chat-standard': '标准模型',
  'chat-basic': '轻量模型',
  'chat-standard-backup': '标准模型（备用）',
  'chat-basic-backup': '轻量模型（备用）',
  'jev-basic': '决策模型',
};

/** 系统默认模型：优先 chat-standard，否则取网关第一个对话模型 */
export function defaultModelOf(models: Array<{ id: string; mode?: string }>): string {
  const chat = models.filter((model) => !model.mode || model.mode === 'chat');
  const preferred = chat.find((model) => /^chat-standard$/i.test(model.id));
  return preferred?.id ?? chat[0]?.id ?? '';
}

export function modelLabelOf(id?: string | null, defaultModel?: string): string {
  if (!id) {
    // 用户没显式选模型时就写「系统默认」，不再暴露后端别名：
    // 参数细节对提问的人没有意义，反而让人以为选了某个具体模型。
    return '系统默认';
  }
  const friendly = MODEL_LABELS[id];
  return friendly ? `${friendly} · ${id}` : id;
}

/** 消息尾部只显示短名，完整别名放在 tooltip 里。 */
export function modelShortLabel(id?: string | null): string {
  if (!id) {
    return '';
  }
  return MODEL_LABELS[id] ?? id;
}
