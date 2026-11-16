package com.knowledgehub.iam.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.knowledgehub.common.api.PageResult;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.iam.entity.AppUser;
import com.knowledgehub.iam.entity.Role;
import com.knowledgehub.iam.entity.UserRole;
import com.knowledgehub.iam.mapper.AppUserMapper;
import com.knowledgehub.iam.mapper.RoleMapper;
import com.knowledgehub.iam.mapper.UserRoleMapper;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class UserService {

    private final AppUserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final PasswordEncoder passwordEncoder;
    private final AuditRecorder auditRecorder;

    public UserService(AppUserMapper userMapper, RoleMapper roleMapper, UserRoleMapper userRoleMapper,
                       PasswordEncoder passwordEncoder, AuditRecorder auditRecorder) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.passwordEncoder = passwordEncoder;
        this.auditRecorder = auditRecorder;
    }

    public PageResult<UserView> list(String keyword, long page, long pageSize) {
        String tenantId = TenantContext.require();
        LambdaQueryWrapper<AppUser> query = Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenantId)
                .isNull(AppUser::getDeletedAt)
                .orderByDesc(AppUser::getCreatedAt);
        if (keyword != null && !keyword.isBlank()) {
            query.and(w -> w.like(AppUser::getUsername, keyword).or().like(AppUser::getDisplayName, keyword));
        }
        Page<AppUser> result = userMapper.selectPage(new Page<>(page, pageSize), query);
        return PageResult.of(result.getRecords().stream().map(this::toView).toList(),
                result.getTotal(), page, pageSize);
    }

    @Transactional
    public UserView create(String username, String password, String displayName, String email, List<String> roleCodes) {
        String tenantId = TenantContext.require();
        Long exists = userMapper.selectCount(Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenantId)
                .eq(AppUser::getUsername, username)
                .isNull(AppUser::getDeletedAt));
        if (exists != null && exists > 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "用户名已存在");
        }
        AppUser user = new AppUser();
        user.setId(Ids.uuid7());
        user.setTenantId(tenantId);
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setDisplayName(displayName);
        user.setEmail(email);
        user.setStatus("active");
        user.setCreatedAt(OffsetDateTime.now());
        user.setUpdatedAt(OffsetDateTime.now());
        userMapper.insert(user);
        if (roleCodes != null && !roleCodes.isEmpty()) {
            assignRoles(user.getId(), roleCodes);
        }
        auditRecorder.record("iam.user.create", "user", user.getId().toString(), null, username);
        return toView(user);
    }

    public UserView update(UUID userId, String displayName, String email, String status) {
        AppUser user = requireUser(userId);
        String before = user.getDisplayName() + "|" + user.getStatus();
        if (displayName != null && !displayName.isBlank()) {
            user.setDisplayName(displayName);
        }
        if (email != null) {
            user.setEmail(email);
        }
        if (status != null && !status.isBlank()) {
            user.setStatus(status);
        }
        user.setUpdatedAt(OffsetDateTime.now());
        userMapper.updateById(user);
        auditRecorder.record("iam.user.update", "user", userId.toString(), before,
                user.getDisplayName() + "|" + user.getStatus());
        return toView(user);
    }

    @Transactional
    public void assignRoles(UUID userId, List<String> roleCodes) {
        String tenantId = TenantContext.require();
        List<Role> roles = roleMapper.selectList(Wrappers.<Role>lambdaQuery()
                .eq(Role::getTenantId, tenantId)
                .in(Role::getCode, roleCodes));
        if (roles.size() != roleCodes.size()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "存在无效角色");
        }
        userRoleMapper.delete(Wrappers.<UserRole>lambdaQuery()
                .eq(UserRole::getTenantId, tenantId)
                .eq(UserRole::getUserId, userId));
        for (Role role : roles) {
            UserRole link = new UserRole();
            link.setTenantId(tenantId);
            link.setUserId(userId);
            link.setRoleId(role.getId());
            userRoleMapper.insert(link);
        }
        auditRecorder.record("iam.user.assignRoles", "user", userId.toString(), null, String.join(",", roleCodes));
    }

    public void changePassword(UUID userId, String oldPassword, String newPassword) {
        AppUser user = requireUser(userId);
        if (!passwordEncoder.matches(oldPassword, user.getPasswordHash())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "原密码不正确");
        }
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        user.setUpdatedAt(OffsetDateTime.now());
        userMapper.updateById(user);
        auditRecorder.record("iam.user.changePassword", "user", userId.toString(), null, null);
    }

    public AppUser requireUser(UUID userId) {
        String tenantId = TenantContext.require();
        AppUser user = userMapper.selectOne(Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenantId)
                .eq(AppUser::getId, userId)
                .isNull(AppUser::getDeletedAt));
        if (user == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "用户不存在");
        }
        return user;
    }

    public UserView toView(AppUser user) {
        List<String> roles = userRoleMapper.selectList(Wrappers.<UserRole>lambdaQuery()
                        .eq(UserRole::getTenantId, user.getTenantId())
                        .eq(UserRole::getUserId, user.getId()))
                .stream()
                .map(UserRole::getRoleId)
                .map(roleMapper::selectById)
                .filter(java.util.Objects::nonNull)
                .map(Role::getCode)
                .toList();
        return new UserView(user.getId().toString(), user.getUsername(), user.getDisplayName(), user.getEmail(),
                user.getStatus(), roles, user.getLastLoginAt() == null ? null : user.getLastLoginAt().toString());
    }

    public record UserView(String id, String username, String displayName, String email, String status,
                           List<String> roles, String lastLoginAt) {
    }
}