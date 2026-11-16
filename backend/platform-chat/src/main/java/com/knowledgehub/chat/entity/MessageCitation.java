package com.knowledgehub.chat.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.util.UUID;

@Data
@TableName("message_citation")
public class MessageCitation {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID messageId;
    private String chunkId;
    private String docId;
    private String title;
    private String url;
    private String snippet;
    private Double score;
    private Integer idx;
}