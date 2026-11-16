package com.knowledgehub.index.bootstrap;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.index.entity.IndexJob;
import com.knowledgehub.index.mapper.IndexJobMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * A worker crash leaves jobs in queued/running forever. On startup, mark anything older than the
 * grace window as failed so the console shows the truth and the document can be retried.
 */
@Component
@Order(30)
public class StaleJobRecovery implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(StaleJobRecovery.class);
    private static final int GRACE_MINUTES = 30;

    private final IndexJobMapper jobMapper;

    public StaleJobRecovery(IndexJobMapper jobMapper) {
        this.jobMapper = jobMapper;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<IndexJob> stale = jobMapper.selectList(Wrappers.<IndexJob>lambdaQuery()
                .in(IndexJob::getStatus, "queued", "running")
                .lt(IndexJob::getUpdatedAt, OffsetDateTime.now().minusMinutes(GRACE_MINUTES)));
        for (IndexJob job : stale) {
            job.setStatus("failed");
            job.setErrorCode("WORKER_LOST");
            job.setErrorMessage("任务超时未完成，可能因 Worker 重启中断；请重试");
            job.setFinishedAt(OffsetDateTime.now());
            job.setUpdatedAt(OffsetDateTime.now());
            jobMapper.updateById(job);
            log.warn("Marked stale index job {} as failed (last stage {})", job.getId(), job.getStage());
        }
        if (!stale.isEmpty()) {
            log.info("Recovered {} stale index job(s)", stale.size());
        }
    }
}