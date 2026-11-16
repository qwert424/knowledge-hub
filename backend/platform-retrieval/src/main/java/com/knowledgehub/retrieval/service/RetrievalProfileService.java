package com.knowledgehub.retrieval.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.integration.engine.RagEngineClient;
import com.knowledgehub.iam.service.RetrievalTicketService;
import com.knowledgehub.kb.service.KbService;
import com.knowledgehub.retrieval.entity.RetrievalProfile;
import com.knowledgehub.retrieval.entity.RetrievalTrace;
import com.knowledgehub.retrieval.mapper.RetrievalProfileMapper;
import com.knowledgehub.retrieval.mapper.RetrievalTraceMapper;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class RetrievalProfileService {

    /**
     * 策略配置的默认值：**必须和引擎实际读的键一致**。
     *
     * <p>引擎（`agent/src/knowledge_hub/rag/retriever.py`）读的是扁平键：
     * `dense_top_k` / `sparse_top_k` / `top_k` / `timeout_ms` / `embedding_dim`，
     * 早期这里写的是嵌套形状（`dense: {topK}`），引擎根本不认，等于这条策略静默失效。
     */
    public static final String DEFAULT_CONFIG = """
            {
              "dense_top_k": 20,
              "sparse_top_k": 20,
              "top_k": 8,
              "fusion": "rrf",
              "rerank": {"enabled": false, "model": "", "top_n": 8},
              "graph": {"enabled": false, "hops": 2},
              "timeout_ms": 8000
            }
            """;

    private final RetrievalProfileMapper profileMapper;
    private final RetrievalTraceMapper traceMapper;
    private final RagEngineClient engine;
    private final RetrievalTicketService ticketService;
    private final KbService kbService;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;

    public RetrievalProfileService(RetrievalProfileMapper profileMapper, RetrievalTraceMapper traceMapper,
                                   RagEngineClient engine, RetrievalTicketService ticketService,
                                   KbService kbService, AuditRecorder auditRecorder, ObjectMapper objectMapper) {
        this.profileMapper = profileMapper;
        this.traceMapper = traceMapper;
        this.engine = engine;
        this.ticketService = ticketService;
        this.kbService = kbService;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
    }

    public List<ProfileView> list() {
        String tenantId = TenantContext.require();
        return profileMapper.selectList(Wrappers.<RetrievalProfile>lambdaQuery()
                        .eq(RetrievalProfile::getTenantId, tenantId)
                        .isNull(RetrievalProfile::getDeletedAt)
                        .orderByDesc(RetrievalProfile::getUpdatedAt))
                .stream().map(this::toView).toList();
    }

    /** 回收站：只列软删除的策略，供恢复或彻底删除 */
    public List<ProfileView> listDeleted() {
        String tenantId = TenantContext.require();
        return profileMapper.selectList(Wrappers.<RetrievalProfile>lambdaQuery()
                        .eq(RetrievalProfile::getTenantId, tenantId)
                        .isNotNull(RetrievalProfile::getDeletedAt)
                        .orderByDesc(RetrievalProfile::getDeletedAt))
                .stream().map(this::toView).toList();
    }

    /** 删除 = 进回收站。会话里引用它的按默认策略兜底，所以这里不做硬删。 */
    public ProfileView softDelete(UUID id) {
        RetrievalProfile profile = require(id);
        if ("published".equals(profile.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "已发布的策略不能删除，先停用再删");
        }
        profile.setDeletedAt(OffsetDateTime.now());
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.updateById(profile);
        auditRecorder.record("profile.delete", "retrieval_profile", id.toString(), profile.getName(), null);
        return toView(profile);
    }

    public ProfileView restore(UUID id) {
        RetrievalProfile profile = require(id);
        // updateById 会忽略 null 字段，清理 deleted_at 必须用 set()
        profileMapper.update(null, Wrappers.<RetrievalProfile>lambdaUpdate()
                .eq(RetrievalProfile::getId, id)
                .set(RetrievalProfile::getDeletedAt, null)
                .set(RetrievalProfile::getUpdatedAt, OffsetDateTime.now()));
        auditRecorder.record("profile.restore", "retrieval_profile", id.toString(), null, profile.getName());
        return toView(require(id));
    }

    public void purge(UUID id) {
        RetrievalProfile profile = require(id);
        if (profile.getDeletedAt() == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "只有回收站里的策略才能彻底删除");
        }
        profileMapper.deleteById(id);
        auditRecorder.record("profile.purge", "retrieval_profile", id.toString(), profile.getName(), null);
    }

    public int purgeAllDeleted() {
        String tenantId = TenantContext.require();
        List<RetrievalProfile> trashed = profileMapper.selectList(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, tenantId)
                .isNotNull(RetrievalProfile::getDeletedAt));
        for (RetrievalProfile profile : trashed) {
            profileMapper.deleteById(profile.getId());
        }
        if (!trashed.isEmpty()) {
            auditRecorder.record("profile.purge", "retrieval_profile", null, null,
                    "清空回收站 " + trashed.size() + " 条");
        }
        return trashed.size();
    }

    public RetrievalProfile require(UUID id) {
        String tenantId = TenantContext.require();
        RetrievalProfile profile = profileMapper.selectOne(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, tenantId)
                .eq(RetrievalProfile::getId, id));
        if (profile == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "检索策略不存在");
        }
        return profile;
    }

    public RetrievalProfileView get(UUID id) {
        return new RetrievalProfileView(require(id));
    }

    public ProfileView create(String name, String config) {
        String tenantId = TenantContext.require();
        RetrievalProfile profile = new RetrievalProfile();
        profile.setId(Ids.uuid7());
        profile.setTenantId(tenantId);
        profile.setName(name);
        profile.setVersion(1);
        profile.setConfig(normaliseConfig(config));
        profile.setIsDefault(false);
        profile.setStatus("draft");
        profile.setCreatedAt(OffsetDateTime.now());
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.insert(profile);
        auditRecorder.record("profile.create", "retrieval_profile", profile.getId().toString(), null, name);
        return toView(profile);
    }

    public ProfileView update(UUID id, String name, String config) {
        RetrievalProfile profile = require(id);
        if ("published".equals(profile.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "已发布策略不可直接修改，请复制新版本");
        }
        if (name != null && !name.isBlank()) {
            profile.setName(name);
        }
        if (config != null && !config.isBlank()) {
            profile.setConfig(normaliseConfig(config));
        }
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.updateById(profile);
        return toView(profile);
    }

    public ProfileView publish(UUID id) {
        RetrievalProfile profile = require(id);
        profile.setStatus("published");
        profile.setPublishedAt(OffsetDateTime.now());
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.updateById(profile);
        auditRecorder.record("profile.publish", "retrieval_profile", id.toString(), null, profile.getName());
        return toView(profile);
    }

    /**
     * 停用一条策略。会话需要至少一条已发布策略兜底，所以不允许把最后一条发布中的策略停掉。
     */
    public ProfileView disable(UUID id) {
        RetrievalProfile profile = require(id);
        if ("disabled".equals(profile.getStatus())) {
            return toView(profile);
        }
        Long published = profileMapper.selectCount(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, profile.getTenantId())
                .eq(RetrievalProfile::getStatus, "published"));
        if ("published".equals(profile.getStatus()) && published != null && published <= 1) {
            throw new BizException(ErrorCode.BAD_REQUEST, "至少要保留一条已发布策略，请先发布另一条再停用这条");
        }
        profile.setStatus("disabled");
        profile.setUpdatedAt(OffsetDateTime.now());
        profileMapper.updateById(profile);
        auditRecorder.record("profile.disable", "retrieval_profile", id.toString(), profile.getName(), "disabled");
        return toView(profile);
    }

    public JsonNode test(String query, List<String> kbIds, UUID profileId, int topK, List<String> tags) {
        CurrentUser user = UserContext.require();
        RetrievalProfile profile = profileId == null ? defaultProfile() : require(profileId);
        String ticket = ticketService.issue(user, kbIds.stream().map(UUID::fromString).toList());
        java.util.Map<String, String> collections = new java.util.LinkedHashMap<>();
        for (String kbId : kbIds) {
            collections.put(kbId, kbService.require(kbId).getCollectionName());
        }
        // 标签只是收窄条件，ACL 仍然由 ticket 决定。
        java.util.Map<String, Object> filters = tags == null || tags.isEmpty()
                ? null : java.util.Map.of("tags", tags);
        long start = System.currentTimeMillis();
        JsonNode result;
        try {
            result = engine.retrieve(ticket, kbIds, query, readConfig(profile), topK, true, collections, filters);
        } catch (BizException ex) {
            result = objectMapper.createObjectNode().put("error", ex.getMessage());
        }
        long duration = System.currentTimeMillis() - start;

        RetrievalTrace trace = new RetrievalTrace();
        trace.setId(Ids.uuid7());
        trace.setTenantId(user.tenantId());
        trace.setProfileId(profile.getId());
        trace.setQuery(query);
        trace.setKbIds(toJson(kbIds));
        trace.setRequest(toJson(filters == null
                ? java.util.Map.of("topK", topK, "kbIds", kbIds)
                : java.util.Map.of("topK", topK, "kbIds", kbIds, "filters", filters)));
        trace.setResult(result.toString());
        trace.setDurationMs((int) duration);
        trace.setCreatedBy(user.userId());
        trace.setCreatedAt(OffsetDateTime.now());
        traceMapper.insert(trace);
        return result;
    }

    /**
     * 评测用的问答：走和用户端一样的链路（同一份策略 + 同一个 ticket），拿到完整答复。
     * 不走 {@link #test} 的检索调试分支，因为评测要看"最终回复"而不只是召回。
     */
    public JsonNode answer(String query, List<String> kbIds, UUID profileId, UUID conversationId) {
        CurrentUser user = UserContext.require();
        RetrievalProfile profile = profileId == null ? defaultProfile() : require(profileId);
        List<UUID> kbUuids = kbIds.stream().filter(id -> id != null && !id.isBlank()).map(UUID::fromString).toList();
        String ticket = ticketService.issue(user, kbUuids);
        java.util.Map<String, String> collections = new java.util.LinkedHashMap<>();
        for (UUID kbId : kbUuids) {
            collections.put(kbId.toString(), kbService.require(kbId.toString()).getCollectionName());
        }
        return engine.answer(ticket, kbIds, query, readConfig(profile), collections,
                conversationId == null ? "" : conversationId.toString());
    }

    public List<TraceView> traces(int limit) {        String tenantId = TenantContext.require();
        return traceMapper.selectList(Wrappers.<RetrievalTrace>lambdaQuery()
                        .eq(RetrievalTrace::getTenantId, tenantId)
                        .orderByDesc(RetrievalTrace::getCreatedAt)
                        .last("limit " + Math.min(limit, 100)))
                .stream()
                .map(t -> new TraceView(t.getId().toString(), t.getQuery(), t.getDurationMs(), t.getResult(),
                        t.getCreatedAt() == null ? null : t.getCreatedAt().toString()))
                .toList();
    }

    /** 调试记录是临时产物：允许单条或批量删除，避免调试台越用越卡 */
    public int deleteTraces(List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        String tenantId = TenantContext.require();
        int deleted = traceMapper.delete(Wrappers.<RetrievalTrace>lambdaQuery()
                .eq(RetrievalTrace::getTenantId, tenantId)
                .in(RetrievalTrace::getId, ids));
        auditRecorder.record("profile.trace.delete", "retrieval_profile", null, null,
                "删除调试记录 " + deleted + " 条");
        return deleted;
    }

    public RetrievalProfile defaultProfile() {
        String tenantId = TenantContext.get() == null ? TenantContext.DEFAULT_TENANT : TenantContext.get();
        RetrievalProfile profile = profileMapper.selectOne(Wrappers.<RetrievalProfile>lambdaQuery()
                .eq(RetrievalProfile::getTenantId, tenantId)
                .eq(RetrievalProfile::getIsDefault, true)
                .isNull(RetrievalProfile::getDeletedAt)
                .last("limit 1"));
        return profile;
    }

    public JsonNode readConfig(RetrievalProfile profile) {
        if (profile == null) {
            try {
                return objectMapper.readTree(DEFAULT_CONFIG);
            } catch (Exception ex) {
                return objectMapper.createObjectNode();
            }
        }
        try {
            // 老数据可能是嵌套形状：读的时候兜一层，保证引擎永远拿到它能认的键
            return objectMapper.readTree(normaliseConfig(profile.getConfig()));
        } catch (Exception ex) {
            return objectMapper.createObjectNode();
        }
    }

    /**
     * 把早期的嵌套形状（`dense: {topK}`、`rerank: {topN}`）翻成引擎认的扁平键。
     * 已经扁平的配置原样返回（幂等），解析失败也原样返回，不吞掉用户写的内容。
     */
    @SuppressWarnings("unchecked")
    public String normaliseConfig(String raw) {
        if (raw == null || raw.isBlank()) {
            return DEFAULT_CONFIG;
        }
        com.fasterxml.jackson.databind.node.ObjectNode node;
        try {
            JsonNode parsed = objectMapper.readTree(raw);
            if (!parsed.isObject()) {
                return raw;
            }
            node = ((com.fasterxml.jackson.databind.node.ObjectNode) parsed).deepCopy();
        } catch (Exception ex) {
            return raw;
        }
        // dense / sparse：{enabled, topK} -> dense_top_k / sparse_top_k
        JsonNode dense = node.remove("dense");
        if (dense != null && dense.isObject() && node.path("dense_top_k").isMissingNode()) {
            node.put("dense_top_k", dense.path("topK").asInt(dense.path("top_k").asInt(20)));
        }
        JsonNode sparse = node.remove("sparse");
        if (sparse != null && sparse.isObject() && node.path("sparse_top_k").isMissingNode()) {
            node.put("sparse_top_k", sparse.path("topK").asInt(sparse.path("top_k").asInt(20)));
        }
        JsonNode fusion = node.get("fusion");
        if (fusion != null && fusion.isObject()) {
            // {strategy, k} -> "rrf"（k 是 RRF 常数，引擎不支持覆盖，这里直接丢弃）
            node.put("fusion", fusion.path("strategy").asText("rrf"));
        }
        JsonNode rerank = node.get("rerank");
        if (rerank != null && rerank.isObject() && rerank.path("top_n").isMissingNode()) {
            int topN = rerank.path("topN").asInt(8);
            ((com.fasterxml.jackson.databind.node.ObjectNode) rerank).put("top_n", topN);
            ((com.fasterxml.jackson.databind.node.ObjectNode) rerank).remove("topN");
        }
        if (node.path("top_k").isMissingNode() && node.path("rerank").isObject()) {
            node.put("top_k", node.path("rerank").path("top_n").asInt(8));
        }
        node.remove("_source");
        return node.toString();
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ex) {
            return "{}";
        }
    }

    private ProfileView toView(RetrievalProfile profile) {
        return new ProfileView(profile.getId().toString(), profile.getName(), profile.getVersion(),
                profile.getConfig(), Boolean.TRUE.equals(profile.getIsDefault()), profile.getStatus(),
                profile.getUpdatedAt() == null ? null : profile.getUpdatedAt().toString(),
                profile.getDeletedAt() == null ? null : profile.getDeletedAt().toString());
    }

    public record ProfileView(String id, String name, Integer version, String config, boolean isDefault,
                              String status, String updatedAt, String deletedAt) {
    }

    public record RetrievalProfileView(RetrievalProfile profile) {
    }

    public record TraceView(String id, String query, Integer durationMs, String result, String createdAt) {
    }
}