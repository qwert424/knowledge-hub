package com.knowledgehub.index.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.spi.IndexJobCommand;
import com.knowledgehub.common.spi.IndexJobPort;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.index.entity.IndexJob;
import com.knowledgehub.index.entity.OutboxEvent;
import com.knowledgehub.index.mapper.IndexJobMapper;
import com.knowledgehub.index.mapper.OutboxEventMapper;
import com.knowledgehub.kb.entity.ChunkMeta;
import com.knowledgehub.kb.mapper.ChunkMetaMapper;
import com.knowledgehub.kb.service.DocumentService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class IndexJobService implements IndexJobPort {

    public static final String TOPIC_INDEX_JOB = "index.job.created";

    private final IndexJobMapper jobMapper;
    private final OutboxEventMapper outboxMapper;
    private final ChunkMetaMapper chunkMetaMapper;
    private final DocumentService documentService;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;

    public IndexJobService(IndexJobMapper jobMapper, OutboxEventMapper outboxMapper,
                           ChunkMetaMapper chunkMetaMapper, DocumentService documentService,
                           AuditRecorder auditRecorder, ObjectMapper objectMapper) {
        this.jobMapper = jobMapper;
        this.outboxMapper = outboxMapper;
        this.chunkMetaMapper = chunkMetaMapper;
        this.documentService = documentService;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
    }

    @Override
    @Transactional
    public UUID enqueue(IndexJobCommand command) {
        Long running = jobMapper.selectCount(Wrappers.<IndexJob>lambdaQuery()
                .eq(IndexJob::getTenantId, command.tenantId())
                .eq(IndexJob::getDocumentId, command.documentId())
                .in(IndexJob::getStatus, "queued", "running"));
        if (running != null && running > 0) {
            throw new BizException(ErrorCode.INDEX_ALREADY_RUNNING);
        }
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("jobId", "");
        payload.put("documentId", command.documentId().toString());
        payload.put("versionId", command.versionId().toString());
        payload.put("kbId", command.kbId());
        payload.put("objectKey", command.objectKey());
        payload.put("contentHash", command.contentHash());
        payload.put("title", command.title());
        payload.put("collectionName", command.collectionName());
        payload.put("embeddingDim", command.embeddingDim());
        payload.put("visibility", command.visibility());
        // GraphRAG is opt-in per knowledge base: only "curated" KBs pay the extraction cost.
        payload.put("graphEnabled", command.graphEnabled());
        ArrayNode principals = payload.putArray("aclPrincipals");
        command.aclPrincipals().forEach(principals::add);
        ArrayNode tags = payload.putArray("tags");
        if (command.tags() != null) {
            command.tags().forEach(tags::add);
        }
        // 结构坐标：飞书来源才非空；检索侧靠 space_id/node_token/revision_id 限定同文档同版本
        if (command.spaceId() != null && !command.spaceId().isBlank()) {
            payload.put("spaceId", command.spaceId());
        }
        if (command.nodeToken() != null && !command.nodeToken().isBlank()) {
            payload.put("nodeToken", command.nodeToken());
        }
        if (command.revisionId() != null && !command.revisionId().isBlank()) {
            payload.put("revisionId", command.revisionId());
        }

        IndexJob job = new IndexJob();
        job.setId(Ids.uuid7());
        job.setTenantId(command.tenantId());
        job.setDocumentId(command.documentId());
        job.setVersionId(command.versionId());
        job.setJobType(command.jobType());
        job.setStatus("queued");
        job.setStage("queued");
        job.setProgress(0);
        job.setAttempt(0);
        job.setMaxAttempts(3);
        job.setTraceId(command.traceId());
        payload.put("jobId", job.getId().toString());
        job.setPayload(payload.toString());
        job.setCreatedAt(OffsetDateTime.now());
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.insert(job);

        publish(TOPIC_INDEX_JOB, job.getTenantId(), payload.toString());
        return job.getId();
    }

    @Override
    @Transactional
    public void cancel(UUID jobId) {
        IndexJob job = requireJob(jobId);
        job.setStatus("canceled");
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
        auditRecorder.record("index.cancel", "index_job", jobId.toString(), null, null);
    }

    /** ??????????????????????????? */
    @Transactional
    public void delete(UUID jobId) {
        IndexJob job = requireJob(jobId);
        if ("running".equals(job.getStatus()) || "queued".equals(job.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "??????????????");
        }
        jobMapper.deleteById(jobId);
        auditRecorder.record("index.delete", "index_job", jobId.toString(), job.getStatus(), null);
    }

    /** ?????????????????????? */
    @Transactional
    public int cancelAll(List<UUID> ids) {
        int count = 0;
        for (UUID id : ids == null ? List.<UUID>of() : ids) {
            IndexJob job = jobMapper.selectById(id);
            if (job == null || !("queued".equals(job.getStatus()) || "running".equals(job.getStatus()))) {
                continue;
            }
            job.setStatus("canceled");
            job.setUpdatedAt(OffsetDateTime.now());
            jobMapper.updateById(job);
            count++;
        }
        if (count > 0) {
            auditRecorder.record("index.batch.cancel", "index_job", ids.toString(), String.valueOf(count), null);
        }
        return count;
    }

    /** ?????????????????????? */
    @Transactional
    public int deleteAll(List<UUID> ids) {
        int count = 0;
        for (UUID id : ids == null ? List.<UUID>of() : ids) {
            IndexJob job = jobMapper.selectById(id);
            if (job == null || "running".equals(job.getStatus()) || "queued".equals(job.getStatus())) {
                continue;
            }
            jobMapper.deleteById(id);
            count++;
        }
        if (count > 0) {
            auditRecorder.record("index.batch.delete", "index_job", ids.toString(), String.valueOf(count), null);
        }
        return count;
    }

    @Transactional
    public void retry(UUID jobId) {
        IndexJob job = requireJob(jobId);
        if (!"failed".equals(job.getStatus()) && !"canceled".equals(job.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "只有失败或取消的任务可以重试");
        }
        job.setStatus("queued");
        job.setStage("queued");
        job.setProgress(0);
        job.setAttempt(job.getAttempt() + 1);
        job.setErrorCode(null);
        job.setErrorMessage(null);
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
        publish(TOPIC_INDEX_JOB, job.getTenantId(), job.getPayload());
        auditRecorder.record("index.retry", "index_job", jobId.toString(), null, null);
    }

    public PageResult<JobView> list(String status, String documentId, long page, long pageSize) {
        String tenantId = TenantContext.require();
        LambdaQueryWrapper<IndexJob> query = Wrappers.<IndexJob>lambdaQuery()
                .eq(IndexJob::getTenantId, tenantId)
                .orderByDesc(IndexJob::getCreatedAt);
        if (status != null && !status.isBlank()) {
            query.eq(IndexJob::getStatus, status);
        }
        if (documentId != null && !documentId.isBlank()) {
            try {
                query.eq(IndexJob::getDocumentId, UUID.fromString(documentId));
            } catch (IllegalArgumentException ex) {
                throw new BizException(ErrorCode.BAD_REQUEST, "文档 ID 格式不正确");
            }
        }
        Page<IndexJob> result = jobMapper.selectPage(new Page<>(page, pageSize), query);
        return PageResult.of(result.getRecords().stream().map(this::toView).toList(),
                result.getTotal(), page, pageSize);
    }

    @Transactional
    public void markRunning(UUID jobId, String stage) {
        IndexJob job = requireJob(jobId);
        job.setStatus("running");
        // 新一轮任务开始：先清掉这一版已有的切片元数据行，避免重试导致行数翻倍
        // （reportChunks 是分批回调的，不能在那里清）
        removeChunkMeta(job);
        recordStage(job, stage);
        job.setStartedAt(job.getStartedAt() == null ? OffsetDateTime.now() : job.getStartedAt());
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
    }

    @Transactional
    public void updateProgress(UUID jobId, String stage, int progress) {
        IndexJob job = requireJob(jobId);
        if (!java.util.Objects.equals(job.getStage(), stage)) {
            recordStage(job, stage);
        }
        job.setProgress(Math.max(0, Math.min(100, progress)));
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
    }

    @Transactional
    public void reportChunks(UUID jobId, List<ChunkPayload> chunks) {
        IndexJob job = requireJob(jobId);
        if (chunks == null || chunks.isEmpty()) {
            return;
        }
        // 行清理放在 markRunning（任务真正开始时一次性清），这里只负责追加本批
        for (ChunkPayload chunk : chunks) {            ChunkMeta meta = new ChunkMeta();
            meta.setId(Ids.uuid7());
            meta.setTenantId(job.getTenantId());
            meta.setKbId(payloadKbId(job));
            meta.setDocumentId(job.getDocumentId());
            meta.setVersionId(job.getVersionId());
            meta.setChunkIndex(chunk.chunkIndex());
            meta.setBlockId(chunk.blockId());
            meta.setBlockType(chunk.blockType());
            meta.setKind(chunk.kind());
            meta.setBlockParentId(chunk.blockParentId());
            meta.setChunkCount(chunk.chunkCount());
            meta.setTableRowIndex(chunk.tableRowIndex());
            meta.setTitlePath(chunk.titlePath());
            meta.setContentHash(chunk.contentHash());
            meta.setTokenCount(chunk.tokenCount());
            meta.setQualityFlags(chunk.qualityFlags());
            meta.setEnabled(true);
            meta.setMilvusPk(chunk.milvusPk());
            meta.setCreatedAt(OffsetDateTime.now());
            chunkMetaMapper.insert(meta);
        }
    }

    @Transactional
    public void complete(UUID jobId, int chunkCount, int tokenCount, String blockSnapshotKey,
                         String chunkSnapshotKey) {
        IndexJob job = requireJob(jobId);
        if (job.getVersionId() != null) {
            documentService.activateVersion(job.getDocumentId(), job.getVersionId(), chunkCount, tokenCount,
                    blockSnapshotKey, chunkSnapshotKey);
        }
        if (tokenCount > 0) {
            job.setTokenCount(tokenCount);
        }
        flushStage(job, "published");
        job.setStatus("succeeded");
        job.setProgress(100);
        job.setFinishedAt(OffsetDateTime.now());
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
        auditRecorder.record("index.complete", "index_job", jobId.toString(), null, null);
    }

    @Transactional
    public void fail(UUID jobId, String errorCode, String message) {
        IndexJob job = requireJob(jobId);
        job.setStatus("failed");
        job.setErrorCode(errorCode);
        job.setErrorMessage(message);
        job.setFinishedAt(OffsetDateTime.now());
        job.setUpdatedAt(OffsetDateTime.now());
        jobMapper.updateById(job);
        documentService.markFailed(job.getDocumentId(), errorCode, message);
        auditRecorder.record("index.fail", "index_job", jobId.toString(), null, errorCode, "FAILED", errorCode);
    }

    @Transactional
    protected void publish(String topic, String tenantId, String payload) {
        OutboxEvent event = new OutboxEvent();
        event.setTenantId(tenantId);
        event.setTopic(topic);
        event.setPayload(payload);
        event.setStatus("pending");
        event.setRetryCount(0);
        event.setNextAt(OffsetDateTime.now());
        event.setCreatedAt(OffsetDateTime.now());
        outboxMapper.insert(event);
    }

    /** Tenant lookup for background callbacks that carry no JWT. */
    public String tenantOf(UUID jobId) {
        IndexJob job = jobMapper.selectById(jobId);
        if (job == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "索引任务不存在");
        }
        return job.getTenantId();
    }

    public IndexJob requireJob(UUID jobId) {
        String tenantId = TenantContext.get();
        IndexJob job = jobMapper.selectById(jobId);
        if (job == null || (tenantId != null && !tenantId.equals(job.getTenantId()))) {
            throw new BizException(ErrorCode.NOT_FOUND, "索引任务不存在");
        }
        return job;
    }

    /**
     * 清掉这次任务对应的那一版切片元数据行。
     *
     * <p>worker 的 {@code chunks} 回调是按批次的（默认 200 条一批），所以清理只能在任务
     * 真正开始时做一次；放在回调里会把前几批刚写进去的行删掉。旧版本的行在
     * {@code activateVersion} 里清，避免切片表里堆积同一篇文档的多份历史切片。
     */
    private void removeChunkMeta(IndexJob job) {
        if (job.getDocumentId() == null || job.getVersionId() == null) {
            return;
        }
        chunkMetaMapper.delete(Wrappers.<ChunkMeta>lambdaQuery()
                .eq(ChunkMeta::getTenantId, job.getTenantId())
                .eq(ChunkMeta::getDocumentId, job.getDocumentId())
                .eq(ChunkMeta::getVersionId, job.getVersionId()));
    }

    private UUID payloadKbId(IndexJob job) {
        try {
            String kbId = objectMapper.readTree(job.getPayload()).path("kbId").asText();
            return UUID.fromString(kbId);
        } catch (Exception ex) {
            return null;
        }
    }

    /**
     * 记录每个阶段的耗时（毫秒）。前端“为什么这么慢”必须能按阶段回答，
     * 所以这里按阶段名累计，而不是只留一个总耗时。
     */
    private void recordStage(IndexJob job, String stage) {
        if (stage == null || stage.isBlank()) {
            return;
        }
        java.time.OffsetDateTime now = java.time.OffsetDateTime.now();
        com.fasterxml.jackson.databind.node.ObjectNode timings;
        try {
            timings = job.getStageTimings() == null || job.getStageTimings().isBlank()
                    ? objectMapper.createObjectNode()
                    : (com.fasterxml.jackson.databind.node.ObjectNode) objectMapper.readTree(job.getStageTimings());
        } catch (Exception ex) {
            timings = objectMapper.createObjectNode();
        }
        String previous = job.getStage();
        if (previous != null && !previous.isBlank() && !previous.equals(stage)) {
            long startedAt = timings.path(previous + "_start").asLong(0L);
            if (startedAt > 0) {
                long cost = now.toInstant().toEpochMilli() - startedAt;
                timings.put(previous, timings.path(previous).asLong(0L) + cost);
                timings.remove(previous + "_start");
            }
        }
        if (!timings.has(stage + "_start")) {
            timings.put(stage + "_start", now.toInstant().toEpochMilli());
        }
        if (job.getStartedAt() == null) {
            job.setStartedAt(now);
        }
        job.setStageTimings(timings.toString());
        job.setStage(stage);
        job.setUpdatedAt(now);
    }

    private void flushStage(IndexJob job, String finalStage) {
        try {
            com.fasterxml.jackson.databind.node.ObjectNode timings =
                    job.getStageTimings() == null || job.getStageTimings().isBlank()
                            ? objectMapper.createObjectNode()
                            : (com.fasterxml.jackson.databind.node.ObjectNode) objectMapper.readTree(job.getStageTimings());
            String previous = job.getStage();
            if (previous != null && !previous.isBlank()) {
                long startedAt = timings.path(previous + "_start").asLong(0L);
                if (startedAt > 0) {
                    timings.put(previous, timings.path(previous).asLong(0L)
                            + (java.time.OffsetDateTime.now().toInstant().toEpochMilli() - startedAt));
                    timings.remove(previous + "_start");
                }
            }
            job.setStageTimings(timings.toString());
            job.setStage(finalStage);
        } catch (Exception ignored) {
            job.setStage(finalStage);
        }
    }

    public JobView getView(UUID jobId) {
        return toView(requireJob(jobId));
    }

    private JobView toView(IndexJob job) {
        return new JobView(job.getId().toString(), job.getDocumentId().toString(),
                job.getVersionId() == null ? null : job.getVersionId().toString(), job.getJobType(),
                job.getStatus(), job.getStage(), job.getProgress(), job.getAttempt(), job.getErrorCode(),
                job.getErrorMessage(), job.getTraceId(),
                job.getCreatedAt() == null ? null : job.getCreatedAt().toString(),
                job.getFinishedAt() == null ? null : job.getFinishedAt().toString(),
                job.getStageTimings(), job.getTokenCount(), job.getCostUsd(),
                documentTitle(job.getDocumentId().toString()));
    }

    /** 列表里显示文档标题比一串 uuid 有用；文档被删或跨库查不到时留空，前端回落显示 id。 */
    private final java.util.Map<String, String> titleCache = new java.util.concurrent.ConcurrentHashMap<>();

    private String documentTitle(String documentId) {
        if (documentId == null || documentId.isBlank()) {
            return null;
        }
        String cached = titleCache.get(documentId);
        if (cached != null) {
            return cached.isEmpty() ? null : cached;
        }
        try {
            var doc = documentService.findById(UUID.fromString(documentId));
            String title = doc == null ? "" : doc.getTitle();
            if (titleCache.size() > 2000) {
                titleCache.clear();
            }
            titleCache.put(documentId, title == null ? "" : title);
            return title == null || title.isBlank() ? null : title;
        } catch (RuntimeException ex) {
            return null;
        }
    }

    public record JobView(String id, String documentId, String versionId, String jobType, String status,
                          String stage, Integer progress, Integer attempt, String errorCode, String errorMessage,
                          String traceId, String createdAt, String finishedAt, String stageTimings,
                          Integer tokenCount, java.math.BigDecimal costUsd, String documentTitle) {
    }

    public record ChunkPayload(int chunkIndex, String blockId, String blockType, String titlePath,
                               String contentHash, Integer tokenCount, String qualityFlags, String milvusPk,
                               String kind, String blockParentId, Integer chunkCount, Integer tableRowIndex) {
        /** 兼容旧调用：只有基础字段时结构字段留空。 */
        public ChunkPayload(int chunkIndex, String blockId, String blockType, String titlePath,
                            String contentHash, Integer tokenCount, String qualityFlags, String milvusPk) {
            this(chunkIndex, blockId, blockType, titlePath, contentHash, tokenCount, qualityFlags, milvusPk,
                    blockType, null, null, null);
        }
    }
}