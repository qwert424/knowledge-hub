package com.knowledgehub.common.security;

import java.util.Set;
import java.util.UUID;

public record CurrentUser(
        UUID userId,
        String username,
        String displayName,
        String tenantId,
        Set<String> roles,
        Set<String> permissions,
        Set<String> depts,
        Set<String> groups) {

    public boolean isAdmin() {
        return roles.contains("ADMIN") || roles.contains("SUPER_ADMIN");
    }

    public boolean hasPermission(String permission) {
        return isAdmin() || permissions.contains("*") || permissions.contains(permission);
    }

    public java.util.List<String> aclPrincipals() {
        java.util.List<String> principals = new java.util.ArrayList<>();
        principals.add("user:" + userId);
        roles.forEach(r -> principals.add("role:" + r));
        depts.forEach(d -> principals.add("dept:" + d));
        groups.forEach(g -> principals.add("group:" + g));
        principals.add("tenant:all");
        return principals;
    }
}