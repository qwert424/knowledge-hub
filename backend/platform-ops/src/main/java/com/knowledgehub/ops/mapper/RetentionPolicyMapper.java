package com.knowledgehub.ops.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.ops.entity.RetentionPolicy;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface RetentionPolicyMapper extends BaseMapper<RetentionPolicy> {
}
