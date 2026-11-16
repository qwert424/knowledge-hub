package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("app_user")
public class AppUser {
    @TableId
    private UUID id;
    private String tenantId;
    private String username;
    private String passwordHash;
    private String displayName;
    private String email;
    private String phone;
    private String avatarUrl;
    private String status;
    private OffsetDateTime lastLoginAt;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
    private OffsetDateTime deletedAt;
}