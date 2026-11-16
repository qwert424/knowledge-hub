package com.knowledgehub.iam.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.iam.entity.Role;
import com.knowledgehub.iam.entity.RolePermission;
import com.knowledgehub.iam.mapper.RoleMapper;
import com.knowledgehub.iam.mapper.RolePermissionMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class RoleService {

    private final RoleMapper roleMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final AuditRecorder auditRecorder;

    public RoleService(RoleMapper roleMapper, RolePermissionMapper rolePermissionMapper, AuditRecorder auditRecorder) {
        this.roleMapper = roleMapper;
        this.rolePermissionMapper = rolePermissionMapper;
        this.auditRecorder = auditRecorder;
    }

    public List<RoleView> list() {
        String tenantId = TenantContext.require();
        return roleMapper.selectList(Wrappers.<Role>lambdaQuery()
                        .eq(Role::getTenantId, tenantId)
                        .orderByAsc(Role::getCode))
                .stream().map(this::toView).toList();
    }

    private String autoCode() {
        return "ROLE_" + Long.toHexString(System.nanoTime()).substring(6).toUpperCase();
    }

    @Transactional
    public RoleView create(String code, String name, String description, List<String> permissions) {
        String tenantId = TenantContext.require();
        // ????????????????????????"??????"??
        String resolved = (code == null || code.isBlank()) ? autoCode() : code.trim().toUpperCase();
        Long exists = roleMapper.selectCount(Wrappers.<Role>lambdaQuery()
                .eq(Role::getTenantId, tenantId).eq(Role::getCode, resolved));
        if (exists != null && exists > 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "角色编码已存在");
        }
        Role role = new Role();
        role.setId(Ids.uuid7());
        role.setTenantId(tenantId);
        role.setCode(resolved);
        role.setName(name);
        role.setDescription(description);
        role.setBuiltin(false);
        role.setCreatedAt(OffsetDateTime.now());
        roleMapper.insert(role);
        replacePermissions(role.getId(), permissions);
        auditRecorder.record("iam.role.create", "role", role.getId().toString(), null, code);
        return toView(role);
    }

    @Transactional
    public void replacePermissions(UUID roleId, List<String> permissions) {
        String tenantId = TenantContext.require();
        rolePermissionMapper.delete(Wrappers.<RolePermission>lambdaQuery()
                .eq(RolePermission::getTenantId, tenantId)
                .eq(RolePermission::getRoleId, roleId));
        if (permissions == null) {
            return;
        }
        for (String permission : permissions) {
            RolePermission link = new RolePermission();
            link.setTenantId(tenantId);
            link.setRoleId(roleId);
            link.setPermissionCode(permission);
            rolePermissionMapper.insert(link);
        }
    }

    private RoleView toView(Role role) {
        List<String> permissions = rolePermissionMapper.selectList(Wrappers.<RolePermission>lambdaQuery()
                        .eq(RolePermission::getTenantId, role.getTenantId())
                        .eq(RolePermission::getRoleId, role.getId()))
                .stream().map(RolePermission::getPermissionCode).toList();
        return new RoleView(role.getId().toString(), role.getCode(), role.getName(), role.getDescription(),
                Boolean.TRUE.equals(role.getBuiltin()), permissions);
    }

    public record RoleView(String id, String code, String name, String description, boolean builtin,
                           List<String> permissions) {
    }
}