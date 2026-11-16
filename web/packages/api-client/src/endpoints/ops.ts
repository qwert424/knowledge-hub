import type { ApiClient } from '../http';
import type {
  AuditLogQuery,
  AuditLogRow,
  MetricsOverview,
  MetricsTrends,
  NotificationFeed,
  PageResult,
} from '../types';

export function createOpsApi(client: ApiClient) {
  return {
    auditLogs: (query: AuditLogQuery = {}) =>
      client.request<PageResult<AuditLogRow>>('/api/v1/audit-logs', {
        query: {
          action: query.action,
          actorName: query.actorName,
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 20,
        },
      }),
    overview: () => client.request<MetricsOverview>('/api/v1/metrics/overview'),
    /** 近 N 天趋势：概览页折线图数据源 */
    trends: (days = 7) => client.request<MetricsTrends>('/api/v1/metrics/trends', { query: { days } }),
    /** 通知中心：索引失败 / 审计失败等真实运维事件 */
    notifications: (days = 7) =>
      client.request<NotificationFeed>('/api/v1/notifications', { query: { days } }),
    /** 数据保留策略（审计 180 天 / 对话 90 天，cron 到点自动清理） */
    retentionPolicies: () => client.request<RetentionPolicyRow[]>('/api/v1/retention-policies'),
    updateRetention: (
      id: string,
      body: { retentionDays?: number; cron?: string; enabled?: boolean },
    ) =>
      client.request<RetentionPolicyRow>(`/api/v1/retention-policies/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body,
      }),
    runRetention: (id: string) =>
      client.request<RetentionPolicyRow>(
        `/api/v1/retention-policies/${encodeURIComponent(id)}/run`,
        { method: 'POST', timeoutMs: 120_000 },
      ),
  };
}

export interface RetentionPolicyRow {
  id: string;
  name: string;
  target: string;
  retentionDays: number;
  enabled: boolean;
  cron: string;
  lastRunAt?: string | null;
  lastDeleted?: number | null;
  lastStatus?: string | null;
  lastMessage?: string | null;
  updatedAt?: string | null;
}

export type OpsApi = ReturnType<typeof createOpsApi>;
