package com.knowledgehub.kb.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.kb.service.KbService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/kbs")
public class KbController {

    private final KbService kbService;

    public KbController(KbService kbService) {
        this.kbService = kbService;
    }

    @GetMapping
    @RequirePermission(PermissionCatalog.KB_READ)
    public ApiResponse<PageResult<KbService.KbView>> list(@RequestParam(required = false) String keyword,
                                                          @RequestParam(defaultValue = "1") long page,
                                                          @RequestParam(defaultValue = "20") long pageSize) {
        return ApiResponse.ok(kbService.list(keyword, page, pageSize, UserContext.require()));
    }

    @GetMapping("/{id}")
    @RequirePermission(PermissionCatalog.KB_READ)
    public ApiResponse<KbService.KbView> get(@PathVariable String id) {
        return ApiResponse.ok(kbService.toView(kbService.require(id), UserContext.require()));
    }

    @PostMapping
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<KbService.KbView> create(@Valid @RequestBody CreateKbRequest request) {
        return ApiResponse.ok(kbService.create(request.name(), request.code(), request.description(),
                request.visibility(), request.embeddingModel(), request.embeddingDim(), UserContext.require()));
    }

    @PutMapping("/{id}")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<KbService.KbView> update(@PathVariable UUID id, @RequestBody UpdateKbRequest request) {
        return ApiResponse.ok(kbService.update(id, request.name(), request.description(), request.visibility(),
                request.graphEnabled(), UserContext.require()));
    }

    @GetMapping("/{id}/stats")
    @RequirePermission(PermissionCatalog.KB_READ)
    public ApiResponse<KbService.KbStats> stats(@PathVariable UUID id) {
        return ApiResponse.ok(kbService.stats(id));
    }

    /** 上架 / 下架：下架后用户端无法再检索该库内容。 */
    @PatchMapping("/{id}/status")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<KbService.KbView> updateStatus(@PathVariable UUID id, @RequestBody StatusRequest request) {
        return ApiResponse.ok(kbService.updateStatus(id, request.status(), UserContext.require()));
    }

    @DeleteMapping("/{id}")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Void> delete(@PathVariable UUID id) {
        kbService.softDelete(id);
        return ApiResponse.ok();
    }

    /** 用户端可选知识库：只返回启用且当前用户能读的 */
    @GetMapping("/available")
    public ApiResponse<java.util.List<KbService.KbView>> available() {
        return ApiResponse.ok(kbService.listAvailable(UserContext.require()));
    }

    /** 回收站：列出软删除的知识库 */
    @GetMapping("/deleted")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<java.util.List<KbService.KbView>> deleted() {
        return ApiResponse.ok(kbService.listDeleted(UserContext.require()));
    }

    @PostMapping("/{id}/restore")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<KbService.KbView> restore(@PathVariable UUID id) {
        return ApiResponse.ok(kbService.restore(id));
    }

    /** 彻底删除回收站里的一个库（不可恢复） */
    @DeleteMapping("/{id}/purge")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Void> purge(@PathVariable UUID id) {
        kbService.purgeDeleted(id);
        return ApiResponse.ok();
    }

    /** 清空回收站：有文档的库会被跳过并回传原因 */
    @DeleteMapping("/deleted")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Map<String, Object>> purgeAll() {
        return ApiResponse.ok(kbService.purgeAllDeleted());
    }

    @PostMapping("/{id}/members")
    @RequirePermission(PermissionCatalog.KB_WRITE)
    public ApiResponse<Void> addMember(@PathVariable UUID id, @Valid @RequestBody MemberRequest request) {
        kbService.addMember(id, request.principalType(), request.principalId(), request.permission());
        return ApiResponse.ok();
    }

    public record CreateKbRequest(@NotBlank String name, String code, String description,
                                  String visibility, String embeddingModel, Integer embeddingDim) {
    }

    public record UpdateKbRequest(String name, String description, String visibility, Boolean graphEnabled) {
    }

    public record MemberRequest(@NotBlank String principalType, @NotBlank String principalId, String permission) {
    }

    public record StatusRequest(String status) {
    }
}