package com.knowledgehub.datasource.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.datasource.entity.SyncRun;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface SyncRunMapper extends BaseMapper<SyncRun> {
}