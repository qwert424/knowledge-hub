package com.knowledgehub.kb.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.kb.entity.DocumentVersion;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface DocumentVersionMapper extends BaseMapper<DocumentVersion> {
}