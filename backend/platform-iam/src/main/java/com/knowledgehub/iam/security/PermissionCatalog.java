package com.knowledgehub.iam.security;

import java.util.List;

/** Permission codes shared by seeding, annotations and the admin UI. */
public final class PermissionCatalog {

    public static final String KB_READ = "kb:read";
    public static final String KB_WRITE = "kb:write";
    public static final String DOC_READ = "doc:read";
    public static final String DOC_WRITE = "doc:write";
    public static final String INDEX_MANAGE = "index:manage";
    public static final String PROFILE_MANAGE = "profile:manage";
    public static final String CHAT_USE = "chat:use";
    public static final String EVAL_MANAGE = "eval:manage";
    public static final String GRAPH_MANAGE = "graph:manage";
    public static final String IAM_USER_MANAGE = "iam:user:manage";
    public static final String IAM_ROLE_MANAGE = "iam:role:manage";
    public static final String OPS_AUDIT_READ = "ops:audit:read";
    public static final String DATASOURCE_MANAGE = "datasource:manage";

    public record Def(String code, String name, String module) {
    }

    public static final List<Def> ALL = List.of(
            new Def(KB_READ, "查看知识库", "kb"),
            new Def(KB_WRITE, "管理知识库", "kb"),
            new Def(DOC_READ, "查看文档", "kb"),
            new Def(DOC_WRITE, "管理文档", "kb"),
            new Def(INDEX_MANAGE, "索引任务管理", "index"),
            new Def(PROFILE_MANAGE, "检索策略管理", "retrieval"),
            new Def(CHAT_USE, "使用对话", "chat"),
            new Def(EVAL_MANAGE, "评测管理", "eval"),
            new Def(GRAPH_MANAGE, "图谱管理", "graph"),
            new Def(IAM_USER_MANAGE, "用户管理", "iam"),
            new Def(IAM_ROLE_MANAGE, "角色管理", "iam"),
            new Def(OPS_AUDIT_READ, "审计查看", "ops"),
            new Def(DATASOURCE_MANAGE, "数据源管理", "datasource"));

    private PermissionCatalog() {
    }
}