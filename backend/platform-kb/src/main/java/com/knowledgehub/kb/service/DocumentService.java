package com.knowledgehub.kb.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.spi.IndexJobCommand;
import com.knowledgehub.common.spi.IndexJobPort;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Hashes;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.common.web.TraceContext;
import com.knowledgehub.integration.feishu.FeishuClient;
import com.knowledgehub.integration.storage.ObjectStorageClient;
import com.knowledgehub.kb.entity.ChunkMeta;
import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.DocumentVersion;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.mapper.ChunkMetaMapper;
import com.knowledgehub.kb.mapper.DocumentMapper;
import com.knowledgehub.kb.mapper.DocumentVersionMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Service
public class DocumentService {

    private static final Set<String> ALLOWED_EXTENSIONS = Set.of(
            "pdf", "docx", "doc", "md", "markdown", "txt", "pptx", "xlsx", "csv", "html", "htm", "json", "png", "jpg", "jpeg");
    private static final long MAX_SIZE_BYTES = 200L * 1024 * 1024;
    private static final DateTimeFormatter REVISION_FORMAT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final DocumentMapper documentMapper;
    private final DocumentVersionMapper versionMapper;
    private final ChunkMetaMapper chunkMapper;
    private final KbService kbService;
    private final AclService aclService;
    private final ObjectStorageClient storage;
    private final ObjectProvider<IndexJobPort> indexJobPort;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;
    private final FeishuClient feishuClient;
    private final com.knowledgehub.integration.feishu.FeishuImageEnricher imageEnricher;
    private final com.knowledgehub.integration.platform.NacosConsoleClient nacosConsole;

    public DocumentService(DocumentMapper documentMapper, DocumentVersionMapper versionMapper,
                           ChunkMetaMapper chunkMapper, KbService kbService, AclService aclService,
                           ObjectStorageClient storage, ObjectProvider<IndexJobPort> indexJobPort,
                           AuditRecorder auditRecorder, ObjectMapper objectMapper, FeishuClient feishuClient,
                           com.knowledgehub.integration.feishu.FeishuImageEnricher imageEnricher,
                           com.knowledgehub.integration.platform.NacosConsoleClient nacosConsole) {
        this.documentMapper = documentMapper;
        this.versionMapper = versionMapper;
        this.chunkMapper = chunkMapper;
        this.kbService = kbService;
        this.aclService = aclService;
        this.storage = storage;
        this.indexJobPort = indexJobPort;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
        this.feishuClient = feishuClient;
        this.imageEnricher = imageEnricher;
        this.nacosConsole = nacosConsole;
    }

    /** 读 Nacos rag_config 里 image_parser.* 的一个值（点号路径），读不到用默认值。 */
    private String imageParserValue(String path, String fallback) {
        try {
            String raw = nacosConsole.rawConfig("rag_config", "deal_pilot").getOrDefault("content", "").toString();
            if (raw.isBlank()) {
                return fallback;
            }
            Object parsed = new org.yaml.snakeyaml.Yaml().load(raw);
            if (!(parsed instanceof Map<?, ?> root)) {
                return fallback;
            }
            Object current = root.get("image_parser");
            for (String part : path.split("\\.")) {
                if (!(current instanceof Map<?, ?> map)) {
                    return fallback;
                }
                current = map.get(part);
            }
            return current == null ? fallback : String.valueOf(current);
        } catch (Exception ex) {
            return fallback;
        }
    }

    /** 图片解析提示词：Nacos prompt 里按名字取，取不到就用内置提示词。 */
    private String imageParserPrompt() {
        try {
            String promptKey = imageParserValue("image_parser_prompt", "");
            if (promptKey.isBlank()) {
                return "";
            }
            Object template = nacosConsole.prompt(promptKey).get("template");
            return template == null ? "" : template.toString();
        } catch (Exception ex) {
            return "";
        }
    }

    /**
     * 从飞书链接直接建档：拉正文 → 落 Markdown 到对象存储 → 建版本 → 入索引队列。
     * 走的是和上传完全相同的后续链路，所以解析/切片/向量化行为一致。
     */
    @Transactional
    public DocumentView importFromFeishu(String kbId, String feishuUrl) {
        return importFromFeishu(kbId, feishuUrl, "", "");
    }

    /** 带飞书目录坐标的导入：从知识空间浏览进来的节点会带 spaceId/nodeToken。 */
    @Transactional
    public DocumentView importFromFeishu(String kbId, String feishuUrl, String feishuSpaceId,
                                         String feishuNodeToken) {
        KnowledgeBase kb = kbService.require(kbId);
        FeishuClient.FeishuDoc doc = feishuClient.fetchDocument(feishuUrl);
        CurrentUser user = UserContext.require();
        String tenantId = TenantContext.require();
        UUID documentId = Ids.uuid7();
        String safeName = doc.title().replaceAll("[\\\\/:*?\"<>|]", "_");
        // 有结构化块就存 blocks JSON（引擎按 blocks_to_ir 还原标题/表格），否则退回 Markdown 纯文本
        boolean structured = doc.blocksJson() != null && !doc.blocksJson().isBlank();
        String extension = structured ? "json" : "md";
        String mimeType = structured ? "application/json" : "text/markdown";
        String objectKey = "%s/%s/%s/%s.%s".formatted(tenantId, kb.getCode(), documentId, safeName, extension);
        String body = structured
                ? imageEnricher.enrich(doc.blocksJson(), tenantId, documentId.toString(),
                        imageParserValue("bucket_name", "feishu-images"),
                        imageParserValue("vl_model_config.name", ""),
                        imageParserPrompt())
                : doc.text();
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        storage.putObject(objectKey, bytes, mimeType);

        ObjectNode metadata = objectMapper.createObjectNode();
        metadata.put("objectKey", objectKey);
        metadata.put("originalFilename", safeName + "." + extension);
        metadata.put("feishuObjType", doc.objType());
        metadata.put("feishuObjToken", doc.objToken());
        metadata.put("feishuStructured", structured);
        // 飞书目录坐标：检索侧用它把"同文档同版本"的块限定在一起
        if (feishuSpaceId != null && !feishuSpaceId.isBlank()) {
            metadata.put("feishuSpaceId", feishuSpaceId);
        }
        if (feishuNodeToken != null && !feishuNodeToken.isBlank()) {
            metadata.put("feishuNodeToken", feishuNodeToken);
        }

        Document document = new Document();
        document.setId(documentId);
        document.setTenantId(tenantId);
        document.setKbId(kb.getId());
        document.setTitle(doc.title());
        document.setSourceType("feishu");
        document.setSourceRef(doc.objToken());
        document.setSourceUrl(doc.url());
        document.setMimeType(mimeType);
        document.setSizeBytes((long) bytes.length);
        document.setVisibility("inherit");
        document.setAclMode("inherit");
        document.setStatus("indexing");
        document.setGraphSelected(false);
        document.setOwnerId(user.userId());
        document.setMetadata(metadata.toString());
        document.setContentHash(Hashes.sha256Hex(doc.objToken() + ":" + bytes.length));
        document.setCreatedAt(OffsetDateTime.now());
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.insert(document);

        DocumentVersion version = new DocumentVersion();
        version.setId(Ids.uuid7());
        version.setTenantId(tenantId);
        version.setDocumentId(document.getId());
        version.setRevision(OffsetDateTime.now().format(REVISION_FORMAT));
        version.setContentHash(document.getContentHash());
        version.setChunkTemplate(kb.getChunkTemplate());
        version.setObjectKey(objectKey);
        version.setChunkCount(0);
        version.setTokenCount(0);
        version.setStatus("staging");
        version.setCreatedAt(OffsetDateTime.now());
        versionMapper.insert(version);

        AclService.AclResult acl = aclService.resolve(document, kb);
        IndexJobPort port = indexJobPort.getIfAvailable();
        if (port == null) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "索引模块未启用");
        }
        UUID jobId = port.enqueue(new IndexJobCommand(document.getTenantId(), document.getId(), version.getId(),
                kb.getId().toString(), "index", objectKey, document.getContentHash(), kb.getDefaultProfileId(),
                TraceContext.current(), document.getTitle(), kb.getCollectionName(), kb.getEmbeddingDim(),
                acl.principals(), acl.visibility(), Boolean.TRUE.equals(kb.getGraphEnabled()),
                parseTags(document.getTags()),
                metadata.path("feishuSpaceId").asText(""),
                metadata.path("feishuNodeToken").asText(doc.objToken()),
                version.getRevision()));
        auditRecorder.record("doc.importFeishu", "document", documentId.toString(), doc.url(), jobId.toString());
        return toView(document, version.getId().toString());
    }

    private void tenantGuard(KnowledgeBase kb) {
        String tenantId = TenantContext.require();
        if (!tenantId.equals(kb.getTenantId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "知识库不存在");
        }
    }

    /** 飞书知识空间列表；未配置飞书时返回空列表 + configured=false。 */
    public List<Map<String, Object>> feishuSpaces() {
        return feishuClient.spaces();
    }

    public List<Map<String, Object>> feishuNodes(String spaceId, String parentToken) {
        return feishuClient.nodes(spaceId, parentToken);
    }

    /**
     * 批量导入：逐条调用单篇导入，单条失败只记录失败原因，不影响其它文档。
     * 前端据此展示"成功 N 篇 / 失败 M 篇"。
     */
    public List<Map<String, Object>> importFeishuBatch(String kbId, List<String> urls) {
        List<Map<String, Object>> results = new java.util.ArrayList<>();
        for (String url : urls) {
            try {
                DocumentView view = importFromFeishu(kbId, url);
                Map<String, Object> row = new java.util.LinkedHashMap<>();
                row.put("url", url);
                row.put("ok", true);
                row.put("documentId", view.id());
                row.put("title", view.title());
                results.add(row);
            } catch (RuntimeException ex) {
                Map<String, Object> row = new java.util.LinkedHashMap<>();
                row.put("url", url);
                row.put("ok", false);
                row.put("error", ex.getMessage());
                results.add(row);
            }
        }
        return results;
    }

    @Transactional
    public UploadIntent uploadIntent(String kbId, String filename, long sizeBytes, String mimeType) {
        KnowledgeBase kb = kbService.require(kbId);
        String extension = extensionOf(filename);
        if (!ALLOWED_EXTENSIONS.contains(extension)) {
            throw new BizException(ErrorCode.UNSUPPORTED_FILE, "不支持的文件类型: " + extension);
        }
        if (sizeBytes > MAX_SIZE_BYTES) {
            throw new BizException(ErrorCode.FILE_TOO_LARGE, "单文件不能超过 200MB");
        }
        CurrentUser user = UserContext.require();
        String tenantId = TenantContext.require();
        UUID documentId = Ids.uuid7();
        String safeName = filename.replaceAll("[\\\\/:*?\"<>|]", "_");
        String objectKey = "%s/%s/%s/%s".formatted(tenantId, kb.getCode(), documentId, safeName);

        ObjectNode metadata = objectMapper.createObjectNode();
        metadata.put("objectKey", objectKey);
        metadata.put("originalFilename", filename);

        Document document = new Document();
        document.setId(documentId);
        document.setTenantId(tenantId);
        document.setKbId(kb.getId());
        document.setTitle(stripExtension(filename));
        document.setSourceType("upload");
        document.setSourceRef(objectKey);
        document.setMimeType(mimeType);
        document.setSizeBytes(sizeBytes);
        document.setVisibility("inherit");
        document.setAclMode("inherit");
        document.setStatus("uploaded");
        document.setGraphSelected(false);
        document.setOwnerId(user.userId());
        document.setMetadata(metadata.toString());
        document.setCreatedAt(OffsetDateTime.now());
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.insert(document);
        auditRecorder.record("doc.uploadIntent", "document", documentId.toString(), null, filename);

        ObjectStorageClient.PresignedUpload presigned = storage.presignUpload(objectKey,
                mimeType == null ? "application/octet-stream" : mimeType);
        return new UploadIntent(documentId.toString(), objectKey, presigned.url(), presigned.expiresIn());
    }

    @Transactional
    public DocumentView commit(UUID documentId, Long sizeBytes, String contentHash) {
        Document document = require(documentId);
        KnowledgeBase kb = kbService.require(document.getKbId().toString());
        String objectKey = objectKeyOf(document);
        String hash = contentHash == null || contentHash.isBlank()
                ? Hashes.sha256Hex(objectKey + ":" + (sizeBytes == null ? 0 : sizeBytes))
                : contentHash;

        DocumentVersion version = new DocumentVersion();
        version.setId(Ids.uuid7());
        version.setTenantId(document.getTenantId());
        version.setDocumentId(document.getId());
        version.setRevision(OffsetDateTime.now().format(REVISION_FORMAT));
        version.setContentHash(hash);
        version.setChunkTemplate(kb.getChunkTemplate());
        version.setObjectKey(objectKey);
        version.setChunkCount(0);
        version.setTokenCount(0);
        version.setStatus("staging");
        version.setCreatedAt(OffsetDateTime.now());
        versionMapper.insert(version);

        document.setContentHash(hash);
        document.setSizeBytes(sizeBytes == null ? document.getSizeBytes() : sizeBytes);
        document.setStatus("indexing");
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);

        AclService.AclResult acl = aclService.resolve(document, kb);
        IndexJobPort port = indexJobPort.getIfAvailable();
        if (port == null) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "索引模块未启用");
        }
        UUID jobId = port.enqueue(new IndexJobCommand(document.getTenantId(), document.getId(), version.getId(),
                kb.getId().toString(), "index", objectKey, hash, kb.getDefaultProfileId(), TraceContext.current(),
                document.getTitle(), kb.getCollectionName(), kb.getEmbeddingDim(), acl.principals(),
                acl.visibility(), Boolean.TRUE.equals(kb.getGraphEnabled()), parseTags(document.getTags())));
        auditRecorder.record("doc.commit", "document", documentId.toString(), null, jobId.toString());
        return toView(document, version.getId().toString());
    }

    @Transactional
    public ReindexOutcome reindex(UUID documentId) {
        return reindex(documentId, false);
    }

    /**
     * 重索引。
     *
     * 幂等：先用「内容哈希 + 切片模板 + 向量模型/维度 + 流水线版本」算指纹，
     * 与当前生效版本一致就不再排队——否则每点一次都重新切片+重新向量化，
     * 既费钱又慢，而且旧版本行还会和新版本重复。需要强制重建传 {@code force=true}。
     */
    @Transactional
    public ReindexOutcome reindex(UUID documentId, boolean force) {
        Document document = require(documentId);
        KnowledgeBase kb = kbService.require(document.getKbId().toString());
        String objectKey = objectKeyOf(document);
        String contentHash = document.getContentHash() == null
                ? Hashes.sha256Hex(objectKey) : document.getContentHash();
        String fingerprint = fingerprintOf(contentHash, kb);
        if (!force && document.getActiveVersionId() != null) {
            DocumentVersion active = versionMapper.selectById(document.getActiveVersionId());
            if (active != null && fingerprint.equals(active.getFingerprint())) {
                return new ReindexOutcome(documentId.toString(), null, true,
                        "内容与切片/向量参数都没有变化，已跳过（毫秒级完成）；需要强制重建请用强制重索引");
            }
        }
        DocumentVersion version = new DocumentVersion();
        version.setId(Ids.uuid7());
        version.setTenantId(document.getTenantId());
        version.setDocumentId(document.getId());
        version.setRevision(OffsetDateTime.now().format(REVISION_FORMAT));
        version.setContentHash(contentHash);
        version.setFingerprint(fingerprint);
        version.setChunkTemplate(kb.getChunkTemplate());
        version.setObjectKey(objectKey);
        version.setChunkCount(0);
        version.setTokenCount(0);
        version.setStatus("staging");
        version.setCreatedAt(OffsetDateTime.now());
        versionMapper.insert(version);
        document.setStatus("indexing");
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);

        AclService.AclResult acl = aclService.resolve(document, kb);
        IndexJobPort port = indexJobPort.getIfAvailable();
        if (port == null) {
            throw new BizException(ErrorCode.INTERNAL_ERROR, "索引模块未启用");
        }
        UUID jobId = port.enqueue(new IndexJobCommand(document.getTenantId(), document.getId(), version.getId(),
                kb.getId().toString(), "reindex", objectKey, version.getContentHash(), kb.getDefaultProfileId(),
                TraceContext.current(), document.getTitle(), kb.getCollectionName(), kb.getEmbeddingDim(),
                acl.principals(), acl.visibility(), Boolean.TRUE.equals(kb.getGraphEnabled()),
                parseTags(document.getTags())));
        auditRecorder.record("doc.reindex", "document", documentId.toString(), null, jobId.toString());
        return new ReindexOutcome(documentId.toString(), jobId.toString(), false, "已提交重索引");
    }

    /**
     * 重索引指纹：内容 + 影响切片/向量的全部参数。
     * 任何一项变了都必须重建（否则会出现"参数改了但检索行为没变"）。
     */
    private String fingerprintOf(String contentHash, KnowledgeBase kb) {
        String raw = String.join("|",
                contentHash == null ? "" : contentHash,
                kb.getChunkTemplate() == null ? "" : kb.getChunkTemplate(),
                kb.getEmbeddingModel() == null ? "" : kb.getEmbeddingModel(),
                String.valueOf(kb.getEmbeddingDim() == null ? 0 : kb.getEmbeddingDim()),
                String.valueOf(kb.getDefaultProfileId()),
                // 解析/切片/入库逻辑变更时也应当重建，用版本号显式表达
                PIPELINE_VERSION);
        return Hashes.sha256Hex(raw);
    }

    /** 切片/入库流水线版本：改了结构字段、切分逻辑就 +1，让历史数据自动失效 */
    private static final String PIPELINE_VERSION = "chunk-structure-v4";

    public record ReindexOutcome(String documentId, String jobId, boolean skipped, String reason) {
    }

    @Transactional
    public void activateVersion(UUID documentId, UUID versionId, int chunkCount, int tokenCount,
                                String blockSnapshotKey, String chunkSnapshotKey) {
        Document document = require(documentId);
        DocumentVersion version = versionMapper.selectById(versionId);
        if (version == null) {
            throw new BizException(ErrorCode.DOC_NOT_FOUND, "文档版本不存在");
        }
        List<DocumentVersion> others = versionMapper.selectList(Wrappers.<DocumentVersion>lambdaQuery()
                .eq(DocumentVersion::getTenantId, document.getTenantId())
                .eq(DocumentVersion::getDocumentId, documentId)
                .ne(DocumentVersion::getId, versionId)
                .eq(DocumentVersion::getStatus, "active"));
        for (DocumentVersion other : others) {
            other.setStatus("superseded");
            versionMapper.updateById(other);
        }
        version.setStatus("active");
        version.setChunkCount(chunkCount);
        version.setTokenCount(tokenCount);
        version.setBlockSnapshotKey(blockSnapshotKey);
        version.setChunkSnapshotKey(chunkSnapshotKey);
        version.setPublishedAt(OffsetDateTime.now());
        versionMapper.updateById(version);

        document.setActiveVersionId(versionId);
        document.setStatus("active");
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);

        // 旧版本的切片元数据是派生数据（快照仍在 MinIO 里留档），留着只会在切片表里
        // 堆积多份同样内容的行。只保留当前生效版本，行数与 chunkCount 对得上。
        chunkMapper.delete(Wrappers.<ChunkMeta>lambdaQuery()
                .eq(ChunkMeta::getTenantId, document.getTenantId())
                .eq(ChunkMeta::getDocumentId, documentId)
                .ne(ChunkMeta::getVersionId, versionId));
    }

    @Transactional
    public void markFailed(UUID documentId, String errorCode, String errorMessage) {
        Document document = require(documentId);
        document.setStatus("failed");
        document.setUpdatedAt(OffsetDateTime.now());
        ObjectNode metadata = objectMapper.createObjectNode();
        if (document.getMetadata() != null && !document.getMetadata().isBlank()) {
            try {
                metadata = (ObjectNode) objectMapper.readTree(document.getMetadata());
            } catch (Exception ignored) {
                // keep an empty metadata object
            }
        }
        metadata.put("lastErrorCode", errorCode == null ? "INDEX_FAILED" : errorCode);
        metadata.put("lastError", errorMessage);
        document.setMetadata(metadata.toString());
        documentMapper.updateById(document);
    }

    public PageResult<DocumentView> list(String kbId, String status, String keyword, long page, long pageSize) {
        String tenantId = TenantContext.require();
        LambdaQueryWrapper<Document> query = Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, tenantId)
                .isNull(Document::getDeletedAt)
                .orderByDesc(Document::getCreatedAt);
        if (kbId != null && !kbId.isBlank()) {
            query.eq(Document::getKbId, UUID.fromString(kbId));
        }
        if (status != null && !status.isBlank()) {
            query.eq(Document::getStatus, status);
        }
        if (keyword != null && !keyword.isBlank()) {
            query.like(Document::getTitle, keyword);
        }
        Page<Document> result = documentMapper.selectPage(new Page<>(page, pageSize), query);
        return PageResult.of(result.getRecords().stream().map(d -> toView(d, null)).toList(),
                result.getTotal(), page, pageSize);
    }

    public DocumentService.DocumentView get(UUID documentId) {
        return toView(require(documentId), null);
    }

    /** 供其它模块按 id 取标题等元信息（索引任务列表用它显示文档名）。 */
    public Document findById(UUID documentId) {
        return documentMapper.selectById(documentId);
    }

    public List<VersionView> versions(UUID documentId) {
        Document document = require(documentId);
        return versionMapper.selectList(Wrappers.<DocumentVersion>lambdaQuery()
                        .eq(DocumentVersion::getTenantId, document.getTenantId())
                        .eq(DocumentVersion::getDocumentId, documentId)
                        .orderByDesc(DocumentVersion::getCreatedAt))
                .stream()
                .map(v -> new VersionView(v.getId().toString(), v.getRevision(), v.getStatus(), v.getChunkCount(),
                        v.getTokenCount(), v.getObjectKey(), v.getContentHash(),
                        v.getPublishedAt() == null ? null : v.getPublishedAt().toString()))
                .toList();
    }

    public List<ChunkView> chunks(UUID documentId, String versionId, long limit) {
        Document document = require(documentId);
        UUID vid = versionId == null || versionId.isBlank()
                ? document.getActiveVersionId()
                : UUID.fromString(versionId);
        if (vid == null) {
            return List.of();
        }
        return chunkMapper.selectList(Wrappers.<ChunkMeta>lambdaQuery()
                        .eq(ChunkMeta::getTenantId, document.getTenantId())
                        .eq(ChunkMeta::getDocumentId, documentId)
                        .eq(ChunkMeta::getVersionId, vid)
                        .orderByAsc(ChunkMeta::getChunkIndex)
                        .last("limit " + Math.min(limit, 500)))
                .stream()
                .map(c -> new ChunkView(c.getId().toString(), c.getChunkIndex(), c.getBlockType(),
                        c.getTitlePath(), c.getTokenCount(), c.getQualityFlags(), c.getMilvusPk(),
                        c.getKind() == null ? c.getBlockType() : c.getKind(),
                        c.getChunkCount(), c.getTableRowIndex(), c.getBlockParentId()))
                .toList();
    }

    @Transactional
    public void softDelete(UUID documentId) {
        Document document = require(documentId);
        document.setDeletedAt(OffsetDateTime.now());
        document.setStatus("offline");
        documentMapper.updateById(document);
        auditRecorder.record("doc.delete", "document", documentId.toString(), document.getTitle(), null);
    }

    /**
     * 「精选」标记：只有标记过的文档才做图谱抽取，由人决定而不是随机采样。
     * 取消标记不会删掉已经抽出来的实体，只是后续重索引不再抽取。
     */
    public void setGraphSelected(UUID documentId, boolean selected) {
        Document document = require(documentId);
        document.setGraphSelected(selected);
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);
        auditRecorder.record(selected ? "doc.graph.select" : "doc.graph.unselect", "document",
                documentId.toString(), document.getTitle(), null);
    }

    public Document require(UUID documentId) {
        String tenantId = TenantContext.require();
        Document document = documentMapper.selectOne(Wrappers.<Document>lambdaQuery()
                .eq(Document::getTenantId, tenantId)
                .eq(Document::getId, documentId)
                .isNull(Document::getDeletedAt));
        if (document == null) {
            throw new BizException(ErrorCode.DOC_NOT_FOUND);
        }
        return document;
    }

    /** 预签名预览：图片/PDF 直接打开；其他类型返回下载链接。 */
    public PreviewTarget preview(UUID documentId) {
        Document document = require(documentId);
        String objectKey = objectKeyOf(document);
        if (objectKey == null || objectKey.isBlank()) {
            throw new BizException(ErrorCode.DOC_NOT_FOUND, "文档没有原始文件");
        }
        String mime = document.getMimeType() == null ? "" : document.getMimeType().toLowerCase();
        String kind = mime.startsWith("image/") ? "image"
                : mime.contains("pdf") ? "pdf"
                : mime.startsWith("text/") || mime.contains("markdown") ? "text" : "binary";
        return new PreviewTarget(storage.presignDownload(objectKey), kind, document.getTitle());
    }

    /** 纯文本原文，最多 200KB。 */
    public TextContent textContent(UUID documentId) {
        Document document = require(documentId);
        String objectKey = objectKeyOf(document);
        if (objectKey == null || objectKey.isBlank()) {
            throw new BizException(ErrorCode.DOC_NOT_FOUND, "文档没有原始文件");
        }
        byte[] bytes = storage.getObject(objectKey);
        boolean truncated = bytes.length > 200 * 1024;
        byte[] slice = truncated ? java.util.Arrays.copyOf(bytes, 200 * 1024) : bytes;
        return new TextContent(new String(slice, java.nio.charset.StandardCharsets.UTF_8), truncated);
    }

    public String objectKeyOf(Document document) {
        try {
            if (document.getMetadata() != null && !document.getMetadata().isBlank()) {
                String key = objectMapper.readTree(document.getMetadata()).path("objectKey").asText(null);
                if (key != null && !key.isBlank()) {
                    return key;
                }
            }
        } catch (Exception ignored) {
            // fall through to sourceRef
        }
        return document.getSourceRef();
    }

    private DocumentView toView(Document document, String pendingVersionId) {
        return new DocumentView(document.getId().toString(), document.getKbId().toString(), document.getTitle(),
                document.getSourceType(), document.getMimeType(), document.getSizeBytes(), document.getStatus(),
                document.getVisibility(), Boolean.TRUE.equals(document.getGraphSelected()),
                document.getActiveVersionId() == null ? null : document.getActiveVersionId().toString(),
                pendingVersionId, document.getCreatedAt() == null ? null : document.getCreatedAt().toString(),
                document.getUpdatedAt() == null ? null : document.getUpdatedAt().toString(),
                parseTags(document.getTags()), document.getSourceUrl());
    }

    /** 文档标签存成 jsonb 数组，读出来给前端和要求索引的 payload 用。 */
    public List<String> parseTags(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            List<?> parsed = objectMapper.readValue(raw, List.class);
            return parsed.stream().map(String::valueOf).filter(tag -> !tag.isBlank()).toList();
        } catch (Exception ex) {
            return List.of();
        }
    }

    private String writeTags(List<String> tags) {
        List<String> cleaned = tags == null ? List.of() : tags.stream()
                .map(tag -> tag == null ? "" : tag.trim())
                .filter(tag -> !tag.isBlank())
                .distinct()
                .limit(32)
                .toList();
        return objectMapperWrite(cleaned);
    }

    private String objectMapperWrite(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ex) {
            return "[]";
        }
    }

    /**
     * 把文档转到另一个知识库：换 kb_id 后必须重建索引（集合名、维度、ACL 都跟着库变）。
     * 删除知识库前先把文档转走，就不会连带丢失内容。
     */
    @Transactional
    public UUID moveToKb(UUID documentId, UUID targetKbId) {
        Document document = require(documentId);
        KnowledgeBase target = kbService.require(targetKbId.toString());
        if (target.getId().equals(document.getKbId())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "文档已经在这个知识库里");
        }
        if (!"active".equals(target.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "目标知识库未上架，无法接收文档");
        }
        String before = document.getKbId().toString();
        document.setKbId(target.getId());
        document.setStatus("indexing");
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);
        // 换库必须强制重建：集合名变了，指纹相同也不能跳过
        ReindexOutcome outcome = reindex(documentId, true);
        auditRecorder.record("doc.move", "document", documentId.toString(), null, target.getName());
        return outcome.jobId() == null ? documentId : UUID.fromString(outcome.jobId());
    }

    /** 标签只影响检索范围收窄，不影响谁能看到文档（那是 ACL）。 */
    @Transactional
    public DocumentView updateTags(UUID documentId, List<String> tags) {        Document document = require(documentId);
        boolean hadTags = !parseTags(document.getTags()).isEmpty();
        document.setTags(writeTags(tags));
        document.setUpdatedAt(OffsetDateTime.now());
        documentMapper.updateById(document);
        auditRecorder.record("doc.updateTags", "document", documentId.toString(), document.getTags(), null);
        // 标签在向量库里是切片字段，改了标签要重建索引才能影响检索过滤。
        if (hadTags || !parseTags(document.getTags()).isEmpty()) {
            // 标签写在向量切片里，必须强制重建才会生效
            reindex(documentId, true);
        }
        return toView(document, null);
    }

    private String extensionOf(String filename) {
        if (filename == null || !filename.contains(".")) {
            return "";
        }
        return filename.substring(filename.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
    }

    private String stripExtension(String filename) {
        if (filename == null) {
            return "untitled";
        }
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    public record PreviewTarget(String url, String kind, String filename) {
    }

    public record TextContent(String text, boolean truncated) {
    }

    public record UploadIntent(String documentId, String objectKey, String uploadUrl, int expiresIn) {
    }

    public record DocumentView(String id, String kbId, String title, String sourceType, String mimeType,
                               Long sizeBytes, String status, String visibility, boolean graphSelected,
                               String activeVersionId, String pendingVersionId, String createdAt,
                               String updatedAt, java.util.List<String> tags, String sourceUrl) {
    }

    public record VersionView(String id, String revision, String status, Integer chunkCount, Integer tokenCount,
                              String objectKey, String contentHash, String publishedAt) {
    }

    public record ChunkView(String id, Integer chunkIndex, String blockType, String titlePath,
                            Integer tokenCount, String qualityFlags, String milvusPk,
                            String kind, Integer chunkCount, Integer tableRowIndex, String blockParentId) {
        /** 兼容旧构造：结构字段缺省时回落到 blockType。 */
        public ChunkView(String id, Integer chunkIndex, String blockType, String titlePath,
                         Integer tokenCount, String qualityFlags, String milvusPk) {
            this(id, chunkIndex, blockType, titlePath, tokenCount, qualityFlags, milvusPk,
                    blockType, null, null, null);
        }
    }
}