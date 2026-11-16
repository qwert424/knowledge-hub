package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("user_identity")
public class UserIdentity {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID userId;
    private String provider;
    private String externalId;
    private String unionId;
    private OffsetDateTime createdAt;
}