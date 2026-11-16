package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("role")
public class Role {
    @TableId
    private UUID id;
    private String tenantId;
    private String code;
    private String name;
    private String description;
    private Boolean builtin;
    private OffsetDateTime createdAt;
}