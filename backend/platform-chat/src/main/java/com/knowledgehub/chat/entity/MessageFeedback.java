package com.knowledgehub.chat.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("message_feedback")
public class MessageFeedback {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID messageId;
    private UUID userId;
    private String rating;
    private String comment;
    private OffsetDateTime createdAt;
}