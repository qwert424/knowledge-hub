package com.knowledgehub.chat.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.tenant.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

/**
 * 用户端可配置项（当前只有空状态推荐问题）。
 *
 * <p>以前推荐问题写死在前端，改一句文案就要发版；现在落到 {@code portal_setting} 表，
 * 由管理端按租户维护，没有配置时回落到内置默认文案。
 */
@Service
public class PortalSettingsService {

    private static final Logger log = LoggerFactory.getLogger(PortalSettingsService.class);
    private static final String KEY_SUGGESTIONS = "portal.suggestions";
    private static final int MAX_ITEMS = 4;
    private static final int MAX_LENGTH = 60;

    private static final List<String> DEFAULTS = List.of(
            "公司差旅报销标准是什么？",
            "入职需要准备哪些材料？",
            "总结一下请假流程的关键节点",
            "报销单需要哪些附件？"
    );

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public PortalSettingsService(JdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public List<String> defaults() {
        return DEFAULTS;
    }

    /** 当前租户生效的推荐问题（没有配置或配置为空时用默认值）。 */
    public List<String> suggestions() {
        try {
            String raw = jdbc.query(
                    "select value::text from portal_setting where tenant_id = ? and setting_key = ?",
                    rs -> rs.next() ? rs.getString(1) : null,
                    TenantContext.require(), KEY_SUGGESTIONS);
            List<String> parsed = parse(raw);
            return parsed.isEmpty() ? DEFAULTS : parsed;
        } catch (RuntimeException ex) {
            log.debug("portal settings unavailable: {}", ex.getMessage());
            return DEFAULTS;
        }
    }

    /** 管理端保存（空列表表示恢复默认）。 */
    @Transactional
    public List<String> saveSuggestions(List<String> items) {
        String tenantId = TenantContext.require();
        List<String> cleaned = clean(items);
        String json;
        try {
            json = objectMapper.writeValueAsString(cleaned);
        } catch (Exception ex) {
            throw new IllegalStateException("推荐问题序列化失败", ex);
        }
        jdbc.update(
                "insert into portal_setting (tenant_id, setting_key, value, updated_at) "
                        + "values (?, ?, ?::jsonb, now()) "
                        + "on conflict (tenant_id, setting_key) "
                        + "do update set value = excluded.value, updated_at = now()",
                tenantId, KEY_SUGGESTIONS, json);
        return cleaned;
    }

    private List<String> clean(List<String> items) {
        List<String> result = new ArrayList<>();
        if (items == null) {
            return result;
        }
        for (String item : items) {
            if (item == null) {
                continue;
            }
            String text = item.trim();
            if (text.isEmpty()) {
                continue;
            }
            result.add(text.length() > MAX_LENGTH ? text.substring(0, MAX_LENGTH) : text);
            if (result.size() >= MAX_ITEMS) {
                break;
            }
        }
        return result;
    }

    private List<String> parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            List<String> parsed = objectMapper.readValue(raw, new TypeReference<List<String>>() {
            });
            return clean(parsed);
        } catch (Exception ex) {
            log.debug("portal suggestions are not valid json: {}", ex.getMessage());
            return List.of();
        }
    }
}
