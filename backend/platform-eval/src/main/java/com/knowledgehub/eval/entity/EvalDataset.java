package com.knowledgehub.eval.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("eval_dataset")
public class EvalDataset {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    /** 绑定的知识库（可多个）；空数组表示"不限库" */
    private String kbIds;
    private String name;
    private String description;
    private OffsetDateTime createdAt;
    /** 回收站：非空表示已删除（可恢复） */
    private OffsetDateTime deletedAt;
}