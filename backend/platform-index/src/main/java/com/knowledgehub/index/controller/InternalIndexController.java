package com.knowledgehub.index.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.security.InternalTokenGuard;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.index.service.IndexJobService;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Worker/engine callbacks carry no user JWT, so the tenant is bound from the job row itself and
 * cleared afterwards. Without this, every callback would fail the tenant guard.
 */
@RestController
@RequestMapping("/internal/v1/index-jobs")
public class InternalIndexController {

    private final IndexJobService jobService;
    private final InternalTokenGuard tokenGuard;

    public InternalIndexController(IndexJobService jobService, InternalTokenGuard tokenGuard) {
        this.jobService = jobService;
        this.tokenGuard = tokenGuard;
    }

    @PostMapping("/{id}/start")
    public ApiResponse<Void> start(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                   @PathVariable UUID id, @RequestBody(required = false) StageRequest request) {
        tokenGuard.require(token);
        withTenant(id, () -> jobService.markRunning(id, request == null ? "parsing" : request.stage()));
        return ApiResponse.ok();
    }

    @PostMapping("/{id}/progress")
    public ApiResponse<Void> progress(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                      @PathVariable UUID id, @RequestBody ProgressRequest request) {
        tokenGuard.require(token);
        withTenant(id, () -> jobService.updateProgress(id, request.stage(), request.progress()));
        return ApiResponse.ok();
    }

    @PostMapping("/{id}/chunks")
    public ApiResponse<Void> chunks(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                    @PathVariable UUID id, @RequestBody ChunkBatch batch) {
        tokenGuard.require(token);
        withTenant(id, () -> jobService.reportChunks(id, batch.chunks()));
        return ApiResponse.ok();
    }

    @PostMapping("/{id}/complete")
    public ApiResponse<Void> complete(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                      @PathVariable UUID id, @RequestBody CompleteRequest request) {
        tokenGuard.require(token);
        withTenant(id, () -> jobService.complete(id, request.chunkCount(), request.tokenCount(),
                request.blockSnapshotKey(), request.chunkSnapshotKey()));
        return ApiResponse.ok();
    }

    @PostMapping("/{id}/fail")
    public ApiResponse<Void> fail(@RequestHeader(value = "X-Internal-Token", required = false) String token,
                                  @PathVariable UUID id, @RequestBody FailRequest request) {
        tokenGuard.require(token);
        withTenant(id, () -> jobService.fail(id, request.errorCode(), request.message()));
        return ApiResponse.ok();
    }

    private void withTenant(UUID jobId, Runnable action) {
        String tenantId = jobService.tenantOf(jobId);
        TenantContext.set(tenantId);
        try {
            action.run();
        } finally {
            TenantContext.clear();
        }
    }

    public record StageRequest(String stage) {
    }

    public record ProgressRequest(String stage, int progress) {
    }

    public record ChunkBatch(List<IndexJobService.ChunkPayload> chunks) {
    }

    public record CompleteRequest(int chunkCount, int tokenCount, String blockSnapshotKey,
                                  String chunkSnapshotKey) {
    }

    public record FailRequest(String errorCode, String message) {
    }
}