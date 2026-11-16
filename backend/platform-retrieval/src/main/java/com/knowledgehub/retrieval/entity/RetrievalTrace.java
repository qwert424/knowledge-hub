package com.knowledgehub.retrieval.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("retrieval_trace")
public class RetrievalTrace {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID profileId;
    private String query;
    private String kbIds;
    private String request;
    private String result;
    private Integer durationMs;
    private UUID createdBy;
    private OffsetDateTime createdAt;
}