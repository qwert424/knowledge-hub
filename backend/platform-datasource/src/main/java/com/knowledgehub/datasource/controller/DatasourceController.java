package com.knowledgehub.datasource.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.datasource.entity.SyncRun;
import com.knowledgehub.datasource.service.DatasourceService;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/datasources")
@RequirePermission(PermissionCatalog.DATASOURCE_MANAGE)
public class DatasourceController {

    private final DatasourceService datasourceService;

    public DatasourceController(DatasourceService datasourceService) {
        this.datasourceService = datasourceService;
    }

    @GetMapping
    public ApiResponse<List<DatasourceService.DatasourceView>> list() {
        return ApiResponse.ok(datasourceService.list());
    }

    @PostMapping
    public ApiResponse<DatasourceService.DatasourceView> create(@Valid @RequestBody CreateRequest request) {
        return ApiResponse.ok(datasourceService.create(request.kbId(), request.type(), request.name(),
                request.config(), request.secret()));
    }

    @PostMapping("/{id}/test")
    public ApiResponse<Map<String, String>> test(@PathVariable UUID id) {
        return ApiResponse.ok(Map.of("result", datasourceService.test(id)));
    }

    @PostMapping("/{id}/sync")
    public ApiResponse<Map<String, String>> sync(@PathVariable UUID id) {
        return ApiResponse.ok(Map.of("syncRunId", datasourceService.sync(id).toString()));
    }

    @GetMapping("/{id}/runs")
    public ApiResponse<List<SyncRun>> runs(@PathVariable UUID id) {
        return ApiResponse.ok(datasourceService.runs(id));
    }

    public record CreateRequest(@NotBlank String kbId, @NotBlank String type, @NotBlank String name,
                                Map<String, Object> config, String secret) {
    }
}