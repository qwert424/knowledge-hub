package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.util.UUID;

@Data
@TableName("user_role")
public class UserRole {
    private String tenantId;
    private UUID userId;
    private UUID roleId;
}