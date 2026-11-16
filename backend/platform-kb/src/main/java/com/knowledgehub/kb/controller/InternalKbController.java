package com.knowledgehub.kb.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.KhSecurityProperties;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.service.AclService;
import com.knowledgehub.kb.service.DocumentService;
import com.knowledgehub.kb.service.KbService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;

/** Internal endpoints used by the Python engine and worker. */
@RestController
@RequestMapping("/internal/v1")
public class InternalKbController {

    private final KbService kbService;
    private final DocumentService documentService;
    private final AclService aclService;
    private final KhSecurityProperties securityProperties;

    public InternalKbController(KbService kbService, DocumentService documentService, AclService aclService,
                                KhSecurityProperties securityProperties) {
        this.kbService = kbService;
        this.documentService = documentService;
        this.aclService = aclService;
        this.securityProperties = securityProperties;
    }

    @GetMapping("/kbs/{id}")
    public ApiResponse<KbDetail> kb(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                    @PathVariable String id) {
        requireInternalToken(token);
        KnowledgeBase kb = kbService.require(id);
        return ApiResponse.ok(new KbDetail(kb.getId().toString(), kb.getTenantId(), kb.getCode(), kb.getName(),
                kb.getEmbeddingModel(), kb.getEmbeddingDim(), kb.getCollectionName(), kb.getChunkTemplate(),
                Boolean.TRUE.equals(kb.getGraphEnabled())));
    }

    @GetMapping("/documents/{id}/acl")
    public ApiResponse<AclPayload> acl(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                       @PathVariable String id) {
        requireInternalToken(token);
        Document document = documentService.require(UUID.fromString(id));
        KnowledgeBase kb = kbService.require(document.getKbId().toString());
        AclService.AclResult acl = aclService.resolve(document, kb);
        return ApiResponse.ok(new AclPayload(document.getId().toString(), acl.principals(), acl.visibility()));
    }

    @PostMapping("/tenants/{tenantId}/context")
    public ApiResponse<Void> bindTenant(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                        @PathVariable String tenantId,
                                        @RequestBody(required = false) Map<String, Object> body) {
        requireInternalToken(token);
        TenantContext.set(tenantId);
        return ApiResponse.ok();
    }

    private void requireInternalToken(String token) {
        String expected = securityProperties.getInternalToken();
        if (expected == null || expected.isBlank()) {
            return;
        }
        if (token == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8))) {
            throw new BizException(ErrorCode.AUTH_403, "内部服务令牌无效");
        }
    }

    public record KbDetail(String id, String tenantId, String code, String name, String embeddingModel,
                           Integer embeddingDim, String collectionName, String chunkTemplate,
                           boolean graphEnabled) {
    }

    public record AclPayload(String documentId, java.util.List<String> principals, String visibility) {
    }
}