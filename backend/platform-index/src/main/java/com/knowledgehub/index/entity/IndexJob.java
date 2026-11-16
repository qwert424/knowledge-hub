package com.knowledgehub.index.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("index_job")
public class IndexJob {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID documentId;
    private UUID versionId;
    private String jobType;
    private String status;
    private String stage;
    private Integer progress;
    private Integer attempt;
    private Integer maxAttempts;
    private String errorCode;
    private String errorMessage;
    private String payload;
    private String stageTimings;
    private Integer tokenCount;
    private java.math.BigDecimal costUsd;
    private OffsetDateTime startedAt;
    private OffsetDateTime finishedAt;
    private String traceId;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}