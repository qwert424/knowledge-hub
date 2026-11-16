package com.knowledgehub.iam.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.iam.entity.MenuItem;
import com.knowledgehub.iam.mapper.MenuItemMapper;
import com.knowledgehub.iam.security.PermissionCatalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 菜单配置：菜单项存库，租户可自行增删改、排序、绑定权限码。
 * 首次访问时按内置清单播种，保证开箱即用与旧版导航一致。
 */
@Service
public class MenuService {

    private static final Logger log = LoggerFactory.getLogger(MenuService.class);

    /** 首次播种用的默认菜单（section 用展示名，sortOrder 全局递增决定分组顺序）。 */
    private record Seed(String section, String key, String label, String path, String permission) {
    }

    private static final List<Seed> DEFAULTS = List.of(
            new Seed("总览", "/overview", "概览", "/overview", null),
            new Seed("知识内容", "/kbs", "知识库", "/kbs", PermissionCatalog.KB_READ),
            new Seed("知识内容", "/documents", "文档", "/documents", PermissionCatalog.DOC_READ),
            new Seed("知识内容", "/index-jobs", "索引任务", "/index-jobs", PermissionCatalog.INDEX_MANAGE),
            new Seed("检索与质量", "/retrieval", "检索策略", "/retrieval", PermissionCatalog.PROFILE_MANAGE),
            new Seed("检索与质量", "/eval", "评测集与运行", "/eval", PermissionCatalog.EVAL_MANAGE),
            new Seed("检索与质量", "/conversations", "会话审计", "/conversations", PermissionCatalog.OPS_AUDIT_READ),
            new Seed("检索与质量", "/graph", "知识图谱", "/graph", PermissionCatalog.GRAPH_MANAGE),
            new Seed("组织与成本", "/iam", "用户与角色", "/iam", PermissionCatalog.IAM_USER_MANAGE),
            new Seed("组织与成本", "/menus", "菜单管理", "/menus", PermissionCatalog.IAM_ROLE_MANAGE),
            new Seed("组织与成本", "/quota", "用量与额度", "/quota", PermissionCatalog.CHAT_USE),
            new Seed("平台与运维", "/platform", "平台集成", "/platform", PermissionCatalog.PROFILE_MANAGE),
            new Seed("平台与运维", "/audit", "审计日志", "/audit", PermissionCatalog.OPS_AUDIT_READ),
            new Seed("平台与运维", "/retention", "数据保留", "/retention", PermissionCatalog.OPS_AUDIT_READ),
            new Seed("平台与运维", "/settings", "设置", "/settings", PermissionCatalog.PROFILE_MANAGE));

    private final MenuItemMapper menuMapper;

    public MenuService(MenuItemMapper menuMapper) {
        this.menuMapper = menuMapper;
    }

    /** 平铺列表，按 sortOrder 升序；分组顺序由各组最小 sortOrder 决定。 */
    public List<MenuView> list() {
        String tenantId = TenantContext.require();
        List<MenuItem> items = menuMapper.selectList(Wrappers.<MenuItem>lambdaQuery()
                .eq(MenuItem::getTenantId, tenantId)
                .orderByAsc(MenuItem::getSortOrder));
        if (items.isEmpty()) {
            items = seed(tenantId);
        } else {
            items = topUp(tenantId, items);
        }
        return items.stream().map(this::toView).toList();
    }

    /**
     * 补齐新增的默认菜单。
     *
     * <p>以前只在"一条都没有"时播种，结果后面新增的页面（比如数据保留）
     * 对已有租户永远不出现，只能手工去菜单管理里加。这里按 menuKey 差集补，
     * 已存在（哪怕被用户改名/停用）的一律不动。
     */
    private List<MenuItem> topUp(String tenantId, List<MenuItem> existing) {
        java.util.Set<String> keys = existing.stream()
                .map(MenuItem::getMenuKey)
                .collect(java.util.stream.Collectors.toSet());
        List<MenuItem> added = new ArrayList<>();
        int order = existing.stream().mapToInt(MenuItem::getSortOrder).max().orElse(0);
        for (Seed seed : DEFAULTS) {
            if (keys.contains(seed.key())) {
                continue;
            }
            order += 10;
            MenuItem item = new MenuItem();
            item.setId(Ids.uuid7());
            item.setTenantId(tenantId);
            item.setSection(seed.section());
            item.setMenuKey(seed.key());
            item.setLabel(seed.label());
            item.setPath(seed.path());
            item.setPermission(seed.permission());
            item.setSortOrder(order);
            item.setHidden(false);
            item.setEnabled(true);
            item.setCreatedAt(OffsetDateTime.now());
            item.setUpdatedAt(OffsetDateTime.now());
            menuMapper.insert(item);
            added.add(item);
        }
        if (added.isEmpty()) {
            return existing;
        }
        List<MenuItem> merged = new ArrayList<>(existing);
        merged.addAll(added);
        merged.sort(java.util.Comparator.comparingInt(MenuItem::getSortOrder));
        return merged;
    }

    /** 树形结构，前端直接渲染；分组本身不绑权限，子项可见则分组可见。 */
    public List<MenuGroup> tree() {
        Map<String, List<MenuView>> grouped = new LinkedHashMap<>();
        for (MenuView view : list()) {
            // 停用的菜单不进侧栏；hidden 的也不进（但路由仍可访问）
            if (Boolean.TRUE.equals(view.hidden()) || !Boolean.TRUE.equals(view.enabled())) {
                continue;
            }
            grouped.computeIfAbsent(view.section(), key -> new ArrayList<>()).add(view);
        }
        return grouped.entrySet().stream()
                .map(entry -> new MenuGroup(entry.getKey(), entry.getValue()))
                .toList();
    }

    @Transactional
    public MenuView create(String section, String label, String path, String permission, Integer sortOrder,
                           Boolean hidden, Boolean enabled) {
        String tenantId = TenantContext.require();
        MenuItem item = new MenuItem();
        item.setId(Ids.uuid7());
        item.setTenantId(tenantId);
        item.setSection(section == null || section.isBlank() ? "自定义" : section.trim());
        item.setMenuKey(normalizeKey(path));
        item.setLabel(label.trim());
        item.setPath(path.trim());
        item.setPermission(permission == null || permission.isBlank() ? null : permission.trim());
        item.setSortOrder(sortOrder == null ? nextSortOrder(tenantId) : sortOrder);
        // 两个开关含义不同：hidden = 不进侧栏但路由可用；enabled = 彻底停用
        item.setHidden(Boolean.TRUE.equals(hidden));
        item.setEnabled(enabled == null || enabled);
        item.setCreatedAt(OffsetDateTime.now());
        item.setUpdatedAt(OffsetDateTime.now());
        menuMapper.insert(item);
        return toView(item);
    }

    @Transactional
    public MenuView update(UUID id, String section, String label, String path, String permission,
                           Integer sortOrder, Boolean hidden, Boolean enabled) {
        MenuItem item = require(id);
        if (section != null && !section.isBlank()) {
            item.setSection(section.trim());
        }
        if (label != null && !label.isBlank()) {
            item.setLabel(label.trim());
        }
        if (path != null && !path.isBlank()) {
            item.setPath(path.trim());
            item.setMenuKey(normalizeKey(path));
        }
        if (permission != null) {
            item.setPermission(permission.isBlank() ? null : permission.trim());
        }
        if (sortOrder != null) {
            item.setSortOrder(sortOrder);
        }
        if (hidden != null) {
            item.setHidden(hidden);
        }
        if (enabled != null) {
            item.setEnabled(enabled);
        }
        item.setUpdatedAt(OffsetDateTime.now());
        menuMapper.updateById(item);
        return toView(item);
    }

    @Transactional
    public void delete(UUID id) {
        MenuItem item = require(id);
        menuMapper.deleteById(item.getId());
    }

    /** 批量保存顺序：按传入顺序重排 sortOrder。 */
    @Transactional
    public List<MenuView> reorder(List<String> ids) {
        int order = 0;
        for (String raw : ids) {
            MenuItem item = require(UUID.fromString(raw));
            item.setSortOrder(order++);
            item.setUpdatedAt(OffsetDateTime.now());
            menuMapper.updateById(item);
        }
        return list();
    }

    /** 恢复默认：清掉本租户配置并重新播种。 */
    @Transactional
    public List<MenuView> resetToDefault() {
        String tenantId = TenantContext.require();
        menuMapper.delete(Wrappers.<MenuItem>lambdaQuery().eq(MenuItem::getTenantId, tenantId));
        return seed(tenantId).stream().map(this::toView).toList();
    }

    private List<MenuItem> seed(String tenantId) {
        List<MenuItem> created = new ArrayList<>();
        int order = 0;
        for (Seed seed : DEFAULTS) {
            MenuItem item = new MenuItem();
            item.setId(Ids.uuid7());
            item.setTenantId(tenantId);
            item.setSection(seed.section());
            item.setMenuKey(seed.key());
            item.setLabel(seed.label());
            item.setPath(seed.path());
            item.setPermission(seed.permission());
            item.setSortOrder(order++);
            item.setHidden(false);
            item.setEnabled(true);
            item.setCreatedAt(OffsetDateTime.now());
            item.setUpdatedAt(OffsetDateTime.now());
            try {
                menuMapper.insert(item);
                created.add(item);
            } catch (Exception ex) {
                // 并发首次访问会导致唯一键冲突，忽略并复用已有记录
                log.debug("menu seed skipped {}: {}", seed.key(), ex.getMessage());
            }
        }
        if (created.isEmpty()) {
            return menuMapper.selectList(Wrappers.<MenuItem>lambdaQuery()
                    .eq(MenuItem::getTenantId, tenantId)
                    .orderByAsc(MenuItem::getSortOrder));
        }
        return created;
    }

    private int nextSortOrder(String tenantId) {
        MenuItem last = menuMapper.selectOne(Wrappers.<MenuItem>lambdaQuery()
                .eq(MenuItem::getTenantId, tenantId)
                .orderByDesc(MenuItem::getSortOrder)
                .last("limit 1"));
        return last == null || last.getSortOrder() == null ? 0 : last.getSortOrder() + 1;
    }

    private String normalizeKey(String path) {
        String trimmed = path == null ? "" : path.trim();
        if (trimmed.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "菜单路径不能为空");
        }
        return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
    }

    private MenuItem require(UUID id) {
        MenuItem item = menuMapper.selectOne(Wrappers.<MenuItem>lambdaQuery()
                .eq(MenuItem::getTenantId, TenantContext.require())
                .eq(MenuItem::getId, id));
        if (item == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "菜单不存在");
        }
        return item;
    }

    private MenuView toView(MenuItem item) {
        return new MenuView(item.getId().toString(), item.getSection(), item.getMenuKey(), item.getLabel(),
                item.getPath(), item.getPermission(), item.getSortOrder(), Boolean.TRUE.equals(item.getHidden()),
                item.getEnabled() == null || item.getEnabled());
    }

    public record MenuView(String id, String section, String key, String label, String path, String permission,
                           Integer sortOrder, Boolean hidden, Boolean enabled) {
    }

    public record MenuGroup(String section, List<MenuView> items) {
    }
}
