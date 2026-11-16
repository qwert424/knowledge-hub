package com.knowledgehub.eval.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.eval.entity.EvalCase;
import com.knowledgehub.eval.entity.EvalDataset;
import com.knowledgehub.eval.entity.EvalRun;
import com.knowledgehub.eval.service.EvalService;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
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
@RequestMapping("/api/v1/eval")
@RequirePermission(PermissionCatalog.EVAL_MANAGE)
public class EvalController {

    private final EvalService evalService;

    public EvalController(EvalService evalService) {
        this.evalService = evalService;
    }

    @GetMapping("/datasets")
    public ApiResponse<List<EvalService.DatasetView>> datasets() {
        return ApiResponse.ok(evalService.datasets());
    }

    @PostMapping("/datasets")
    public ApiResponse<EvalService.DatasetView> createDataset(@Valid @RequestBody CreateDatasetRequest request) {
        return ApiResponse.ok(evalService.createDataset(request.name(), request.description(), request.kbIds()));
    }

    @DeleteMapping("/datasets/{id}")
    public ApiResponse<Void> deleteDataset(@PathVariable UUID id) {
        evalService.deleteDataset(id);
        return ApiResponse.ok();
    }

    @GetMapping("/trash")
    public ApiResponse<Map<String, Object>> trash() {
        return ApiResponse.ok(evalService.trash());
    }

    @PostMapping("/datasets/{id}/restore")
    public ApiResponse<Void> restoreDataset(@PathVariable UUID id) {
        evalService.restoreDataset(id);
        return ApiResponse.ok();
    }

    @DeleteMapping("/datasets/{id}/purge")
    public ApiResponse<Void> purgeDataset(@PathVariable UUID id) {
        evalService.purgeDataset(id);
        return ApiResponse.ok();
    }

    @PostMapping("/runs/{id}/restore")
    public ApiResponse<Void> restoreRun(@PathVariable UUID id) {
        evalService.restoreRun(id);
        return ApiResponse.ok();
    }

    @DeleteMapping("/runs/{id}/purge")
    public ApiResponse<Void> purgeRun(@PathVariable UUID id) {
        evalService.purgeRun(id);
        return ApiResponse.ok();
    }

    @DeleteMapping("/trash")
    public ApiResponse<Map<String, Integer>> purgeAll() {
        return ApiResponse.ok(Map.of("purged", evalService.purgeAll()));
    }

    @GetMapping("/datasets/{id}/cases")
    public ApiResponse<List<EvalCase>> cases(@PathVariable UUID id) {
        return ApiResponse.ok(evalService.cases(id));
    }

    @PostMapping("/datasets/{id}/cases")
    public ApiResponse<Map<String, Integer>> addCases(@PathVariable UUID id,
                                                      @RequestBody List<EvalService.CaseInput> cases) {
        return ApiResponse.ok(Map.of("added", evalService.addCases(id, cases)));
    }

    @PutMapping("/datasets/{id}/cases/{caseId}")
    public ApiResponse<Void> updateCase(@PathVariable UUID id, @PathVariable UUID caseId,
                                        @RequestBody EvalService.CaseInput input) {
        evalService.updateCase(id, caseId, input);
        return ApiResponse.ok();
    }

    @DeleteMapping("/datasets/{id}/cases/{caseId}")
    public ApiResponse<Void> deleteCase(@PathVariable UUID id, @PathVariable UUID caseId) {
        evalService.deleteCase(id, caseId);
        return ApiResponse.ok();
    }

    @PostMapping("/runs")
    public ApiResponse<Map<String, Object>> createRun(@Valid @RequestBody CreateRunRequest request) {
        UUID profileId = request.profileId() == null || request.profileId().isBlank()
                ? null : UUID.fromString(request.profileId());
        // 兼容两种入参：单个 datasetId，或 datasetIds 数组（同一策略批量跑多个数据集）
        List<UUID> datasetIds = new java.util.ArrayList<>();
        if (request.datasetIds() != null) {
            request.datasetIds().stream().filter(id -> id != null && !id.isBlank())
                    .map(UUID::fromString).forEach(datasetIds::add);
        }
        if (datasetIds.isEmpty()) {
            if (request.datasetId() == null || request.datasetId().isBlank()) {
                throw new com.knowledgehub.common.error.BizException(
                        com.knowledgehub.common.error.ErrorCode.BAD_REQUEST, "请选择至少一个数据集");
            }
            datasetIds.add(UUID.fromString(request.datasetId()));
        }
        List<UUID> runIds = evalService.createRuns(datasetIds, profileId);
        return ApiResponse.ok(Map.of("runIds", runIds.stream().map(UUID::toString).toList()));
    }

    @PostMapping("/runs/{id}/cancel")
    public ApiResponse<Void> cancelRun(@PathVariable UUID id) {
        evalService.cancelRun(id);
        return ApiResponse.ok();
    }

    @DeleteMapping("/runs/{id}")
    public ApiResponse<Void> deleteRun(@PathVariable UUID id) {
        evalService.deleteRun(id);
        return ApiResponse.ok();
    }

    @GetMapping("/runs")
    public ApiResponse<List<EvalRun>> runs(@RequestParam(required = false) String datasetId) {
        return ApiResponse.ok(evalService.runs(datasetId == null || datasetId.isBlank()
                ? null : UUID.fromString(datasetId)));
    }

    public record CreateDatasetRequest(@NotBlank String name, String description, List<String> kbIds) {
        public CreateDatasetRequest {
            kbIds = kbIds == null ? List.of() : kbIds;
        }
    }

    public record CreateRunRequest(String datasetId, String profileId, List<String> datasetIds) {
    }
}