package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.iam.service.RoleService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1")
public class RoleController {

    private final RoleService roleService;

    public RoleController(RoleService roleService) {
        this.roleService = roleService;
    }

    @GetMapping("/roles")
    public ApiResponse<List<RoleService.RoleView>> list() {
        return ApiResponse.ok(roleService.list());
    }

    @PostMapping("/roles")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<RoleService.RoleView> create(@Valid @RequestBody CreateRoleRequest request) {
        return ApiResponse.ok(roleService.create(request.code(), request.name(), request.description(),
                request.permissions()));
    }

    @PutMapping("/roles/{id}/permissions")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<Void> permissions(@PathVariable UUID id, @RequestBody PermissionsRequest request) {
        roleService.replacePermissions(id, request.permissions());
        return ApiResponse.ok();
    }

    @GetMapping("/permissions")
    public ApiResponse<List<PermissionCatalog.Def>> permissions() {
        return ApiResponse.ok(PermissionCatalog.ALL);
    }

    public record CreateRoleRequest(String code, @NotBlank String name, String description,
                                    List<String> permissions) {
    }

    public record PermissionsRequest(List<String> permissions) {
    }
}