package com.knowledgehub.datasource.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("datasource")
public class Datasource {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    private String type;
    private String name;
    private String config;
    private String secretEnc;
    private String status;
    private OffsetDateTime lastSyncAt;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}