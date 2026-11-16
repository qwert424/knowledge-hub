package com.knowledgehub.chat.controller;

import com.knowledgehub.chat.service.QuotaService;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 对话额度管理。
 *
 * 当前没有在线收款，额度是"内部成本管控"：管理员按租户或按人设置每月上限，
 * 0 表示不限；完全没有配置时回落到 kh.chat.* 的系统默认值。
 * 数据落在 quota 表（按 period 分月），所以调整只影响当月，历史可追溯。
 */
@RestController
@RequestMapping("/api/v1/admin/chat-quota")
@RequirePermission(PermissionCatalog.IAM_USER_MANAGE)
public class ChatQuotaController {

    private final QuotaService quotaService;

    public ChatQuotaController(QuotaService quotaService) {
        this.quotaService = quotaService;
    }

    @GetMapping
    public ApiResponse<Map<String, Object>> overview() {
        return ApiResponse.ok(quotaService.overview());
    }

    @PutMapping
    public ApiResponse<Map<String, Object>> update(@RequestBody QuotaRequest request) {
        String subjectType = (request.subjectType() == null || request.subjectType().isBlank())
                ? "tenant" : request.subjectType().trim();
        if (!"tenant".equals(subjectType) && !"user".equals(subjectType)
                && !"role".equals(subjectType) && !"group".equals(subjectType)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "subjectType 只能是 tenant / user / role / group");
        }
        String subjectId = request.subjectId();
        if (subjectId == null || subjectId.isBlank()) {
            if (!"tenant".equals(subjectType)) {
                throw new BizException(ErrorCode.BAD_REQUEST, "按用户/角色/群组设置时必须指定 subjectId");
            }
            subjectId = com.knowledgehub.common.tenant.TenantContext.require();
        }
        quotaService.setLimits(subjectType, subjectId,
                Math.max(0, request.limitTokens() == null ? 0 : request.limitTokens()),
                Math.max(0, request.limitRequests() == null ? 0 : request.limitRequests()));
        return ApiResponse.ok(quotaService.overview());
    }

    public record QuotaRequest(String subjectType, String subjectId, Long limitTokens, Long limitRequests) {
    }

    /** 撤销一条额度配置：删掉这条自定义上限，回到上层规则；已用用量不动。 */
    @org.springframework.web.bind.annotation.DeleteMapping
    public ApiResponse<Map<String, Object>> clear(
            @org.springframework.web.bind.annotation.RequestParam String subjectType,
            @org.springframework.web.bind.annotation.RequestParam(required = false) String subjectId) {
        if (!"tenant".equals(subjectType) && (subjectId == null || subjectId.isBlank())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "按用户/角色/组撤销时必须指定 subjectId");
        }
        quotaService.clearLimits(subjectType, subjectId);
        return ApiResponse.ok(quotaService.overview());
    }
}
