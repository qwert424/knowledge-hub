package com.knowledgehub.chat.controller;

import com.knowledgehub.chat.service.PortalSettingsService;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 用户端配置（推荐问题）。用户端只读，管理端可改，所以拆成两个端点。
 */
@RestController
@RequestMapping("/api/v1/admin/portal-settings")
@RequirePermission(PermissionCatalog.IAM_USER_MANAGE)
public class PortalSettingsController {

    private final PortalSettingsService service;

    public PortalSettingsController(PortalSettingsService service) {
        this.service = service;
    }

    @GetMapping
    public ApiResponse<Map<String, Object>> get() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("suggestions", service.suggestions());
        body.put("defaults", service.defaults());
        return ApiResponse.ok(body);
    }

    @PutMapping
    public ApiResponse<Map<String, Object>> save(@RequestBody SuggestionsRequest request) {
        List<String> saved = service.saveSuggestions(request.suggestions());
        Map<String, Object> body = new LinkedHashMap<>();
        // 清空后实际生效的是默认文案
        body.put("suggestions", saved.isEmpty() ? service.defaults() : saved);
        body.put("defaults", service.defaults());
        return ApiResponse.ok(body);
    }

    public record SuggestionsRequest(List<String> suggestions) {
    }
}
