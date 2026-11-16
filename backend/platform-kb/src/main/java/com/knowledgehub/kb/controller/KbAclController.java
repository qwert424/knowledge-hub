package com.knowledgehub.kb.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.kb.entity.Document;
import com.knowledgehub.kb.entity.KbMember;
import com.knowledgehub.kb.entity.KnowledgeBase;
import com.knowledgehub.kb.service.AclService;
import com.knowledgehub.kb.service.DocumentService;
import com.knowledgehub.kb.service.KbService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/** ACL management + preview. Filter computation itself stays in {@link AclService}. */
@RestController
@RequestMapping("/api/v1")
public class KbAclController {

    private final KbService kbService;
    private final DocumentService documentService;
    private final AclService aclService;

    public KbAclController(KbService kbService, DocumentService documentService, AclService aclService) {
        this.kbService = kbService;
        this.documentService = documentService;
        this.aclService = aclService;
    }

    @GetMapping("/kbs/{id}/members")
    @RequirePermission(PermissionCatalog.KB_READ)
    public ApiResponse<List<KbMember>> members(@PathVariable UUID id) {
        return ApiResponse.ok(kbService.members(id));
    }

    @DeleteMapping("/kbs/{id}/members/{memberId}")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Void> removeMember(@PathVariable UUID id, @PathVariable UUID memberId) {
        kbService.removeMember(id, memberId);
        return ApiResponse.ok();
    }

    @PutMapping("/resources/{type}/{id}/acl")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Void> updateAcl(@PathVariable String type, @PathVariable String id,
                                       @RequestBody AclRequest request) {
        java.util.List<KbService.KbAclInput> inputs = request.members() == null ? null
                : request.members().stream()
                        .map(m -> new KbService.KbAclInput(m.principalType(), m.principalId(), m.permission()))
                        .toList();
        kbService.updateAcl(type, UUID.fromString(id), request.visibility(), request.aclMode(), inputs);
        return ApiResponse.ok();
    }

    @PostMapping("/acl/preview")
    @RequirePermission(PermissionCatalog.KB_READ)
    public ApiResponse<AclService.AclResult> preview(@RequestBody AclPreviewRequest request) {
        if ("document".equals(request.type())) {
            Document document = documentService.require(UUID.fromString(request.id()));
            KnowledgeBase kb = kbService.require(document.getKbId().toString());
            return ApiResponse.ok(aclService.resolve(document, kb));
        }
        KnowledgeBase kb = kbService.require(request.id());
        Document probe = new Document();
        probe.setId(UUID.randomUUID());
        probe.setTenantId(kb.getTenantId());
        probe.setKbId(kb.getId());
        probe.setOwnerId(UserContext.require().userId());
        probe.setVisibility("inherit");
        probe.setAclMode("inherit");
        return ApiResponse.ok(aclService.resolve(probe, kb));
    }

    public record MemberInput(String principalType, String principalId, String permission) {
    }

    public record AclRequest(String visibility, String aclMode, List<MemberInput> members) {
    }

    public record AclPreviewRequest(String type, String id) {
    }
}