package com.knowledgehub.ops.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.ops.entity.RetentionPolicy;
import com.knowledgehub.ops.mapper.RetentionPolicyMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 数据保留与自动清理。
 *
 * <p>审计和会话消息只增不减，跑几个月就会把列表与统计拖慢。这里按策略表
 * （{@code retention_policy}）每天定时删除超期数据：默认审计 180 天、对话 90 天，
 * 每条策略的 cron 与天数都能在管理端改，改完下一次调度就生效（每分钟扫一遍启用的策略，
 * 命中 cron 的才真跑，避免为每条策略单独注册调度任务）。
 */
@Service
public class RetentionService {

    private static final Logger log = LoggerFactory.getLogger(RetentionService.class);

    /** 支持清理的表：只认这几个，避免被误配成删业务表 */
    private static final List<String> ALLOWED_TARGETS = List.of("audit_log", "chat_message");

    private final RetentionPolicyMapper mapper;
    private final JdbcTemplate jdbc;

    public RetentionService(RetentionPolicyMapper mapper, JdbcTemplate jdbc) {
        this.mapper = mapper;
        this.jdbc = jdbc;
    }

    public List<RetentionPolicy> list() {
        return mapper.selectList(Wrappers.<RetentionPolicy>lambdaQuery()
                .orderByAsc(RetentionPolicy::getTarget));
    }

    public RetentionPolicy update(java.util.UUID id, Integer retentionDays, Boolean enabled, String cron) {
        RetentionPolicy policy = mapper.selectById(id);
        if (policy == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.NOT_FOUND, "保留策略不存在");
        }
        if (retentionDays != null) {
            if (retentionDays < 1 || retentionDays > 3650) {
                throw new com.knowledgehub.common.error.BizException(
                        com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "保留天数需在 1~3650 之间");
            }
            policy.setRetentionDays(retentionDays);
        }
        if (enabled != null) {
            policy.setEnabled(enabled);
        }
        if (cron != null && !cron.isBlank()) {
            // Spring 的 cron 是 6 段；只做格式兜底，真正解析交给调度器
            if (cron.trim().split("\\s+").length != 6) {
                throw new com.knowledgehub.common.error.BizException(
                        com.knowledgehub.common.error.ErrorCode.BAD_REQUEST,
                        "cron 需要 6 段（秒 分 时 日 月 周），例如 0 30 3 * * *");
            }
            policy.setCron(cron.trim());
        }
        policy.setUpdatedAt(OffsetDateTime.now());
        mapper.updateById(policy);
        return policy;
    }

    /** 立刻执行一条策略（界面上「立即执行」按钮） */
    public RetentionPolicy runNow(java.util.UUID id) {
        RetentionPolicy policy = mapper.selectById(id);
        if (policy == null) {
            throw new com.knowledgehub.common.error.BizException(
                    com.knowledgehub.common.error.ErrorCode.NOT_FOUND, "保留策略不存在");
        }
        return execute(policy);
    }

    /** 每分钟检查一次：cron 到点且启用的策略才执行 */
    @Scheduled(cron = "0 * * * * *")
    public void tick() {
        OffsetDateTime now = OffsetDateTime.now();
        for (RetentionPolicy policy : list()) {
            if (!Boolean.TRUE.equals(policy.getEnabled()) || !isDue(policy, now)) {
                continue;
            }
            try {
                execute(policy);
            } catch (RuntimeException ex) {
                log.warn("retention {} failed: {}", policy.getTarget(), ex.getMessage());
            }
        }
    }

    private boolean isDue(RetentionPolicy policy, OffsetDateTime now) {
        try {
            org.springframework.scheduling.support.CronExpression expression =
                    org.springframework.scheduling.support.CronExpression.parse(policy.getCron());
            OffsetDateTime base = policy.getLastRunAt() == null ? now.minusMinutes(1) : policy.getLastRunAt();
            OffsetDateTime next = expression.next(base);
            return next != null && !next.isAfter(now);
        } catch (RuntimeException ex) {
            log.debug("retention cron invalid for {}: {}", policy.getTarget(), ex.getMessage());
            return false;
        }
    }

    private RetentionPolicy execute(RetentionPolicy policy) {
        String target = policy.getTarget();
        int deleted = 0;
        String message = "";
        String status = "success";
        try {
            if (!ALLOWED_TARGETS.contains(target)) {
                throw new IllegalStateException("不支持清理的表：" + target);
            }
            OffsetDateTime cutoff = OffsetDateTime.now().minusDays(policy.getRetentionDays());
            if ("audit_log".equals(target)) {
                deleted = jdbc.update("delete from audit_log where created_at < ?", cutoff);
            } else {
                // 会话消息：先删引用再删消息，避免留下孤儿引用
                deleted = jdbc.update(
                        "delete from message_citation where message_id in "
                                + "(select id from message where created_at < ?)",
                        cutoff);
                deleted += jdbc.update("delete from message where created_at < ?", cutoff);
            }
            message = "删除 " + deleted + " 行（早于 " + cutoff.toLocalDate() + "）";
        } catch (RuntimeException ex) {
            status = "failed";
            message = String.valueOf(ex.getMessage());
            log.warn("retention {} failed: {}", target, message);
        }
        policy.setLastRunAt(OffsetDateTime.now());
        policy.setLastDeleted(deleted);
        policy.setLastStatus(status);
        policy.setLastMessage(message);
        mapper.updateById(policy);
        return policy;
    }
}
