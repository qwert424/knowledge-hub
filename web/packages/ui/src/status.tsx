'use client';

import { Tag } from 'antd';
import type { ReactNode } from 'react';

export type StatusTone = 'processing' | 'success' | 'warning' | 'error' | 'default';

export interface StatusMeta {
  text: string;
  tone: StatusTone;
}

const DOCUMENT_STATUS: Record<string, StatusMeta> = {
  uploaded: { text: '待处理', tone: 'default' },
  queued: { text: '排队中', tone: 'default' },
  staging: { text: '暂存中', tone: 'processing' },
  parsing: { text: '解析中', tone: 'processing' },
  normalizing: { text: '归一化中', tone: 'processing' },
  chunking: { text: '切片中', tone: 'processing' },
  enriching: { text: '增强中', tone: 'processing' },
  embedding: { text: '向量化中', tone: 'processing' },
  writing: { text: '写入中', tone: 'processing' },
  reporting: { text: '回写结果', tone: 'processing' },
  graphing: { text: '图谱抽取', tone: 'processing' },
  publishing: { text: '发布中', tone: 'processing' },
  indexing: { text: '索引中', tone: 'processing' },
  published: { text: '已发布', tone: 'success' },
  active: { text: '已上线', tone: 'success' },
  succeeded: { text: '成功', tone: 'success' },
  done: { text: '完成', tone: 'success' },
  failed: { text: '失败', tone: 'error' },
  canceled: { text: '已取消', tone: 'default' },
  offline: { text: '已下线', tone: 'default' },
  superseded: { text: '已被替代', tone: 'default' },
};

const JOB_STATUS: Record<string, StatusMeta> = {
  queued: { text: '排队中', tone: 'default' },
  running: { text: '执行中', tone: 'processing' },
  succeeded: { text: '成功', tone: 'success' },
  failed: { text: '失败', tone: 'error' },
  canceled: { text: '已取消', tone: 'default' },
};

const PROFILE_STATUS: Record<string, StatusMeta> = {
  draft: { text: '草稿', tone: 'warning' },
  published: { text: '已发布', tone: 'success' },
  disabled: { text: '已停用', tone: 'default' },
  archived: { text: '已归档', tone: 'default' },
};

const USER_STATUS: Record<string, StatusMeta> = {
  active: { text: '正常', tone: 'success' },
  disabled: { text: '已禁用', tone: 'error' },
};

const EVAL_STATUS: Record<string, StatusMeta> = {
  pending: { text: '排队中', tone: 'default' },
  queued: { text: '排队中', tone: 'default' },
  running: { text: '执行中', tone: 'processing' },
  succeeded: { text: '完成', tone: 'success' },
  completed: { text: '完成', tone: 'success' },
  failed: { text: '失败', tone: 'error' },
  canceled: { text: '已取消', tone: 'default' },
  cancelled: { text: '已取消', tone: 'default' },
};

/** 知识库上下架：active=已上架可被检索，disabled=已下架（用户端不再检索） */
const KB_STATUS: Record<string, StatusMeta> = {
  active: { text: '已上架', tone: 'success' },
  disabled: { text: '已下架', tone: 'default' },
  draft: { text: '草稿', tone: 'warning' },
};

const HEALTH_STATUS: Record<string, StatusMeta> = {  ok: { text: '正常', tone: 'success' },
  up: { text: '正常', tone: 'success' },
  healthy: { text: '正常', tone: 'success' },
  green: { text: '正常', tone: 'success' },
  degraded: { text: '降级', tone: 'warning' },
  warn: { text: '降级', tone: 'warning' },
  yellow: { text: '降级', tone: 'warning' },
  down: { text: '异常', tone: 'error' },
  fail: { text: '异常', tone: 'error' },
  failed: { text: '异常', tone: 'error' },
  red: { text: '异常', tone: 'error' },
  unknown: { text: '未知', tone: 'default' },
};

const RESULT_STATUS: Record<string, StatusMeta> = {
  SUCCESS: { text: '成功', tone: 'success' },
  FAILED: { text: '失败', tone: 'error' },
};

export type StatusKind = 'document' | 'job' | 'profile' | 'user' | 'eval' | 'health' | 'result' | 'generic' | 'kb';

/** 通用状态：库里很多表都用 active / disabled / draft 这套词，统一给中文，避免界面直接显示英文枚举 */
const GENERIC_STATUS: Record<string, StatusMeta> = {
  active: { text: '正常', tone: 'success' },
  enabled: { text: '已启用', tone: 'success' },
  online: { text: '已上线', tone: 'success' },
  published: { text: '已发布', tone: 'success' },
  draft: { text: '草稿', tone: 'warning' },
  pending: { text: '待处理', tone: 'warning' },
  reviewing: { text: '待审核', tone: 'warning' },
  disabled: { text: '已停用', tone: 'default' },
  inactive: { text: '已停用', tone: 'default' },
  offline: { text: '已下线', tone: 'default' },
  archived: { text: '已归档', tone: 'default' },
  deleted: { text: '已删除', tone: 'default' },
  error: { text: '异常', tone: 'error' },
  failed: { text: '失败', tone: 'error' },
};

const DICTIONARIES: Record<StatusKind, Record<string, StatusMeta>> = {
  document: DOCUMENT_STATUS,
  job: JOB_STATUS,
  profile: PROFILE_STATUS,
  user: USER_STATUS,
  eval: EVAL_STATUS,
  health: HEALTH_STATUS,
  result: RESULT_STATUS,
  generic: GENERIC_STATUS,
  kb: KB_STATUS,
};

export function resolveStatus(kind: StatusKind, status?: string | null): StatusMeta {
  if (!status) {
    return { text: '-', tone: 'default' };
  }
  return DICTIONARIES[kind][status] ?? { text: status, tone: 'default' };
}

/**
 * 状态色板（全站统一）：浅底 + 深字 + 圆点。
 *
 * 之前各页面直接拿 `color="green|blue"` 当状态用，与“分组/标签”这种语义标签混在一起，
 * 深绿/浅绿也很不统一。这里把语义固定下来，以后只改这一处。
 */
const STATUS_STYLE: Record<StatusTone, { bg: string; fg: string; dot: string }> = {
  success: { bg: 'rgba(82, 196, 26, 0.10)', fg: '#237804', dot: '#52c41a' },
  error: { bg: 'rgba(255, 77, 79, 0.10)', fg: '#a8071a', dot: '#ff4d4f' },
  warning: { bg: 'rgba(250, 173, 20, 0.12)', fg: '#ad6800', dot: '#faad14' },
  processing: { bg: 'rgba(22, 119, 255, 0.10)', fg: '#0958d9', dot: '#1677ff' },
  default: { bg: 'rgba(0, 0, 0, 0.04)', fg: 'rgba(0, 0, 0, 0.65)', dot: 'rgba(0, 0, 0, 0.25)' },
};

/** 语义标签（分组、标签、基层数据）：中性灰蓝，不带底色，与状态目标区分 */
export const META_TAG_STYLE = {
  background: 'transparent',
  borderColor: 'rgba(120, 130, 150, 0.35)',
  color: 'rgba(60, 70, 90, 0.85)',
  marginInlineEnd: 0,
} as const;

export interface StatusTagProps {
  kind: StatusKind;
  status?: string | null;
  icon?: ReactNode;
}

/** 状态胶囊：两端共用同一份字典，避免同一状态在管理端/用户端叫法不同 */
export function StatusTag({ kind, status, icon }: StatusTagProps) {
  const meta = resolveStatus(kind, status);
  const style = STATUS_STYLE[meta.tone];
  return (
    <Tag
      icon={icon}
      style={{
        marginInlineEnd: 0,
        background: style.bg,
        border: 'none',
        color: style.fg,
        fontWeight: 500,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: style.dot,
          marginRight: 6,
          verticalAlign: 'middle',
        }}
      />
      {meta.text}
    </Tag>
  );
}

/** 进度条颜色：失败红、成功绿、进行中蓝 */
export function progressStatus(status?: string | null): 'normal' | 'active' | 'success' | 'exception' {
  if (!status) {
    return 'normal';
  }
  if (status === 'failed') {
    return 'exception';
  }
  if (status === 'succeeded' || status === 'active') {
    return 'success';
  }
  if (status === 'running' || status === 'indexing') {
    return 'active';
  }
  return 'normal';
}
