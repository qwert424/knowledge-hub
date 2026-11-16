package com.knowledgehub.datasource.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.datasource.entity.Datasource;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface DatasourceMapper extends BaseMapper<Datasource> {
}