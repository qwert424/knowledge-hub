package com.knowledgehub.chat.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("conversation")
public class Conversation {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID userId;
    private String agentKey;
    private String kbIds;
    private UUID profileId;
    private String title;
    private String model;
    private String settings;
    private String source;
    private String externalId;
    private Integer messageCount;
    private OffsetDateTime lastMessageAt;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}