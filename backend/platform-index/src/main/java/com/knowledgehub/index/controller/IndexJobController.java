package com.knowledgehub.index.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.index.service.IndexJobService;
import org.springframework.web.bind.annotation.DeleteMapping;
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
@RequestMapping("/api/v1/index-jobs")
@RequirePermission(PermissionCatalog.INDEX_MANAGE)
public class IndexJobController {

    private final IndexJobService jobService;

    public IndexJobController(IndexJobService jobService) {
        this.jobService = jobService;
    }

    @GetMapping
    public ApiResponse<PageResult<IndexJobService.JobView>> list(@RequestParam(required = false) String status,
                                                                 @RequestParam(required = false) String documentId,
                                                                 @RequestParam(defaultValue = "1") long page,
                                                                 @RequestParam(defaultValue = "20") long pageSize) {
        return ApiResponse.ok(jobService.list(status, documentId, page, pageSize));
    }

    @GetMapping("/{id}")
    public ApiResponse<IndexJobService.JobView> get(@PathVariable UUID id) {
        return ApiResponse.ok(jobService.getView(id));
    }

    @PostMapping("/{id}/retry")
    public ApiResponse<Void> retry(@PathVariable UUID id) {
        jobService.retry(id);
        return ApiResponse.ok();
    }

    @PostMapping("/{id}/cancel")
    public ApiResponse<Void> cancel(@PathVariable UUID id) {
        jobService.cancel(id);
        return ApiResponse.ok();
    }

    /** 删除任务记录：只允许已经结束的任务，运行中的先取消再删。 */
    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable UUID id) {
        jobService.delete(id);
        return ApiResponse.ok();
    }

    /** 批量取消（选中多条） */
    @PostMapping("/batch-cancel")
    public ApiResponse<Map<String, Integer>> batchCancel(@RequestBody BatchRequest request) {
        int done = jobService.cancelAll(request.ids());
        return ApiResponse.ok(Map.of("canceled", done));
    }

    /** 批量删除（选中多条） */
    @PostMapping("/batch-delete")
    public ApiResponse<Map<String, Integer>> batchDelete(@RequestBody BatchRequest request) {
        int done = jobService.deleteAll(request.ids());
        return ApiResponse.ok(Map.of("deleted", done));
    }

    public record BatchRequest(List<UUID> ids) {
    }
}