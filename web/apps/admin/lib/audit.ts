/**
 * 审计码 -> 人话。
 *
 * 后端写的是 `eval.dataset.delete` 这样的点分码，直接铺在界面上没人看得懂，
 * 这里拆成「动作动词 + 业务对象」，未知码退回原始码，不隐藏信息。
 */
interface ActionMeta {
  verb: string;
  /** 业务对象，用于「对什么做了什么」的叙述 */
  scope: string;
  color: string;
}

const ACTIONS: Record<string, ActionMeta> = {
  'auth.login': { verb: '登录', scope: '账号', color: 'green' },
  'auth.register': { verb: '注册', scope: '账号', color: 'green' },

  'kb.create': { verb: '新建', scope: '知识库', color: 'blue' },
  'kb.update': { verb: '修改', scope: '知识库', color: 'blue' },
  'kb.enable': { verb: '上架', scope: '知识库', color: 'green' },
  'kb.disable': { verb: '下架', scope: '知识库', color: 'orange' },
  'kb.delete': { verb: '移入回收站', scope: '知识库', color: 'red' },
  'kb.restore': { verb: '从回收站恢复', scope: '知识库', color: 'green' },
  'kb.purge': { verb: '彻底删除', scope: '知识库', color: 'red' },
  'kb.member.add': { verb: '新增授权', scope: '知识库成员', color: 'geekblue' },
  'kb.member.remove': { verb: '取消授权', scope: '知识库成员', color: 'volcano' },
  'kb.acl.update': { verb: '修改可见范围', scope: '知识库', color: 'purple' },
  'document.acl.update': { verb: '修改可见范围', scope: '文档', color: 'purple' },

  'doc.uploadIntent': { verb: '申请上传', scope: '文档', color: 'blue' },
  'doc.commit': { verb: '确认上传', scope: '文档', color: 'blue' },
  'doc.importFeishu': { verb: '从飞书导入', scope: '文档', color: 'blue' },
  'doc.move': { verb: '转移知识库', scope: '文档', color: 'geekblue' },
  'doc.reindex': { verb: '重建索引', scope: '文档', color: 'geekblue' },
  'doc.delete': { verb: '删除', scope: '文档', color: 'red' },
  'doc.updateTags': { verb: '修改标签', scope: '文档', color: 'purple' },
  'doc.graph.select': { verb: '标记精选', scope: '文档', color: 'gold' },
  'doc.graph.unselect': { verb: '取消精选', scope: '文档', color: 'gold' },

  'index.retry': { verb: '重试', scope: '索引任务', color: 'geekblue' },
  'index.cancel': { verb: '取消', scope: '索引任务', color: 'orange' },
  'index.delete': { verb: '删除', scope: '索引任务', color: 'red' },
  'index.batch.cancel': { verb: '批量取消', scope: '索引任务', color: 'orange' },
  'index.batch.delete': { verb: '批量删除', scope: '索引任务', color: 'red' },
  'index.complete': { verb: '完成', scope: '索引任务', color: 'green' },
  'index.fail': { verb: '失败', scope: '索引任务', color: 'red' },

  'profile.create': { verb: '新建', scope: '检索策略', color: 'blue' },
  'profile.update': { verb: '修改', scope: '检索策略', color: 'blue' },
  'profile.publish': { verb: '发布', scope: '检索策略', color: 'green' },
  'profile.disable': { verb: '停用', scope: '检索策略', color: 'orange' },
  'profile.delete': { verb: '移入回收站', scope: '检索策略', color: 'red' },
  'profile.restore': { verb: '从回收站恢复', scope: '检索策略', color: 'green' },
  'profile.purge': { verb: '彻底删除', scope: '检索策略', color: 'red' },
  'profile.trace.delete': { verb: '清理调试记录', scope: '检索策略', color: 'orange' },

  'graph.select': { verb: '选入图谱', scope: '文档', color: 'gold' },
  'graph.unselect': { verb: '取消精选', scope: '文档', color: 'gold' },
  'graph.build': { verb: '构建图谱', scope: '知识库', color: 'gold' },

  'datasource.create': { verb: '新建', scope: '数据源', color: 'blue' },
  'datasource.sync': { verb: '同步', scope: '数据源', color: 'geekblue' },

  'iam.user.create': { verb: '新建', scope: '用户', color: 'blue' },
  'iam.user.update': { verb: '修改', scope: '用户', color: 'blue' },
  'iam.user.assignRoles': { verb: '分配角色', scope: '用户', color: 'purple' },
  'iam.user.changePassword': { verb: '修改密码', scope: '用户', color: 'orange' },
  'iam.role.create': { verb: '新建', scope: '角色', color: 'blue' },

  'eval.dataset.create': { verb: '新建', scope: '评测数据集', color: 'blue' },
  'eval.dataset.delete': { verb: '删除', scope: '评测数据集', color: 'red' },
  'eval.run.create': { verb: '发起', scope: '评测运行', color: 'blue' },
  'eval.run.cancel': { verb: '取消', scope: '评测运行', color: 'orange' },
  'eval.run.delete': { verb: '删除', scope: '评测运行', color: 'red' },
};

const RESOURCES: Record<string, string> = {  kb: '知识库',
  document: '文档',
  index_job: '索引任务',
  retrieval_profile: '检索策略',
  datasource: '数据源',
  user: '用户',
  role: '角色',
  eval_dataset: '评测数据集',
  eval_run: '评测运行',
};

export interface ActionLabel {
  /** 动词，如「删除」 */
  verb: string;
  /** 业务对象，如「评测数据集」 */
  scope: string;
  color: string;
  known: boolean;
}

/** 筛选下拉：直接用映射过的动作码，避免管理员记英文码 */
export const AUDIT_ACTION_OPTIONS = Object.entries(ACTIONS).map(([code, meta]) => ({
  value: code,
  label: `${meta.verb} · ${meta.scope}（${code}）`,
}));

export function actionLabelOf(code?: string | null): ActionLabel {
  const value = (code ?? '').trim();
  const hit = ACTIONS[value];
  if (hit) {
    return { ...hit, known: true };
  }
  // 未知码（新加的动作还没映射）：保留原始码，不假装认识
  return { verb: value || '未知操作', scope: '', color: 'default', known: false };
}

export function resourceLabelOf(type?: string | null): string {
  const value = (type ?? '').trim();
  if (!value) {
    return '未标注资源';
  }
  return RESOURCES[value] ?? value;
}

/** 「删除 · 评测数据集」：一句话说清对什么做了什么 */
export function actionSentence(code?: string | null, resourceType?: string | null): string {
  const label = actionLabelOf(code);
  if (label.scope) {
    return `${label.verb} · ${label.scope}`;
  }
  return `${label.verb} · ${resourceLabelOf(resourceType)}`;
}

/** 变更前后的原始值可能是 JSON、数字、逗号列表，统一压成一行预览 */
export function previewValue(value?: string | null, max = 120): string {
  const text = (value ?? '').trim();
  if (!text) {
    return '';
  }
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* ------------------------------------------------------------------ 变更对比 */

const PRINCIPAL_LABELS: Record<string, string> = {
  user: '用户',
  role: '角色',
  group: '角色组',
  'role-group': '角色组',
  team: '团队',
  dept: '部门',
};

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** 把裸 UUID 换成「名称（id 前 8 位）」，没查到名字就保留原值 */
export function substituteIds(raw?: string | null, labels?: Map<string, string>): string {
  const text = (raw ?? '').trim();
  if (!text || !labels || labels.size === 0) {
    return text;
  }
  return text.replace(UUID_RE, (id) => {
    const label = labels.get(id.toLowerCase());
    return label ? `${label}（${id.slice(0, 8)}）` : id;
  });
}

/** `user:<uuid>` 这种主体标识翻成「用户 · 张三」，光看 type:id 没人知道加了谁 */
function humanizePrincipal(value: string, labels?: Map<string, string>): string {
  const match = /^([a-z-]+):(.+)$/i.exec(value.trim());
  if (!match) {
    return substituteIds(value, labels);
  }
  const kind = PRINCIPAL_LABELS[match[1].toLowerCase()];
  if (!kind) {
    return substituteIds(value, labels);
  }
  const id = match[2].trim();
  const name = labels?.get(id.toLowerCase());
  return `${kind} · ${name ?? (id.length > 8 ? `${id.slice(0, 8)}…` : id)}`;
}

function flattenValue(value: unknown, labels?: Map<string, string>): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return humanizePrincipal(value, labels);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return substituteIds(JSON.stringify(value), labels);
}

export interface ChangeEntry {
  /** 字段名；标量差值时为空字符串，表示「就是这条记录的值」 */
  field: string;
  before: string;
  after: string;
}

/**
 * 审计的 before / after 常常是裸字符串或裸 UUID，直接铺在界面上看不出改了什么。
 * 这里解析成「字段 → 变更前 / 变更后」的对照，前端照着渲染成表格即可。
 */
export function describeChange(
  before?: string | null,
  after?: string | null,
  labels?: Map<string, string>,
): ChangeEntry[] {
  const parse = (raw?: string | null): { scalar?: string; record?: Record<string, unknown> } => {
    const text = (raw ?? '').trim();
    if (!text) {
      return {};
    }
    if (text.startsWith('{') && text.endsWith('}')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { record: parsed };
        }
      } catch {
        // 不是合法 JSON 就按标量处理
      }
    }
    return { scalar: text };
  };

  const left = parse(before);
  const right = parse(after);
  if (!left.record && !right.record) {
    return [{ field: '', before: flattenValue(left.scalar, labels), after: flattenValue(right.scalar, labels) }];
  }
  const keys = Array.from(
    new Set([...Object.keys(left.record ?? {}), ...Object.keys(right.record ?? {})]),
  );
  return keys.map((key) => ({
    field: key,
    before: flattenValue(left.record?.[key], labels),
    after: flattenValue(right.record?.[key], labels),
  }));
}
