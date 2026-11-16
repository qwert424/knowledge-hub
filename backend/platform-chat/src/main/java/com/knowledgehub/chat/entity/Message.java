package com.knowledgehub.chat.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("message")
public class Message {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID conversationId;
    private String role;
    private String content;
    private String contentFormat;
    private String status;
    private String model;
    private Integer inputTokens;
    private Integer outputTokens;
    private BigDecimal costUsd;
    private Integer latencyMs;
    private String traceId;
    private String requestId;
    private UUID parentMessageId;
    /** 思考链步骤（用户可读的中文），刷新后仍能看到这条回答走了哪些阶段 */
    private String reasoningSteps;
    private OffsetDateTime createdAt;
}