package com.knowledgehub.iam.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.JwtService;
import com.knowledgehub.common.security.KhSecurityProperties;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.iam.entity.AppUser;
import com.knowledgehub.iam.entity.Role;
import com.knowledgehub.iam.entity.RolePermission;
import com.knowledgehub.iam.entity.UserGroup;
import com.knowledgehub.iam.entity.UserGroupMember;
import com.knowledgehub.iam.entity.UserRole;
import com.knowledgehub.iam.mapper.AppUserMapper;
import com.knowledgehub.iam.mapper.RoleMapper;
import com.knowledgehub.iam.mapper.RolePermissionMapper;
import com.knowledgehub.iam.mapper.UserGroupMapper;
import com.knowledgehub.iam.mapper.UserGroupMemberMapper;
import com.knowledgehub.iam.mapper.UserRoleMapper;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class AuthService {

    private final AppUserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final UserGroupMapper groupMapper;
    private final UserGroupMemberMapper groupMemberMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final KhSecurityProperties props;
    private final AuditRecorder auditRecorder;

    public AuthService(AppUserMapper userMapper, RoleMapper roleMapper, UserRoleMapper userRoleMapper,
                       RolePermissionMapper rolePermissionMapper, UserGroupMapper groupMapper,
                       UserGroupMemberMapper groupMemberMapper, PasswordEncoder passwordEncoder,
                       JwtService jwtService, KhSecurityProperties props, AuditRecorder auditRecorder) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.rolePermissionMapper = rolePermissionMapper;
        this.groupMapper = groupMapper;
        this.groupMemberMapper = groupMemberMapper;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.props = props;
        this.auditRecorder = auditRecorder;
    }

    @Transactional
    public LoginResult login(String tenantId, String username, String password) {
        String tenant = tenantId == null || tenantId.isBlank() ? TenantContext.DEFAULT_TENANT : tenantId;
        AppUser user = userMapper.selectOne(Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenant)
                .eq(AppUser::getUsername, username)
                .isNull(AppUser::getDeletedAt));
        if (user == null || user.getPasswordHash() == null
                || !passwordEncoder.matches(password, user.getPasswordHash())) {
            auditRecorder.record("auth.login", "user", username, null, null, "FAILED", "AUTH_401");
            throw new BizException(ErrorCode.AUTH_401, "用户名或密码错误");
        }
        if (!"active".equals(user.getStatus())) {
            throw new BizException(ErrorCode.AUTH_403, "账号已被禁用");
        }
        CurrentUser current = loadUser(user);
        user.setLastLoginAt(OffsetDateTime.now());
        userMapper.updateById(user);
        auditRecorder.record("auth.login", "user", user.getId().toString(), null, null);

        String accessToken = issueAccessToken(current);
        String refreshToken = jwtService.sign(
                claimsFor(current, Map.of("typ", "refresh")),
                Duration.ofDays(props.getRefreshTokenTtlDays()));
        return new LoginResult(accessToken, refreshToken, props.getAccessTokenTtlMinutes() * 60L, toProfile(current));
    }

    /**
     * Self-service registration. A new account always gets the tenant's STAFF role:
     * it can chat and read knowledge bases it is granted, never administer them.
     */
    @Transactional
    public LoginResult register(String tenantId, String username, String password, String displayName) {
        String tenant = tenantId == null || tenantId.isBlank() ? TenantContext.DEFAULT_TENANT : tenantId;
        Long existing = userMapper.selectCount(Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenant)
                .eq(AppUser::getUsername, username));
        if (existing != null && existing > 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "用户名已存在");
        }
        AppUser user = new AppUser();
        user.setId(com.knowledgehub.common.util.Ids.uuid7());
        user.setTenantId(tenant);
        user.setUsername(username);
        user.setDisplayName(displayName == null || displayName.isBlank() ? username : displayName);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setStatus("active");
        user.setCreatedAt(OffsetDateTime.now());
        user.setUpdatedAt(OffsetDateTime.now());
        userMapper.insert(user);

        Role staff = roleMapper.selectOne(Wrappers.<Role>lambdaQuery()
                .eq(Role::getTenantId, tenant)
                .eq(Role::getCode, "STAFF"));
        if (staff != null) {
            UserRole link = new UserRole();
            link.setTenantId(tenant);
            link.setUserId(user.getId());
            link.setRoleId(staff.getId());
            userRoleMapper.insert(link);
        }
        auditRecorder.record("auth.register", "user", user.getId().toString(), null, null);
        return login(tenant, username, password);
    }

    public LoginResult refresh(String refreshToken) {
        var claims = jwtService.parse(refreshToken);
        if (!"refresh".equals(claims.get("typ", String.class))) {
            throw new BizException(ErrorCode.AUTH_401, "刷新令牌无效");
        }
        CurrentUser current = loadUser(UUID.fromString(claims.getSubject()));
        String accessToken = issueAccessToken(current);
        return new LoginResult(accessToken, refreshToken, props.getAccessTokenTtlMinutes() * 60L, toProfile(current));
    }

    public String issueAccessToken(CurrentUser user) {
        return jwtService.sign(claimsFor(user, Map.of("typ", "access")),
                Duration.ofMinutes(props.getAccessTokenTtlMinutes()));
    }

    public CurrentUser loadUser(UUID userId) {
        AppUser user = userMapper.selectById(userId);
        if (user == null) {
            throw new BizException(ErrorCode.AUTH_401);
        }
        return loadUser(user);
    }

    public CurrentUser loadUser(AppUser user) {
        List<UserRole> userRoles = userRoleMapper.selectList(Wrappers.<UserRole>lambdaQuery()
                .eq(UserRole::getTenantId, user.getTenantId())
                .eq(UserRole::getUserId, user.getId()));
        Set<UUID> roleIds = userRoles.stream().map(UserRole::getRoleId).collect(Collectors.toSet());
        List<Role> roles = roleIds.isEmpty() ? List.of()
                : roleMapper.selectBatchIds(roleIds).stream()
                        .filter(r -> user.getTenantId().equals(r.getTenantId()))
                        .toList();
        List<String> roleCodes = roles.stream().map(Role::getCode).toList();

        List<String> permissions = roleIds.isEmpty() ? List.of()
                : rolePermissionMapper.selectList(Wrappers.<RolePermission>lambdaQuery()
                        .eq(RolePermission::getTenantId, user.getTenantId())
                        .in(RolePermission::getRoleId, roleIds))
                        .stream().map(RolePermission::getPermissionCode).distinct().toList();

        List<UserGroupMember> memberships = groupMemberMapper.selectList(Wrappers.<UserGroupMember>lambdaQuery()
                .eq(UserGroupMember::getTenantId, user.getTenantId())
                .eq(UserGroupMember::getUserId, user.getId()));
        List<String> groups = memberships.isEmpty() ? List.of()
                : groupMapper.selectBatchIds(memberships.stream().map(UserGroupMember::getGroupId).toList())
                        .stream().map(UserGroup::getCode).toList();

        return new CurrentUser(user.getId(), user.getUsername(), user.getDisplayName(), user.getTenantId(),
                Set.copyOf(roleCodes), Set.copyOf(permissions), Set.of(), Set.copyOf(groups));
    }

    public Map<String, Object> toProfile(CurrentUser user) {
        Map<String, Object> profile = new HashMap<>();
        profile.put("id", user.userId());
        profile.put("username", user.username());
        profile.put("displayName", user.displayName());
        profile.put("tenantId", user.tenantId());
        profile.put("roles", user.roles());
        profile.put("permissions", user.permissions());
        profile.put("groups", user.groups());
        return profile;
    }

    private Map<String, Object> claimsFor(CurrentUser user, Map<String, Object> extra) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", user.userId().toString());
        claims.put("tid", user.tenantId());
        claims.put("usr", user.username());
        claims.put("name", user.displayName());
        claims.put("roles", List.copyOf(user.roles()));
        claims.put("perms", List.copyOf(user.permissions()));
        claims.put("depts", List.copyOf(user.depts()));
        claims.put("groups", List.copyOf(user.groups()));
        claims.put("scope", "user");
        claims.putAll(extra);
        return claims;
    }

    public record LoginResult(String accessToken, String refreshToken, long expiresIn, Map<String, Object> user) {
    }
}