package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

/** 管理端菜单项：不再写死在前端，支持增删、排序、绑定权限码。 */
@Data
@TableName("menu_item")
public class MenuItem {
    @TableId
    private UUID id;
    private String tenantId;
    private String section;
    private String menuKey;
    private String label;
    private String path;
    private String permission;
    private Integer sortOrder;
    private Boolean hidden;
    /** 停用：不在侧栏展示，且直接访问也会被挡回；hidden 只是"不进侧栏，路由仍可用" */
    private Boolean enabled;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}
