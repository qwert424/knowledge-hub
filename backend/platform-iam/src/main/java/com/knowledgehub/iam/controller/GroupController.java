package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import com.knowledgehub.iam.service.GroupService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/groups")
@RequirePermission(PermissionCatalog.IAM_USER_MANAGE)
public class GroupController {

    private final GroupService groupService;

    public GroupController(GroupService groupService) {
        this.groupService = groupService;
    }

    @GetMapping
    public ApiResponse<List<GroupService.GroupView>> list() {
        return ApiResponse.ok(groupService.list());
    }

    @PostMapping
    public ApiResponse<GroupService.GroupView> create(@Valid @RequestBody CreateGroupRequest request) {
        return ApiResponse.ok(groupService.create(request.code(), request.name()));
    }

    @PostMapping("/{id}/members")
    public ApiResponse<Void> addMember(@PathVariable UUID id, @RequestBody MemberRequest request) {
        groupService.addMember(id, UUID.fromString(request.userId()));
        return ApiResponse.ok();
    }

    public record CreateGroupRequest(String code, @NotBlank String name) {
    }

    public record MemberRequest(@NotBlank String userId) {
    }
}