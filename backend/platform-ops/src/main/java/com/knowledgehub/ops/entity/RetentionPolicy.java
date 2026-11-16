package com.knowledgehub.ops.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

/** 数据保留策略：哪张表、留多少天、什么时候跑、上次跑了什么。 */
@Data
@TableName("retention_policy")
public class RetentionPolicy {
    @TableId
    private UUID id;
    private String tenantId;
    private String name;
    /** audit_log / chat_message */
    private String target;
    private Integer retentionDays;
    private Boolean enabled;
    /** Spring cron（6 段，秒在最前） */
    private String cron;
    private OffsetDateTime lastRunAt;
    private Integer lastDeleted;
    private String lastStatus;
    private String lastMessage;
    private OffsetDateTime updatedAt;
}
