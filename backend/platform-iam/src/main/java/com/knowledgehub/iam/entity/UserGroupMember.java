package com.knowledgehub.iam.entity;

import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.util.UUID;

@Data
@TableName("user_group_member")
public class UserGroupMember {
    private String tenantId;
    private UUID groupId;
    private UUID userId;
}