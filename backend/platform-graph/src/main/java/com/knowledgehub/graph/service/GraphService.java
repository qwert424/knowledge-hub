package com.knowledgehub.graph.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.graph.entity.GraphDocument;
import com.knowledgehub.graph.mapper.GraphDocumentMapper;
import com.knowledgehub.integration.engine.RagEngineClient;
import com.knowledgehub.iam.service.RetrievalTicketService;
import com.knowledgehub.kb.service.DocumentService;
import com.knowledgehub.kb.service.KbService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class GraphService {

    private static final Logger log = LoggerFactory.getLogger(GraphService.class);

    private final GraphDocumentMapper graphDocumentMapper;
    private final RagEngineClient engine;
    private final RetrievalTicketService ticketService;
    private final AuditRecorder auditRecorder;
    private final DocumentService documentService;
    private final KbService kbService;
    /** 单实例部署，kbId -> 是否已请求取消；抽取循环每轮检查一次 */
    private final java.util.concurrent.ConcurrentMap<String, Boolean> cancelFlags =
            new java.util.concurrent.ConcurrentHashMap<>();

    public GraphService(GraphDocumentMapper graphDocumentMapper, RagEngineClient engine,
                        RetrievalTicketService ticketService, AuditRecorder auditRecorder,
                        DocumentService documentService, KbService kbService) {
        this.graphDocumentMapper = graphDocumentMapper;
        this.engine = engine;
        this.ticketService = ticketService;
        this.auditRecorder = auditRecorder;
        this.documentService = documentService;
        this.kbService = kbService;
    }

    public List<GraphDocument> list(String kbId) {
        List<GraphDocument> rows = graphDocumentMapper.selectList(Wrappers.<GraphDocument>lambdaQuery()
                .eq(GraphDocument::getTenantId, TenantContext.require())
                .eq(kbId != null && !kbId.isBlank(), GraphDocument::getKbId,
                        kbId == null || kbId.isBlank() ? null : UUID.fromString(kbId))
                .orderByDesc(GraphDocument::getUpdatedAt));
        return heal(rows);
    }

    /**
     * 列表自愈两件事：
     * 1) 同一文档的多条精选记录（历史并发写入留下的）只保留最新一条，其余删掉；
     * 2) 「抽取中」是构建期间的中间态，上一次构建如果因为向量库/Neo4j 挂了没走到收尾，
     *    状态会永远停在 building。超过 15 分钟一律按"待抽取"处理。
     */
    private List<GraphDocument> heal(List<GraphDocument> rows) {
        Map<String, GraphDocument> latest = new java.util.LinkedHashMap<>();
        List<GraphDocument> duplicates = new java.util.ArrayList<>();
        for (GraphDocument row : rows) {
            String key = row.getKbId() + ":" + row.getDocumentId();
            GraphDocument kept = latest.get(key);
            if (kept == null) {
                latest.put(key, row);
            } else {
                duplicates.add(row);
            }
        }
        for (GraphDocument duplicate : duplicates) {
            graphDocumentMapper.deleteById(duplicate.getId());
        }
        OffsetDateTime cutoff = OffsetDateTime.now().minusMinutes(15);
        for (GraphDocument row : latest.values()) {
            if ("building".equals(row.getStatus())
                    && row.getUpdatedAt() != null
                    && row.getUpdatedAt().isBefore(cutoff)) {
                row.setStatus("selected");
                row.setLastError("上次构建没有正常结束，已重置为待抽取，请重新构建");
                row.setUpdatedAt(OffsetDateTime.now());
                graphDocumentMapper.updateById(row);
            }
        }
        return new java.util.ArrayList<>(latest.values());
    }

    @Transactional
    public GraphDocument select(String kbId, String documentId) {
        String tenantId = TenantContext.require();
        GraphDocument existing = graphDocumentMapper.selectOne(Wrappers.<GraphDocument>lambdaQuery()
                .eq(GraphDocument::getTenantId, tenantId)
                .eq(GraphDocument::getDocumentId, UUID.fromString(documentId)));
        if (existing != null) {
            return existing;
        }
        GraphDocument document = new GraphDocument();
        document.setId(Ids.uuid7());
        document.setTenantId(tenantId);
        document.setKbId(UUID.fromString(kbId));
        document.setDocumentId(UUID.fromString(documentId));
        document.setStatus("selected");
        document.setEntityCount(0);
        document.setRelationCount(0);
        document.setCreatedAt(OffsetDateTime.now());
        document.setUpdatedAt(OffsetDateTime.now());
        graphDocumentMapper.insert(document);
        auditRecorder.record("graph.select", "document", documentId, null, kbId);
        return document;
    }

    /**
     * 取消精选：删掉精选记录，文档不再进入图谱抽取。
     *
     * <p>已经抽出来的实体/关系留在 Neo4j 里（重建图谱时才清理），
     * 因为删实体是不可逆操作，误点一下不该把知识图谱打散。
     */
    public void unselect(String kbId, String documentId) {
        String tenantId = TenantContext.require();
        UUID docId = UUID.fromString(documentId);
        graphDocumentMapper.delete(Wrappers.<GraphDocument>lambdaQuery()
                .eq(GraphDocument::getTenantId, tenantId)
                .eq(GraphDocument::getDocumentId, docId));
        documentServiceUnselect(docId);
        auditRecorder.record("graph.unselect", "document", documentId, kbId, null);
    }

    /** 文档上的 graph_selected 标记也要跟着清掉，否则索引时还会抽一次 */
    private void documentServiceUnselect(UUID documentId) {
        try {
            documentService.setGraphSelected(documentId, false);
        } catch (RuntimeException ex) {
            // 文档可能已被删除：精选记录已经清掉就够了
            log.debug("clear graph_selected failed for {}: {}", documentId, ex.getMessage());
        }
    }

    /**
     * 触发图谱构建。
     *
     * <p>以前只传 kbId + documentIds，引擎拿不到切片正文，直接回 not_implemented，
     * 界面上就成了"点了成功但什么都没有"。现在把集合名一起传下去（引擎回 Milvus 读切片），
     * 并把引擎返回的每篇统计写回 graph_document：状态从 building 落到 extracted/failed，
     * 实体数/关系数也一起存，列表和统计卡才有东西可看。
     */
    public Map<String, Object> build(String kbId) {
        return build(kbId, false);
    }

    /**
     * @param onlyMissing true = 只处理「待抽取 / 失败」的文档（增量，默认）
     *                    false = 连已抽取的也重建（模型或提示词变了时用）
     */
    public Map<String, Object> build(String kbId, boolean onlyMissing) {
        List<GraphDocument> selected = list(kbId);
        if (onlyMissing) {
            // 只处理真正可以抽的：待抽取 / 失败 / 卡住的。
            // skipped 是「没有可用切片」的终态，再抽也是白抽。
            selected = selected.stream()
                    .filter(d -> !"extracted".equals(d.getStatus()) && !"skipped".equals(d.getStatus()))
                    .toList();
            if (selected.isEmpty()) {
                Map<String, Object> payload = new java.util.LinkedHashMap<>();
                payload.put("documents", 0);
                payload.put("chunks", 0);
                payload.put("entities", 0);
                payload.put("relations", 0);
                payload.put("status", "ok");
                payload.put("reason", "全部文档都已抽取，没有需要重建的（需要全量重建请取消勾选「只处理未抽取」）");
                return payload;
            }
        }
        // 同一个文档可能因为历史原因有多条精选记录：去重后再送引擎，否则会重复抽取
        List<String> documentIds = selected.stream()
                .map(d -> d.getDocumentId().toString())
                .distinct()
                .toList();
        if (documentIds.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "这个知识库还没有精选文档，先在上表勾选要抽取的文档");
        }
        String collection = kbService.require(kbId).getCollectionName();
        // 同步抽取会让请求挂很久，前端看不到「一篇篇完成」；
        // 这里改成丢给后台线程，接口立刻返回，状态由前端轮询。
        cancelFlags.put(kbId, false);
        auditRecorder.record("graph.build", "kb", kbId, null, "开始抽取文档 " + documentIds.size() + " 篇");
        final List<GraphDocument> buildRows = List.copyOf(selected);
        final List<String> buildIds = List.copyOf(documentIds);
        final String buildCollection = collection == null ? "" : collection;
        Thread.startVirtualThread(() -> runBuild(kbId, buildRows, buildIds, buildCollection));
        Map<String, Object> started = new java.util.LinkedHashMap<>();
        started.put("documents", documentIds.size());
        started.put("started", true);
        started.put("status", "running");
        started.put("reason", "已开始抽取，状态会在下表自动刷新");
        return started;
    }

    /** 后台线程：逐篇抽取，每完成一篇就写一次状态。 */
    private void runBuild(String kbId, List<GraphDocument> selected, List<String> documentIds, String collection) {
        int totalChunks = 0;
        int totalEntities = 0;
        int totalRelations = 0;
        int done = 0;
        int cancelled = 0;
        String firstError = "";
        try {
            for (String documentId : documentIds) {
                if (Boolean.TRUE.equals(cancelFlags.get(kbId))) {
                    cancelled = documentIds.size() - done;
                    break;
                }
                List<GraphDocument> rows = selected.stream()
                        .filter(d -> d.getDocumentId().toString().equals(documentId))
                        .toList();
                markStatus(rows, "building", null, null);
                JsonNode result;
                try {
                    result = engine.buildGraph(Map.of(
                            "kb_id", kbId,
                            "document_ids", List.of(documentId),
                            "mode", "incremental",
                            "collection_name", collection == null ? "" : collection));
                } catch (RuntimeException ex) {
                    markStatus(rows, "failed", null, ex.getMessage());
                    if (firstError.isEmpty()) {
                        firstError = ex.getMessage() == null ? "抽取失败" : ex.getMessage();
                    }
                    done++;
                    continue;
                }
                JsonNode stats = null;
                for (JsonNode item : result.path("documents")) {
                    if (item.path("doc_id").asText("").equals(documentId)) {
                        stats = item;
                        break;
                    }
                }
                totalChunks += result.path("chunk_count").asInt(0);
                totalEntities += result.path("entity_count").asInt(0);
                totalRelations += result.path("relation_count").asInt(0);
                for (GraphDocument document : rows) {
                    if (stats == null) {
                        document.setStatus("skipped");
                        document.setLastError("没有可用切片，先在「文档」里重建索引再抽取");
                    } else if ("failed".equals(stats.path("status").asText())) {
                        document.setStatus("failed");
                        document.setLastError(stats.path("reason").asText("抽取失败"));
                        if (firstError.isEmpty()) {
                            firstError = stats.path("reason").asText("抽取失败");
                        }
                    } else if ("skipped".equals(stats.path("status").asText())) {
                        document.setStatus("skipped");
                        document.setLastError("没有可用切片");
                    } else {
                        document.setStatus("extracted");
                        document.setEntityCount(stats.path("entities").asInt(0));
                        document.setRelationCount(stats.path("relations").asInt(0));
                        document.setLastError(null);
                    }
                    document.setUpdatedAt(OffsetDateTime.now());
                    graphDocumentMapper.updateById(document);
                }
                done++;
            }
        } catch (RuntimeException ex) {
            log.warn("graph build aborted for kb {}: {}", kbId, ex.getMessage());
            if (firstError.isEmpty()) {
                firstError = ex.getMessage();
            }
        } finally {
            if (cancelled > 0) {
                List<GraphDocument> left = selected.stream()
                        .filter(d -> !"extracted".equals(d.getStatus())
                                && !"failed".equals(d.getStatus())
                                && !"skipped".equals(d.getStatus()))
                        .toList();
                markStatus(left, "selected", null, null);
            }
            cancelFlags.remove(kbId);
            auditRecorder.record("graph.build", "kb", kbId, null,
                    "完成 " + done + "/" + documentIds.size() + " 篇，实体 " + totalEntities
                            + "，关系 " + totalRelations
                            + (cancelled > 0 ? "（已取消剩余 " + cancelled + " 篇）" : "")
                            + (firstError.isEmpty() ? "" : "，失败：" + firstError));
        }
    }

    /** 取消进行中的抽取：当前文档抽完后不再继续下一篇。 */
    public Map<String, Object> cancel(String kbId) {
        boolean running = cancelFlags.containsKey(kbId);
        cancelFlags.put(kbId, true);
        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("kbId", kbId);
        payload.put("cancelling", running);
        payload.put("reason", running ? "已通知停止，当前文档抽完后就会停" : "当前没有正在运行的抽取任务");
        return payload;
    }

    private void markStatus(List<GraphDocument> documents, String status, Integer entities, String error) {
        for (GraphDocument document : documents) {
            document.setStatus(status);
            if (entities != null) {
                document.setEntityCount(entities);
            }
            document.setLastError(error);
            document.setUpdatedAt(OffsetDateTime.now());
            graphDocumentMapper.updateById(document);
        }
    }

    /** 图谱总览：精选/已抽取文档数与实体、关系总数，首页卡片直接读它 */
    public Map<String, Object> summary(String kbId) {
        List<GraphDocument> rows = list(kbId);
        int selected = rows.size();
        int extracted = (int) rows.stream().filter(d -> "extracted".equals(d.getStatus())).count();
        int failed = (int) rows.stream().filter(d -> "failed".equals(d.getStatus())).count();
        int entities = rows.stream().mapToInt(d -> d.getEntityCount() == null ? 0 : d.getEntityCount()).sum();
        int relations = rows.stream().mapToInt(d -> d.getRelationCount() == null ? 0 : d.getRelationCount()).sum();
        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("selected", selected);
        payload.put("extracted", extracted);
        payload.put("failed", failed);
        payload.put("entities", entities);
        payload.put("relations", relations);
        return payload;
    }

    public JsonNode query(String kbId, String query, int hops) {
        var user = UserContext.require();
        String ticket = ticketService.issue(user, List.of(UUID.fromString(kbId)));
        return engine.graphQuery(Map.of("ticket", ticket, "kb_ids", List.of(kbId), "query", query,
                "hops", hops, "include_communities", true));
    }
}