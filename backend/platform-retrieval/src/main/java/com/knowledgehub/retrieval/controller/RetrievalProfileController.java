package com.knowledgehub.retrieval.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.retrieval.service.RetrievalProfileService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/retrieval-profiles")
public class RetrievalProfileController {

    private final RetrievalProfileService profileService;

    public RetrievalProfileController(RetrievalProfileService profileService) {
        this.profileService = profileService;
    }

    @GetMapping
    public ApiResponse<List<RetrievalProfileService.ProfileView>> list() {
        return ApiResponse.ok(profileService.list());
    }

    @PostMapping
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> create(@Valid @RequestBody CreateRequest request) {
        return ApiResponse.ok(profileService.create(request.name(), request.config()));
    }

    @PutMapping("/{id}")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> update(@PathVariable UUID id,
                                                                   @RequestBody UpdateRequest request) {
        return ApiResponse.ok(profileService.update(id, request.name(), request.config()));
    }

    @PostMapping("/{id}/publish")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> publish(@PathVariable UUID id) {
        return ApiResponse.ok(profileService.publish(id));
    }

    @PostMapping("/{id}/disable")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> disable(@PathVariable UUID id) {
        return ApiResponse.ok(profileService.disable(id));
    }

    /** 删除 = 进回收站（软删除），和知识库保持同一套语义 */
    @DeleteMapping("/{id}")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> delete(@PathVariable UUID id) {
        return ApiResponse.ok(profileService.softDelete(id));
    }

    @GetMapping("/deleted")
    public ApiResponse<List<RetrievalProfileService.ProfileView>> listDeleted() {
        return ApiResponse.ok(profileService.listDeleted());
    }

    @PostMapping("/{id}/restore")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<RetrievalProfileService.ProfileView> restore(@PathVariable UUID id) {
        return ApiResponse.ok(profileService.restore(id));
    }

    @DeleteMapping("/{id}/purge")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<Map<String, Object>> purge(@PathVariable UUID id) {
        profileService.purge(id);
        return ApiResponse.ok(Map.of("id", id.toString(), "purged", true));
    }

    @DeleteMapping("/deleted")
    @RequirePermission(PermissionCatalog.PROFILE_MANAGE)
    public ApiResponse<Map<String, Object>> purgeAllDeleted() {
        return ApiResponse.ok(Map.of("purged", profileService.purgeAllDeleted()));
    }

    @DeleteMapping("/traces")
    public ApiResponse<Map<String, Object>> deleteTraces(@RequestBody TraceDeleteRequest request) {
        return ApiResponse.ok(Map.of("deleted", profileService.deleteTraces(request.ids())));
    }

    @PostMapping("/{id}/test")
    public ApiResponse<JsonNode> test(@PathVariable UUID id, @Valid @RequestBody TestRequest request) {
        return ApiResponse.ok(profileService.test(request.query(), request.kbIds(), id, request.topK(),
                request.tags()));
    }

    @GetMapping("/traces")
    public ApiResponse<List<RetrievalProfileService.TraceView>> traces(
            @RequestParam(defaultValue = "20") int limit) {
        return ApiResponse.ok(profileService.traces(limit));
    }

    public record CreateRequest(@NotBlank String name, String config) {
    }

    public record UpdateRequest(String name, String config) {
    }

    public record TestRequest(@NotBlank String query, List<String> kbIds, Integer topK, List<String> tags) {
        public TestRequest {
            kbIds = kbIds == null ? List.of() : kbIds;
            topK = topK == null ? 8 : topK;
            tags = tags == null ? List.of() : tags;
        }
    }

    public record TraceDeleteRequest(List<UUID> ids) {
    }
}