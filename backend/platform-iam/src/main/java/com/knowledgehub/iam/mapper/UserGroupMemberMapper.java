package com.knowledgehub.iam.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.iam.entity.UserGroupMember;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserGroupMemberMapper extends BaseMapper<UserGroupMember> {
}