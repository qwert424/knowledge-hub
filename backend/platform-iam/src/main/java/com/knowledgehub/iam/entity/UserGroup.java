package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("user_group")
public class UserGroup {
    @TableId
    private UUID id;
    private String tenantId;
    private String code;
    private String name;
    private OffsetDateTime createdAt;
}