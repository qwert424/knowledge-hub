package com.knowledgehub.chat.service;

import com.knowledgehub.common.tenant.TenantContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 配额策略。
 *
 * 额度落在既有的 {@code quota} 表（tenant_id + subject_type + subject_id + period），
 * 所以"谁能用多少"是可配置、可审计的数据，而不是写死在代码里的数字：
 *
 * - 优先读用户级额度（subject_type=user，subject_id=用户 id）；
 * - 没有用户级配置时读租户级额度（subject_type=tenant）；
 * - 两者都没有 → 不限（limit=0 表示不限）。
 *
 * 当前没有在线收款，因此额度由管理员在控制台设置，属于内部成本管控，不涉及计费。
 */
@Service
public class QuotaService {

    private final JdbcTemplate jdbc;

    public QuotaService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public static String currentPeriod() {
        return YearMonth.now().toString();
    }

    /** 生效额度；0 表示不限。source 说明这条额度从哪来（user / role / group / tenant / none）。 */
    public Limits limits(String tenantId, String userId) {
        return limits(tenantId, userId, List.of(), List.of());
    }

    /**
     * 优先级：用户 → 角色 → 群组 → 租户。哪一层配了就用哪一层，
     * 这样"给角色统一设额度、个别加白名单"不需要重复配置。
     */
    public Limits limits(String tenantId, String userId, List<String> roleCodes, List<String> groupIds) {
        String period = currentPeriod();
        Map<String, Object> row = firstRow(tenantId, "user", userId, period);
        if (row != null) {
            return limitsOf(row, "user");
        }
        for (String role : roleCodes == null ? List.<String>of() : roleCodes) {
            row = firstRow(tenantId, "role", role, period);
            if (row != null) {
                return limitsOf(row, "role:" + role);
            }
        }
        for (String group : groupIds == null ? List.<String>of() : groupIds) {
            row = firstRow(tenantId, "group", group, period);
            if (row != null) {
                return limitsOf(row, "group:" + group);
            }
        }
        row = firstRow(tenantId, "tenant", tenantId, period);
        if (row != null) {
            return limitsOf(row, "tenant");
        }
        return new Limits(0, 0, "none");
    }

    private static Limits limitsOf(Map<String, Object> row, String source) {
        return new Limits(asLong(row.get("limit_tokens")), asLong(row.get("limit_requests")), source);
    }

    /** 管理员设置额度。limit 传 0 表示不限。 */
    @Transactional
    public void setLimits(String subjectType, String subjectId, long limitTokens, long limitRequests) {
        String tenantId = TenantContext.require();
        String period = currentPeriod();
        Long exists = jdbc.query(
                "select count(1) from quota where tenant_id = ? and subject_type = ? and subject_id = ? and period = ?",
                rs -> rs.next() ? rs.getLong(1) : 0L,
                tenantId, subjectType, subjectId, period);
        if (exists != null && exists > 0) {
            jdbc.update(
                    "update quota set limit_tokens = ?, limit_requests = ?, updated_at = now() "
                            + "where tenant_id = ? and subject_type = ? and subject_id = ? and period = ?",
                    limitTokens, limitRequests, tenantId, subjectType, subjectId, period);
        } else {
            jdbc.update(
                    "insert into quota (id, tenant_id, subject_type, subject_id, period, tokens_used, "
                            + "requests_used, limit_tokens, limit_requests, updated_at) "
                            + "values (?, ?, ?, ?, ?, 0, 0, ?, ?, now())",
                    java.util.UUID.randomUUID(), tenantId, subjectType, subjectId, period,
                    limitTokens, limitRequests);
        }
    }

    /** 撤销某条额度配置（回到上一层：用户→角色→用户组→租户）。用量记录不动。 */
    public void clearLimits(String subjectType, String subjectId) {
        String tenantId = TenantContext.require();
        jdbc.update("delete from quota where tenant_id = ? and subject_type = ? and subject_id = ?",
                tenantId, subjectType, subjectId == null ? "" : subjectId);
    }

    /** 把本月已用量记账（失败不影响业务，量以消息表为准）。 */
    public void recordUsage(String tenantId, String userId, long tokens, boolean answered) {
        String period = currentPeriod();
        String subjectId = userId;
        try {
            Long exists = jdbc.query(
                    "select count(1) from quota where tenant_id = ? and subject_type = 'user' "
                            + "and subject_id = ? and period = ?",
                    rs -> rs.next() ? rs.getLong(1) : 0L,
                    tenantId, subjectId, period);
            if (exists != null && exists > 0) {
                jdbc.update(
                        "update quota set tokens_used = tokens_used + ?, requests_used = requests_used + ?, "
                                + "updated_at = now() where tenant_id = ? and subject_type = 'user' "
                                + "and subject_id = ? and period = ?",
                        Math.max(0, tokens), answered ? 1 : 0, tenantId, subjectId, period);
            }
        } catch (RuntimeException ignored) {
            // 记账是辅助信息，绝不能反过来让回答失败
        }
    }

    /**
     * 管理端视图：本租户所有已配置的额度 + 本月真实用量。
     * 用量以消息表为准（quota.tokens_used 只是记账缓存，可能落后），
     * 这样控制台看到的数字与用户端「我的用量」永远一致。
     */
    public Map<String, Object> overview() {
        String tenantId = TenantContext.require();
        String period = currentPeriod();
        var rows = jdbc.queryForList(
                "select subject_type, subject_id, limit_tokens, limit_requests, updated_at "
                        + "from quota where tenant_id = ? and period = ? "
                        + "order by subject_type, subject_id",
                tenantId, period);
        List<Map<String, Object>> items = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            Map<String, Object> item = new LinkedHashMap<>(row);
            String subjectType = String.valueOf(row.get("subject_type"));
            String subjectId = String.valueOf(row.get("subject_id"));
            String usersSql;
            List<Object> args = new ArrayList<>();
            args.add(tenantId);
            if ("user".equals(subjectType)) {
                usersSql = "select m.input_tokens, m.output_tokens, m.role, m.status from message m "
                        + "join conversation c on c.id = m.conversation_id "
                        + "where m.tenant_id = ? and c.user_id = ? "
                        + "and m.created_at >= date_trunc('month', now())";
                args.add(subjectId);
            } else if ("role".equals(subjectType)) {
                // 角色额度：把该角色下所有成员的当月用量加起来
                usersSql = "select m.input_tokens, m.output_tokens, m.role, m.status from message m "
                        + "join conversation c on c.id = m.conversation_id "
                        + "join user_role ur on ur.user_id = c.user_id "
                        + "join role r on r.id = ur.role_id "
                        + "where m.tenant_id = ? and r.code = ? "
                        + "and m.created_at >= date_trunc('month', now())";
                args.add(subjectId);
            } else if ("group".equals(subjectType)) {
                usersSql = "select m.input_tokens, m.output_tokens, m.role, m.status from message m "
                        + "join conversation c on c.id = m.conversation_id "
                        + "join user_group_member gm on gm.user_id = c.user_id "
                        + "where m.tenant_id = ? and gm.group_id = ? "
                        + "and m.created_at >= date_trunc('month', now())";
                args.add(java.util.UUID.fromString(subjectId));
            } else {
                usersSql = "select m.input_tokens, m.output_tokens, m.role, m.status from message m "
                        + "where m.tenant_id = ? and m.created_at >= date_trunc('month', now())";
            }
            Object usedTokens;
            Object usedRequests;
            try {
                var usageRows = jdbc.queryForList(usersSql, args.toArray());
                long tokens = 0;
                long answers = 0;
                for (Map<String, Object> usage : usageRows) {
                    tokens += asLong(usage.get("input_tokens")) + asLong(usage.get("output_tokens"));
                    if ("assistant".equals(String.valueOf(usage.get("role")))
                            && ("completed".equals(String.valueOf(usage.get("status")))
                            || "stopped".equals(String.valueOf(usage.get("status"))))) {
                        answers++;
                    }
                }
                usedTokens = tokens;
                usedRequests = answers;
            } catch (RuntimeException ex) {
                usedTokens = row.get("tokens_used");
                usedRequests = row.get("requests_used");
            }
            item.put("tokens_used", asLong(usedTokens));
            item.put("requests_used", asLong(usedRequests));
            item.put("subject_label", subjectLabel(tenantId, subjectType, subjectId));
            items.add(item);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("period", period);
        body.put("items", items);
        body.put("unlimitedHint", "limit_tokens / limit_requests 为 0 表示不限；完全没有配置时按系统默认额度执行。");
        return body;
    }

    /** 主体显示名：用户显示账号、角色/群组显示名称，列表里就不用看一串 uuid。 */
    private String subjectLabel(String tenantId, String subjectType, String subjectId) {
        try {
            switch (subjectType) {
                case "user" -> {
                    var rows = jdbc.queryForList(
                            "select username, display_name from app_user where tenant_id = ? and id = ?",
                            tenantId, java.util.UUID.fromString(subjectId));
                    if (!rows.isEmpty()) {
                        Object display = rows.get(0).get("display_name");
                        Object username = rows.get(0).get("username");
                        return display == null || String.valueOf(display).isBlank()
                                ? String.valueOf(username) : String.valueOf(display) + "（" + username + "）";
                    }
                }
                case "role" -> {
                    var rows = jdbc.queryForList("select name from role where code = ?", subjectId);
                    if (!rows.isEmpty()) {
                        return String.valueOf(rows.get(0).get("name"));
                    }
                }
                case "group" -> {
                    var rows = jdbc.queryForList("select name from user_group where id = ?",
                            java.util.UUID.fromString(subjectId));
                    if (!rows.isEmpty()) {
                        return String.valueOf(rows.get(0).get("name"));
                    }
                }
                default -> {
                    return "全租户";
                }
            }
        } catch (RuntimeException ex) {
            return null;
        }
        return null;
    }

    private Map<String, Object> firstRow(String tenantId, String subjectType, String subjectId, String period) {        var rows = jdbc.queryForList(
                "select limit_tokens, limit_requests from quota where tenant_id = ? and subject_type = ? "
                        + "and subject_id = ? and period = ? limit 1",
                tenantId, subjectType, subjectId, period);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static long asLong(Object value) {
        if (value == null) {
            return 0L;
        }
        if (value instanceof Number number) {
            return number.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return 0L;
        }
    }

    public record Limits(long limitTokens, long limitRequests, String source) {
        public boolean unlimited() {
            return limitTokens <= 0 && limitRequests <= 0;
        }
    }
}
