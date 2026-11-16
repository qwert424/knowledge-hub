package com.knowledgehub.iam.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.iam.entity.UserGroup;
import com.knowledgehub.iam.entity.UserGroupMember;
import com.knowledgehub.iam.mapper.UserGroupMapper;
import com.knowledgehub.iam.mapper.UserGroupMemberMapper;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Service
public class GroupService {

    private final UserGroupMapper groupMapper;
    private final UserGroupMemberMapper memberMapper;

    public GroupService(UserGroupMapper groupMapper, UserGroupMemberMapper memberMapper) {
        this.groupMapper = groupMapper;
        this.memberMapper = memberMapper;
    }

    public List<GroupView> list() {
        String tenantId = TenantContext.require();
        return groupMapper.selectList(Wrappers.<UserGroup>lambdaQuery()
                        .eq(UserGroup::getTenantId, tenantId)
                        .orderByAsc(UserGroup::getCode))
                .stream()
                .map(g -> new GroupView(g.getId().toString(), g.getCode(), g.getName(),
                        memberMapper.selectCount(Wrappers.<UserGroupMember>lambdaQuery()
                                .eq(UserGroupMember::getTenantId, tenantId)
                                .eq(UserGroupMember::getGroupId, g.getId())).intValue()))
                .toList();
    }

    public GroupView create(String code, String name) {
        String tenantId = TenantContext.require();
        // ?????????????????????????????
        String resolved = (code == null || code.isBlank())
                ? "grp" + Long.toHexString(System.nanoTime()).substring(6)
                : code.trim();
        UserGroup group = new UserGroup();
        group.setId(Ids.uuid7());
        group.setTenantId(tenantId);
        group.setCode(resolved);
        group.setName(name);
        group.setCreatedAt(OffsetDateTime.now());
        groupMapper.insert(group);
        return new GroupView(group.getId().toString(), resolved, name, 0);
    }

    public void addMember(UUID groupId, UUID userId) {
        String tenantId = TenantContext.require();
        UserGroup group = groupMapper.selectById(groupId);
        if (group == null || !tenantId.equals(group.getTenantId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "用户组不存在");
        }
        Long exists = memberMapper.selectCount(Wrappers.<UserGroupMember>lambdaQuery()
                .eq(UserGroupMember::getTenantId, tenantId)
                .eq(UserGroupMember::getGroupId, groupId)
                .eq(UserGroupMember::getUserId, userId));
        if (exists != null && exists > 0) {
            return;
        }
        UserGroupMember member = new UserGroupMember();
        member.setTenantId(tenantId);
        member.setGroupId(groupId);
        member.setUserId(userId);
        memberMapper.insert(member);
    }

    public record GroupView(String id, String code, String name, int memberCount) {
    }
}