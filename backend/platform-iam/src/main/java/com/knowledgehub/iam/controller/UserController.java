package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.iam.service.UserService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/users")
@RequirePermission(PermissionCatalog.IAM_USER_MANAGE)
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping
    public ApiResponse<PageResult<UserService.UserView>> list(@RequestParam(required = false) String keyword,
                                                             @RequestParam(defaultValue = "1") long page,
                                                             @RequestParam(defaultValue = "20") long pageSize) {
        return ApiResponse.ok(userService.list(keyword, page, pageSize));
    }

    @PostMapping
    public ApiResponse<UserService.UserView> create(@Valid @RequestBody CreateUserRequest request) {
        return ApiResponse.ok(userService.create(request.username(), request.password(), request.displayName(),
                request.email(), request.roles()));
    }

    @PutMapping("/{id}")
    public ApiResponse<UserService.UserView> update(@PathVariable UUID id, @RequestBody UpdateUserRequest request) {
        return ApiResponse.ok(userService.update(id, request.displayName(), request.email(), request.status()));
    }

    @PostMapping("/{id}/roles")
    public ApiResponse<Void> assignRoles(@PathVariable UUID id, @RequestBody RolesRequest request) {
        userService.assignRoles(id, request.roles());
        return ApiResponse.ok();
    }

    public record CreateUserRequest(@NotBlank String username, @NotBlank String password,
                                    @NotBlank String displayName, String email, List<String> roles) {
    }

    public record UpdateUserRequest(String displayName, String email, String status) {
    }

    public record RolesRequest(List<String> roles) {
    }
}