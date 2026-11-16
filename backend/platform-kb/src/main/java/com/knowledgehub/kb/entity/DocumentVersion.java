package com.knowledgehub.kb.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("document_version")
public class DocumentVersion {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID documentId;
    private String revision;
    private String contentHash;
    /** 内容哈希+切片参数+向量模型+流水线版本；相同则重索引可以直接跳过 */
    private String fingerprint;
    private String parser;
    private String chunkTemplate;
    private String objectKey;
    private String blockSnapshotKey;
    private String chunkSnapshotKey;
    private Integer chunkCount;
    private Integer tokenCount;
    private String status;
    private OffsetDateTime publishedAt;
    private OffsetDateTime createdAt;
}