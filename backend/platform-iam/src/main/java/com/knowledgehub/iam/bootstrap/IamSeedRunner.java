package com.knowledgehub.iam.bootstrap;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.security.KhSecurityProperties;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.iam.entity.AppUser;
import com.knowledgehub.iam.entity.Permission;
import com.knowledgehub.iam.entity.Role;
import com.knowledgehub.iam.entity.RolePermission;
import com.knowledgehub.iam.entity.UserRole;
import com.knowledgehub.iam.mapper.AppUserMapper;
import com.knowledgehub.iam.mapper.PermissionMapper;
import com.knowledgehub.iam.mapper.RoleMapper;
import com.knowledgehub.iam.mapper.RolePermissionMapper;
import com.knowledgehub.iam.mapper.UserRoleMapper;
import com.knowledgehub.iam.security.PermissionCatalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;

@Component
public class IamSeedRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(IamSeedRunner.class);
    private static final String DEFAULT_ADMIN = "admin";
    private static final String DEFAULT_PASSWORD = "Admin@12345";

    private final JdbcTemplate jdbcTemplate;
    private final PermissionMapper permissionMapper;
    private final RoleMapper roleMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final AppUserMapper userMapper;
    private final UserRoleMapper userRoleMapper;
    private final PasswordEncoder passwordEncoder;
    private final KhSecurityProperties props;

    public IamSeedRunner(JdbcTemplate jdbcTemplate, PermissionMapper permissionMapper, RoleMapper roleMapper,
                         RolePermissionMapper rolePermissionMapper, AppUserMapper userMapper,
                         UserRoleMapper userRoleMapper, PasswordEncoder passwordEncoder,
                         KhSecurityProperties props) {
        this.jdbcTemplate = jdbcTemplate;
        this.permissionMapper = permissionMapper;
        this.roleMapper = roleMapper;
        this.rolePermissionMapper = rolePermissionMapper;
        this.userMapper = userMapper;
        this.userRoleMapper = userRoleMapper;
        this.passwordEncoder = passwordEncoder;
        this.props = props;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String tenantId = TenantContext.DEFAULT_TENANT;
        jdbcTemplate.update("""
                insert into tenant (id, code, name, status) values (?, ?, ?, 'active')
                on conflict (id) do nothing
                """, tenantId, tenantId, "默认租户");

        for (PermissionCatalog.Def def : PermissionCatalog.ALL) {
            if (permissionMapper.selectById(def.code()) == null) {
                Permission permission = new Permission();
                permission.setCode(def.code());
                permission.setName(def.name());
                permission.setModule(def.module());
                permissionMapper.insert(permission);
            }
        }

        Role adminRole = ensureRole(tenantId, "ADMIN", "系统管理员", List.of("*"));
        ensureRole(tenantId, "EDITOR", "知识运营", List.of(
                PermissionCatalog.KB_READ, PermissionCatalog.KB_WRITE, PermissionCatalog.DOC_READ,
                PermissionCatalog.DOC_WRITE, PermissionCatalog.INDEX_MANAGE, PermissionCatalog.PROFILE_MANAGE,
                PermissionCatalog.CHAT_USE, PermissionCatalog.EVAL_MANAGE, PermissionCatalog.GRAPH_MANAGE));
        ensureRole(tenantId, "STAFF", "普通员工", List.of(
                PermissionCatalog.KB_READ, PermissionCatalog.DOC_READ, PermissionCatalog.CHAT_USE));

        AppUser admin = userMapper.selectOne(Wrappers.<AppUser>lambdaQuery()
                .eq(AppUser::getTenantId, tenantId)
                .eq(AppUser::getUsername, DEFAULT_ADMIN)
                .isNull(AppUser::getDeletedAt));
        if (admin == null) {
            admin = new AppUser();
            admin.setId(Ids.uuid7());
            admin.setTenantId(tenantId);
            admin.setUsername(DEFAULT_ADMIN);
            admin.setPasswordHash(passwordEncoder.encode(DEFAULT_PASSWORD));
            admin.setDisplayName("系统管理员");
            admin.setStatus("active");
            admin.setCreatedAt(OffsetDateTime.now());
            admin.setUpdatedAt(OffsetDateTime.now());
            userMapper.insert(admin);
            UserRole link = new UserRole();
            link.setTenantId(tenantId);
            link.setUserId(admin.getId());
            link.setRoleId(adminRole.getId());
            userRoleMapper.insert(link);
            log.info("Seeded default admin account: {} / {}", DEFAULT_ADMIN, DEFAULT_PASSWORD);
        }

        Long kbCount = jdbcTemplate.queryForObject(
                "select count(*) from knowledge_base where tenant_id = ? and deleted_at is null",
                Long.class, tenantId);
        if (kbCount != null && kbCount == 0) {
            jdbcTemplate.update("""
                    insert into knowledge_base (id, tenant_id, name, code, description, visibility,
                        embedding_model, embedding_dim, collection_name, created_by)
                    values (?, ?, ?, ?, ?, 'tenant', ?, ?, ?, ?)
                    """, Ids.uuid7(), tenantId, "示例知识库", "demo", "用于联调的示例知识库",
                    "text-embedding-v4", 1024, "kh_demo_1024", admin.getId());
            log.info("Seeded demo knowledge base");
        }
    }

    private Role ensureRole(String tenantId, String code, String name, List<String> permissions) {
        Role role = roleMapper.selectOne(Wrappers.<Role>lambdaQuery()
                .eq(Role::getTenantId, tenantId).eq(Role::getCode, code));
        if (role == null) {
            role = new Role();
            role.setId(Ids.uuid7());
            role.setTenantId(tenantId);
            role.setCode(code);
            role.setName(name);
            role.setBuiltin(true);
            role.setCreatedAt(OffsetDateTime.now());
            roleMapper.insert(role);
        }
        for (String permission : permissions) {
            Long exists = rolePermissionMapper.selectCount(Wrappers.<RolePermission>lambdaQuery()
                    .eq(RolePermission::getTenantId, tenantId)
                    .eq(RolePermission::getRoleId, role.getId())
                    .eq(RolePermission::getPermissionCode, permission));
            if (exists == null || exists == 0) {
                RolePermission link = new RolePermission();
                link.setTenantId(tenantId);
                link.setRoleId(role.getId());
                link.setPermissionCode(permission);
                rolePermissionMapper.insert(link);
            }
        }
        return role;
    }
}