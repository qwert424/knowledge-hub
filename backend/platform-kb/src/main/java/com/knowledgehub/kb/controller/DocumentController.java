package com.knowledgehub.kb.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.kb.service.DocumentService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/documents")
public class DocumentController {

    private final DocumentService documentService;

    public DocumentController(DocumentService documentService) {
        this.documentService = documentService;
    }

    @PostMapping("/upload-intent")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<DocumentService.UploadIntent> uploadIntent(@Valid @RequestBody UploadIntentRequest request) {
        return ApiResponse.ok(documentService.uploadIntent(request.kbId(), request.filename(),
                request.sizeBytes(), request.mimeType()));
    }

    @PostMapping("/{id}/commit")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<DocumentService.DocumentView> commit(@PathVariable UUID id,
                                                            @RequestBody(required = false) CommitRequest request) {
        CommitRequest payload = request == null ? new CommitRequest(null, null) : request;
        return ApiResponse.ok(documentService.commit(id, payload.sizeBytes(), payload.contentHash()));
    }

    /** 从飞书文档链接直接建档（拉正文 → Markdown → 索引）。 */
    @PostMapping("/import-feishu")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<DocumentService.DocumentView> importFeishu(@Valid @RequestBody ImportFeishuRequest request) {
        return ApiResponse.ok(documentService.importFromFeishu(request.kbId(), request.url(),
                request.spaceId(), request.nodeToken()));
    }

    /** 飞书知识空间目录：让管理员直接勾选文档批量导入，不用一条条贴链接。 */
    @GetMapping("/feishu/spaces")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<List<Map<String, Object>>> feishuSpaces() {
        return ApiResponse.ok(documentService.feishuSpaces());
    }

    @GetMapping("/feishu/spaces/{spaceId}/nodes")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<List<Map<String, Object>>> feishuNodes(@PathVariable String spaceId,
                                                              @RequestParam(required = false) String parentToken) {
        return ApiResponse.ok(documentService.feishuNodes(spaceId, parentToken));
    }

    /** 批量导入：逐个拉取，失败的不影响其它文档，返回每条结果。 */
    @PostMapping("/import-feishu/batch")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<List<Map<String, Object>>> importFeishuBatch(@Valid @RequestBody BatchImportRequest request) {
        return ApiResponse.ok(documentService.importFeishuBatch(request.kbId(), request.urls()));
    }

    @GetMapping
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<PageResult<DocumentService.DocumentView>> list(
            @RequestParam(required = false) String kbId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long pageSize) {
        return ApiResponse.ok(documentService.list(kbId, status, keyword, page, pageSize));
    }

    @GetMapping("/{id}")
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<DocumentService.DocumentView> get(@PathVariable UUID id) {
        return ApiResponse.ok(documentService.get(id));
    }

    @GetMapping("/{id}/versions")
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<List<DocumentService.VersionView>> versions(@PathVariable UUID id) {
        return ApiResponse.ok(documentService.versions(id));
    }

    @GetMapping("/{id}/chunks")
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<List<DocumentService.ChunkView>> chunks(@PathVariable UUID id,
                                                               @RequestParam(required = false) String versionId,
                                                               @RequestParam(defaultValue = "200") long limit) {
        return ApiResponse.ok(documentService.chunks(id, versionId, limit));
    }

    /** 原文预览：PDF/图片直接给预签名 URL，浏览器新窗口打开即可。 */
    @GetMapping("/{id}/preview-url")
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<Map<String, String>> previewUrl(@PathVariable UUID id) {
        DocumentService.PreviewTarget target = documentService.preview(id);
        return ApiResponse.ok(Map.of("url", target.url(), "kind", target.kind(), "filename", target.filename()));
    }

    /** Markdown / 纯文本原文，供前端自行渲染。 */
    @GetMapping("/{id}/content")
    @RequirePermission(PermissionCatalog.DOC_READ)
    public ApiResponse<Map<String, String>> content(@PathVariable UUID id) {
        DocumentService.TextContent text = documentService.textContent(id);
        return ApiResponse.ok(Map.of("text", text.text(), "truncated", String.valueOf(text.truncated())));
    }

    @PostMapping("/{id}/reindex")
    @RequirePermission(PermissionCatalog.INDEX_MANAGE)
    public ApiResponse<DocumentService.ReindexOutcome> reindex(
            @PathVariable UUID id,
            @RequestParam(defaultValue = "false") boolean force) {
        return ApiResponse.ok(documentService.reindex(id, force));
    }

    @DeleteMapping("/{id}")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<Void> delete(@PathVariable UUID id) {
        documentService.softDelete(id);
        return ApiResponse.ok();
    }

    /** 文档标签：写入向量库切片字段，检索时可用于收窄范围（不是 ACL）。 */
    @PatchMapping("/{id}/tags")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<DocumentService.DocumentView> updateTags(@PathVariable UUID id,
                                                               @RequestBody TagsRequest request) {
        return ApiResponse.ok(documentService.updateTags(id, request.tags()));
    }

    /** 「精选」标记：只有标记的文档才做图谱抽取（人工控制，不随机抽样） */
    @PatchMapping("/{id}/graph-selection")
    @RequirePermission(PermissionCatalog.GRAPH_MANAGE)
    public ApiResponse<Void> selectForGraph(@PathVariable UUID id, @RequestBody GraphSelectionRequest request) {
        documentService.setGraphSelected(id, Boolean.TRUE.equals(request.selected()));
        return ApiResponse.ok();
    }

    /** 转移知识库：换库后自动重建索引（删除知识库前用它把文档挪走）。 */
    @PatchMapping("/{id}/kb")
    @RequirePermission(PermissionCatalog.DOC_WRITE)
    public ApiResponse<Map<String, Object>> moveToKb(@PathVariable UUID id, @Valid @RequestBody MoveKbRequest request) {
        java.util.UUID jobId = documentService.moveToKb(id, java.util.UUID.fromString(request.kbId()));
        return ApiResponse.ok(Map.of("jobId", jobId.toString()));
    }

    public record MoveKbRequest(@NotBlank String kbId) {
    }

    public record GraphSelectionRequest(Boolean selected) {
    }

    public record TagsRequest(java.util.List<String> tags) {
    }

    public record UploadIntentRequest(@NotBlank String kbId, @NotBlank String filename,
                                      @NotNull Long sizeBytes, String mimeType) {
    }

    public record ImportFeishuRequest(@NotBlank String kbId, @NotBlank String url, String spaceId,
                                      String nodeToken) {
    }

    public record BatchImportRequest(@NotBlank String kbId, java.util.List<String> urls) {
        public BatchImportRequest {
            urls = urls == null ? java.util.List.of() : urls;
        }
    }

    public record CommitRequest(Long sizeBytes, String contentHash) {
    }

    public record ReindexResponse(String jobId, Boolean skipped, String reason) {
        /** 兼容旧前端：只读 jobId。 */
        public ReindexResponse(String jobId) {
            this(jobId, false, null);
        }
    }
}