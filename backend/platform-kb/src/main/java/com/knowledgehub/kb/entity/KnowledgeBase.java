package com.knowledgehub.kb.entity;

import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("knowledge_base")
public class KnowledgeBase {
    @TableId
    private UUID id;
    private String tenantId;
    private String name;
    private String code;
    private String description;
    private String visibility;
    private String embeddingModel;
    private Integer embeddingDim;
    private String collectionName;
    private UUID defaultProfileId;
    private String chunkTemplate;
    private Boolean graphEnabled;
    private String status;
    private UUID createdBy;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
    private OffsetDateTime deletedAt;
}