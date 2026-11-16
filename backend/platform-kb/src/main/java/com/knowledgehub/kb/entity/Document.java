package com.knowledgehub.kb.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("document")
public class Document {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    private String title;
    private String sourceType;
    private String sourceRef;
    private String sourceUrl;
    private String mimeType;
    private Long sizeBytes;
    private String contentHash;
    private UUID activeVersionId;
    private String visibility;
    private String aclMode;
    private String status;
    private Boolean graphSelected;
    private String tags;
    private UUID ownerId;
    private String metadata;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
    private OffsetDateTime deletedAt;
}