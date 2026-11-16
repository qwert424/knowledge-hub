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
import org.springframework.web.bind.annotation.GetMapping;
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
@RequestMapping("/api/v1/eval")
@RequirePermission(PermissionCatalog.EVAL_MANAGE)
public class EvalController {

    private final EvalService evalService;

    public EvalController(EvalService evalService) {
        this.evalService = evalService;
    }

    @GetMapping("/datasets")
    public ApiResponse<List<EvalDataset>> datasets() {
        return ApiResponse.ok(evalService.datasets());
    }

    @PostMapping("/datasets")
    public ApiResponse<EvalDataset> createDataset(@Valid @RequestBody CreateDatasetRequest request) {
        return ApiResponse.ok(evalService.createDataset(request.name(), request.description(), request.kbId()));
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

    @PostMapping("/runs")
    public ApiResponse<Map<String, String>> createRun(@Valid @RequestBody CreateRunRequest request) {
        UUID runId = evalService.createRun(UUID.fromString(request.datasetId()),
                request.profileId() == null || request.profileId().isBlank()
                        ? null : UUID.fromString(request.profileId()));
        return ApiResponse.ok(Map.of("runId", runId.toString()));
    }

    @GetMapping("/runs")
    public ApiResponse<List<EvalRun>> runs(@RequestParam(required = false) String datasetId) {
        return ApiResponse.ok(evalService.runs(datasetId == null || datasetId.isBlank()
                ? null : UUID.fromString(datasetId)));
    }

    public record CreateDatasetRequest(@NotBlank String name, String description, String kbId) {
    }

    public record CreateRunRequest(@NotBlank String datasetId, String profileId) {
    }
}