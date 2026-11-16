package com.knowledgehub.kb.entity;

import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.UUID;

@Data
@TableName("kb_member")
public class KbMember {
    @TableId
    private UUID id;
    private String tenantId;
    private UUID kbId;
    private String principalType;
    private String principalId;
    private String permission;
    private OffsetDateTime createdAt;
}