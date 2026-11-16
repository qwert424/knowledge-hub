package com.knowledgehub.kb.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.kb.entity.KbMember;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface KbMemberMapper extends BaseMapper<KbMember> {
}