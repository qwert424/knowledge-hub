package com.knowledgehub.chat.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.knowledgehub.chat.entity.MessageCitation;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface MessageCitationMapper extends BaseMapper<MessageCitation> {
}