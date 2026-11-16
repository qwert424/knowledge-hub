package com.knowledgehub.kb.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("chunk_meta")
public class ChunkMeta {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    private UUID documentId;
    private UUID versionId;
    private Integer chunkIndex;
    private UUID parentChunkId;
    private String blockId;
    private String blockType;
    /** 语义块类型：paragraph / table / code / image / heading / list / page（检索契约里的 kind） */
    private String kind;
    private String blockParentId;
    private Integer chunkCount;
    private Integer tableRowIndex;
    private String titlePath;
    private String contentHash;
    private Integer tokenCount;
    private String qualityFlags;
    private Boolean enabled;
    private String milvusPk;
    private OffsetDateTime createdAt;
}