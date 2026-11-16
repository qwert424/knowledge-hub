package com.knowledgehub.ops.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("audit_log")
public class AuditLog {
    @TableId(type = com.baomidou.mybatisplus.annotation.IdType.AUTO)
    private Long id;
    private String tenantId;
    private UUID actorId;
    private String actorName;
    private String action;
    private String resourceType;
    private String resourceId;
    private String before;
    private String after;
    private String ip;
    private String userAgent;
    private String result;
    private String errorCode;
    private String requestId;
    private OffsetDateTime createdAt;
}