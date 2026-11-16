package com.knowledgehub.eval.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("eval_run")
public class EvalRun {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID datasetId;
    private UUID profileId;
    private String status;
    private String metrics;
    private OffsetDateTime startedAt;
    private OffsetDateTime finishedAt;
    private OffsetDateTime createdAt;
    /** 回收站：非空表示已删除（可恢复） */
    private OffsetDateTime deletedAt;
}