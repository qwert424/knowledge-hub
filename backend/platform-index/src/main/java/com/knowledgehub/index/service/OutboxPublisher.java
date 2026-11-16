package com.knowledgehub.index.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.index.entity.OutboxEvent;
import com.knowledgehub.index.mapper.OutboxEventMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Component
public class OutboxPublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxPublisher.class);
    private static final String STREAM_PREFIX = "kh:stream:";
    private static final int MAX_RETRY = 5;

    private final OutboxEventMapper outboxMapper;
    private final StringRedisTemplate redisTemplate;

    public OutboxPublisher(OutboxEventMapper outboxMapper, StringRedisTemplate redisTemplate) {
        this.outboxMapper = outboxMapper;
        this.redisTemplate = redisTemplate;
    }

    @Scheduled(fixedDelay = 1000, initialDelay = 3000)
    @Transactional
    public void publishPending() {
        List<OutboxEvent> events = outboxMapper.selectList(Wrappers.<OutboxEvent>lambdaQuery()
                .eq(OutboxEvent::getStatus, "pending")
                .le(OutboxEvent::getNextAt, OffsetDateTime.now())
                .orderByAsc(OutboxEvent::getId)
                .last("limit 20"));
        for (OutboxEvent event : events) {
            try {
                Map<String, String> fields = new HashMap<>();
                fields.put("tenantId", event.getTenantId());
                fields.put("payload", event.getPayload());
                fields.put("eventId", String.valueOf(event.getId()));
                redisTemplate.opsForStream().add(STREAM_PREFIX + event.getTopic(), fields);
                event.setStatus("sent");
            } catch (Exception ex) {
                int retry = event.getRetryCount() == null ? 0 : event.getRetryCount() + 1;
                event.setRetryCount(retry);
                if (retry >= MAX_RETRY) {
                    event.setStatus("failed");
                    log.error("Outbox event {} exhausted retries: {}", event.getId(), ex.getMessage());
                } else {
                    event.setNextAt(OffsetDateTime.now().plusSeconds((long) Math.pow(2, retry) * 5));
                }
            }
            outboxMapper.updateById(event);
        }
    }
}