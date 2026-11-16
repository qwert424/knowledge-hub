package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.util.UUID;

@Data
@TableName("role_permission")
public class RolePermission {
    private String tenantId;
    private UUID roleId;
    private String permissionCode;
}