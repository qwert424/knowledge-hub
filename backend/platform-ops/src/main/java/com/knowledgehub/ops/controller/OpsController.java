package com.knowledgehub.ops.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.ops.entity.AuditLog;
import com.knowledgehub.ops.entity.RetentionPolicy;
import com.knowledgehub.ops.service.AuditLogService;
import com.knowledgehub.ops.service.RetentionService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class OpsController {

    private final AuditLogService auditLogService;
    private final JdbcTemplate jdbcTemplate;
    private final RetentionService retentionService;

    public OpsController(AuditLogService auditLogService, JdbcTemplate jdbcTemplate,
                         RetentionService retentionService) {
        this.auditLogService = auditLogService;
        this.jdbcTemplate = jdbcTemplate;
        this.retentionService = retentionService;
    }

    // ------------------------------------------------------------ 数据保留（定时清理）
    @GetMapping("/retention-policies")
    @RequirePermission(PermissionCatalog.OPS_AUDIT_READ)
    public ApiResponse<List<RetentionPolicy>> retentionPolicies() {
        return ApiResponse.ok(retentionService.list());
    }

    @PutMapping("/retention-policies/{id}")
    @RequirePermission(PermissionCatalog.OPS_AUDIT_READ)
    public ApiResponse<RetentionPolicy> updateRetention(@PathVariable java.util.UUID id,
                                                        @RequestBody Map<String, Object> body) {
        Integer days = body.get("retentionDays") == null ? null
                : Integer.valueOf(String.valueOf(body.get("retentionDays")));
        Boolean enabled = body.get("enabled") == null ? null
                : Boolean.valueOf(String.valueOf(body.get("enabled")));
        String cron = body.get("cron") == null ? null : String.valueOf(body.get("cron"));
        return ApiResponse.ok(retentionService.update(id, days, enabled, cron));
    }

    @PostMapping("/retention-policies/{id}/run")
    @RequirePermission(PermissionCatalog.OPS_AUDIT_READ)
    public ApiResponse<RetentionPolicy> runRetention(@PathVariable java.util.UUID id) {
        return ApiResponse.ok(retentionService.runNow(id));
    }

    @GetMapping("/audit-logs")
    @RequirePermission(PermissionCatalog.OPS_AUDIT_READ)
    public ApiResponse<PageResult<AuditLog>> auditLogs(@RequestParam(required = false) String action,
                                                       @RequestParam(required = false) String actorName,
                                                       @RequestParam(defaultValue = "1") long page,
                                                       @RequestParam(defaultValue = "20") long pageSize) {
        return ApiResponse.ok(auditLogService.list(action, actorName, page, pageSize));
    }

    @GetMapping("/metrics/overview")
    public ApiResponse<Map<String, Object>> overview() {
        String tenantId = TenantContext.require();
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("knowledgeBases", count("select count(*) from knowledge_base where tenant_id = ? and deleted_at is null", tenantId));
        metrics.put("documents", count("select count(*) from document where tenant_id = ? and deleted_at is null", tenantId));
        metrics.put("chunks", count("select count(*) from chunk_meta where tenant_id = ?", tenantId));
        metrics.put("conversations", count("select count(*) from conversation where tenant_id = ?", tenantId));
        metrics.put("messages", count("select count(*) from message where tenant_id = ?", tenantId));
        metrics.put("runningJobs", count("select count(*) from index_job where tenant_id = ? and status in ('queued','running')", tenantId));
        metrics.put("failedJobs", count("select count(*) from index_job where tenant_id = ? and status = 'failed'", tenantId));

        Map<String, Object> today = new LinkedHashMap<>();
        today.put("conversations", count("select count(*) from conversation where tenant_id = ? and created_at >= current_date", tenantId));
        today.put("messages", count("select count(*) from message where tenant_id = ? and created_at >= current_date", tenantId));
        today.put("tokens", count("select coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0) from message where tenant_id = ? and created_at >= current_date", tenantId));
        today.put("costUsd", decimal("select coalesce(sum(cost_usd),0) from message where tenant_id = ? and created_at >= current_date", tenantId));
        today.put("indexedDocuments", count("select count(*) from document where tenant_id = ? and status = 'active' and updated_at >= current_date", tenantId));
        metrics.put("today", today);

        Map<String, Object> latency = new LinkedHashMap<>();
        latency.put("avgMessageLatencyMs", count("select coalesce(avg(latency_ms),0) from message where tenant_id = ? and role = 'assistant' and latency_ms is not null and created_at >= current_date", tenantId));
        latency.put("avgIndexDurationMs", count("select coalesce(avg(extract(epoch from (finished_at - started_at)) * 1000),0) from index_job where tenant_id = ? and finished_at is not null and created_at >= current_date", tenantId));
        metrics.put("performance", latency);
        return ApiResponse.ok(metrics);
    }

    /** 近 N 天趋势，供概览页折线图。缺数据返回 0，不返回错误。 */
    @GetMapping("/metrics/trends")
    public ApiResponse<Map<String, Object>> trends(@RequestParam(defaultValue = "7") int days) {
        String tenantId = TenantContext.require();
        int window = Math.max(1, Math.min(days, 30));
        List<Map<String, Object>> points = new ArrayList<>();
        for (int i = window - 1; i >= 0; i--) {
            String day = "%d days".formatted(i);
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", jdbcTemplate.queryForObject(
                    "select to_char(current_date - interval '" + i + " days', 'YYYY-MM-DD')", String.class));
            point.put("documents", count(
                    "select count(*) from document where tenant_id = ? and created_at::date = current_date - interval '" + day + "'", tenantId));
            point.put("conversations", count(
                    "select count(*) from conversation where tenant_id = ? and created_at::date = current_date - interval '" + day + "'", tenantId));
            point.put("messages", count(
                    "select count(*) from message where tenant_id = ? and created_at::date = current_date - interval '" + day + "'", tenantId));
            point.put("failedJobs", count(
                    "select count(*) from index_job where tenant_id = ? and status = 'failed' and created_at::date = current_date - interval '" + day + "'", tenantId));
            point.put("tokens", count(
                    "select coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0) from message where tenant_id = ? and created_at::date = current_date - interval '" + day + "'", tenantId));
            points.add(point);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("days", points);
        return ApiResponse.ok(payload);
    }

    /**
     * 通知中心：只汇总已经发生、需要运维关注的事件（索引失败、审计失败、排队/执行中的任务），
     * 全部来自库内真实记录，没有则返回空列表，前端据此展示空状态并隐藏角标。
     */
    @GetMapping("/notifications")
    public ApiResponse<Map<String, Object>> notifications(@RequestParam(defaultValue = "7") int days) {
        String tenantId = TenantContext.require();
        int window = Math.max(1, Math.min(days, 30));
        List<Map<String, Object>> items = new ArrayList<>();

        // 同一篇文档反复失败只留最新一条：否则一个坏文档能刷满整个通知面板，
        // 让人以为"每次刷新都是这几条"。
        String failedJobs = """
                select distinct on (j.document_id)
                       j.id, j.error_code, j.error_message, j.created_at, d.title
                from index_job j
                left join document d on d.id = j.document_id
                where j.tenant_id = ? and j.status = 'failed'
                  and j.created_at >= current_date - interval '%d days'
                order by j.document_id, j.created_at desc
                """.formatted(window);
        List<Map<String, Object>> jobItems = new ArrayList<>();
        jdbcTemplate.query(failedJobs, (RowCallbackHandler) rs -> {
            String title = rs.getString("title");
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", "job-" + rs.getString("id"));
            item.put("kind", "index_job");
            item.put("level", "error");
            item.put("title", "索引失败：" + (title == null || title.isBlank() ? "未命名文档" : title));
            item.put("description", describeFailure(rs.getString("error_code"), rs.getString("error_message")));
            item.put("occurredAt", toIso(rs.getTimestamp("created_at")));
            item.put("href", "/index-jobs");
            jobItems.add(item);
        }, tenantId);
        jobItems.sort((left, right) -> String.valueOf(right.get("occurredAt"))
                .compareTo(String.valueOf(left.get("occurredAt"))));
        items.addAll(jobItems.subList(0, Math.min(5, jobItems.size())));

        // 同一动作的失败也只留最新一条：批量重试失败会瞬间刷出十几条一模一样的记录
        String failedAudits = """
                select distinct on (action)
                       id, action, error_code, created_at
                from audit_log
                where tenant_id = ? and result = 'FAILED'
                  and created_at >= current_date - interval '%d days'
                order by action, created_at desc
                """.formatted(window);
        List<Map<String, Object>> auditItems = new ArrayList<>();
        jdbcTemplate.query(failedAudits, (RowCallbackHandler) rs -> {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", "audit-" + rs.getLong("id"));
            item.put("kind", "audit");
            item.put("level", "warning");
            item.put("title", "操作未完成：" + humanizeAction(rs.getString("action")));
            item.put("description", describeFailure(rs.getString("error_code"), null));
            item.put("occurredAt", toIso(rs.getTimestamp("created_at")));
            item.put("href", "/audit");
            auditItems.add(item);
        }, tenantId);
        auditItems.sort((left, right) -> String.valueOf(right.get("occurredAt"))
                .compareTo(String.valueOf(left.get("occurredAt"))));
        items.addAll(auditItems.subList(0, Math.min(3, auditItems.size())));

        items.sort((left, right) -> String.valueOf(right.get("occurredAt"))
                .compareTo(String.valueOf(left.get("occurredAt"))));

        long running = count("select count(*) from index_job where tenant_id = ? and status in ('queued','running')",
                tenantId);
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("total", items.size());
        counts.put("errors", items.stream().filter(item -> "error".equals(item.get("level"))).count());
        counts.put("warnings", items.stream().filter(item -> "warning".equals(item.get("level"))).count());
        counts.put("runningJobs", running);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("items", items);
        payload.put("counts", counts);
        payload.put("windowDays", window);
        return ApiResponse.ok(payload);
    }

    private String describeFailure(String errorCode, String errorMessage) {
        String code = errorCode == null || errorCode.isBlank() ? "未知错误" : errorCode;
        if (errorMessage == null || errorMessage.isBlank()) {
            return code;
        }
        String message = errorMessage.length() > 160 ? errorMessage.substring(0, 160) + "…" : errorMessage;
        return code + " · " + message;
    }

    private String humanizeAction(String action) {
        if (action == null || action.isBlank()) {
            return "未知操作";
        }
        return switch (action) {
            case "auth.login" -> "登录";
            case "doc.commit" -> "文档提交索引";
            case "doc.uploadIntent" -> "文档上传";
            case "doc.reindex" -> "文档重索引";
            case "doc.delete" -> "文档删除";
            case "index.retry" -> "索引重试";
            case "index.cancel" -> "索引取消";
            case "index.fail", "index.complete" -> "索引执行";
            case "eval.dataset.create" -> "评测数据集创建";
            case "eval.run.create" -> "发起评测";
            case "graph.build" -> "图谱构建";
            case "graph.select" -> "图谱文档选择";
            case "kb.create" -> "知识库创建";
            case "kb.update" -> "知识库更新";
            case "kb.delete" -> "知识库删除";
            case "kb.member.add" -> "知识库成员授权";
            case "kb.acl.update", "document.acl.update" -> "权限变更";
            case "profile.create" -> "检索策略创建";
            case "profile.publish" -> "检索策略发布";
            case "datasource.create" -> "数据源接入";
            case "datasource.sync" -> "数据源同步";
            case "iam.user.create" -> "创建用户";
            case "iam.user.update" -> "更新用户";
            case "iam.user.assignRoles" -> "用户角色变更";
            case "iam.user.changePassword" -> "修改密码";
            case "iam.role.create" -> "创建角色";
            default -> "后台操作";
        };
    }

    private String toIso(java.sql.Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant().toString();
    }

    private long count(String sql, String tenantId) {
        Long value = jdbcTemplate.queryForObject(sql, Long.class, tenantId);
        return value == null ? 0 : value;
    }

    private double decimal(String sql, String tenantId) {
        java.math.BigDecimal value = jdbcTemplate.queryForObject(sql, java.math.BigDecimal.class, tenantId);
        return value == null ? 0d : value.doubleValue();
    }
}