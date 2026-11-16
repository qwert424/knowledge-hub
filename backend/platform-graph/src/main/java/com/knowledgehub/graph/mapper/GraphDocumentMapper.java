package com.knowledgehub.graph.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.graph.entity.GraphDocument;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface GraphDocumentMapper extends BaseMapper<GraphDocument> {
}