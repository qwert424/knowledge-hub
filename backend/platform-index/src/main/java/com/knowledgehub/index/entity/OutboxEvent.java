package com.knowledgehub.index.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;

@Data
@TableName("outbox_event")
public class OutboxEvent {
    @TableId(type = com.baomidou.mybatisplus.annotation.IdType.AUTO)
    private Long id;
    private String tenantId;
    private String topic;
    private String payload;
    private String status;
    private Integer retryCount;
    private OffsetDateTime nextAt;
    private OffsetDateTime createdAt;
}