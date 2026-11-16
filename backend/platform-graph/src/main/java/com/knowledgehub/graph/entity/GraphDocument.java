package com.knowledgehub.graph.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("graph_document")
public class GraphDocument {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    private UUID documentId;
    private String status;
    private Integer entityCount;
    private Integer relationCount;
    /** 最近一次抽取失败的原因（成功时清空），界面上直接展示给运维看 */
    private String lastError;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}