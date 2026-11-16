package com.knowledgehub.retrieval.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("retrieval_profile")
public class RetrievalProfile {
    @TableId
    private UUID id;
    private String tenantId;
    private String name;
    private Integer version;
    private String config;
    private Boolean isDefault;
    private String status;
    private OffsetDateTime publishedAt;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
    /** 软删除时间：非空表示在回收站里，列表与检索都看不到，可以恢复 */
    private OffsetDateTime deletedAt;
}