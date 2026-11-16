package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.iam.service.MenuService;
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
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * 菜单配置。读取对所有登录用户开放（前端要用它渲染导航），
 * 增删改需要角色管理权限。
 */
@RestController
@RequestMapping("/api/v1/admin/menus")
public class MenuController {

    private final MenuService menuService;

    public MenuController(MenuService menuService) {
        this.menuService = menuService;
    }

    @GetMapping
    public ApiResponse<List<MenuService.MenuView>> list() {
        return ApiResponse.ok(menuService.list());
    }

    @GetMapping("/tree")
    public ApiResponse<List<MenuService.MenuGroup>> tree() {
        return ApiResponse.ok(menuService.tree());
    }

    @PostMapping
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<MenuService.MenuView> create(@Valid @RequestBody CreateMenuRequest request) {
        return ApiResponse.ok(menuService.create(request.section(), request.label(), request.path(),
                request.permission(), request.sortOrder(), request.hidden(), request.enabled()));
    }

    @PutMapping("/{id}")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<MenuService.MenuView> update(@PathVariable UUID id,
                                                   @RequestBody UpdateMenuRequest request) {
        return ApiResponse.ok(menuService.update(id, request.section(), request.label(), request.path(),
                request.permission(), request.sortOrder(), request.hidden(), request.enabled()));
    }

    @DeleteMapping("/{id}")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<Void> delete(@PathVariable UUID id) {
        menuService.delete(id);
        return ApiResponse.ok();
    }

    /** 拖拽/上移下移后提交顺序。 */
    @PatchMapping("/order")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<List<MenuService.MenuView>> reorder(@RequestBody ReorderRequest request) {
        return ApiResponse.ok(menuService.reorder(request.ids()));
    }

    @PostMapping("/reset")
    @RequirePermission(PermissionCatalog.IAM_ROLE_MANAGE)
    public ApiResponse<List<MenuService.MenuView>> reset() {
        return ApiResponse.ok(menuService.resetToDefault());
    }

    public record CreateMenuRequest(@NotBlank String label, @NotBlank String path, String section,
                                    String permission, Integer sortOrder, Boolean hidden, Boolean enabled) {
    }

    public record UpdateMenuRequest(String section, String label, String path, String permission,
                                    Integer sortOrder, Boolean hidden, Boolean enabled) {
    }

    public record ReorderRequest(List<String> ids) {
        public ReorderRequest {
            ids = ids == null ? List.of() : ids;
        }
    }
}
