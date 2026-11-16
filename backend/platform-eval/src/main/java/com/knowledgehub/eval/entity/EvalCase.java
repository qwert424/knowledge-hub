package com.knowledgehub.eval.entity;

import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("eval_case")
public class EvalCase {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID datasetId;
    private String question;
    private String expectedAnswer;
    private String expectedDocIds;
    private OffsetDateTime createdAt;
}