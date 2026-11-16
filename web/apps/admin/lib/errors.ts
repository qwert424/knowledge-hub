/**
 * 把后端错误翻成管理员能懂的话。
 *
 * 后端 403 会带「缺少权限：kb:write」这类技术码，直接弹出没人看得懂，
 * 这里统一补一句"这个码是干什么的、该找谁要"。
 */

const PERMISSION_HINTS: Record<string, string> = {
  'kb:read': '查看知识库',
  'kb:write': '新建/编辑/删除知识库、管理成员授权',
  'doc:read': '查看文档',
  'doc:write': '上传、编辑、删除文档',
  'index:manage': '触发/取消/删除索引任务',
  'profile:manage': '维护检索策略与平台集成配置',
  'chat:use': '使用对话、查看自己的用量',
  'eval:manage': '评测集、用例与评测运行',
  'graph:manage': '图谱抽取与查询',
  'iam:user:manage': '用户管理',
  'iam:role:manage': '角色与权限分配',
  'ops:audit:read': '审计日志、会话审计',
  'datasource:manage': '数据源管理',
};

export function friendlyAdminError(error: unknown, fallback = '操作失败'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw || fallback;
  const match = message.match(/缺少权限[：:]\s*([a-z:_-]+)/i);
  if (match) {
    const code = match[1];
    const hint = PERMISSION_HINTS[code] ?? '该操作';
    return `当前账号缺少「${code}」（${hint}）权限，需要管理员在「用户与角色」里给对应角色加上这个权限。`;
  }
  return message;
}
