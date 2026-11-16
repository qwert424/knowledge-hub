package com.knowledgehub.datasource.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.crypto.AesGcmCipher;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.datasource.entity.Datasource;
import com.knowledgehub.datasource.entity.SyncRun;
import com.knowledgehub.datasource.mapper.DatasourceMapper;
import com.knowledgehub.datasource.mapper.SyncRunMapper;
import com.knowledgehub.integration.feishu.FeishuClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class DatasourceService {

    private final DatasourceMapper datasourceMapper;
    private final SyncRunMapper syncRunMapper;
    private final FeishuClient feishuClient;
    private final AesGcmCipher cipher;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;

    public DatasourceService(DatasourceMapper datasourceMapper, SyncRunMapper syncRunMapper,
                             FeishuClient feishuClient, AesGcmCipher cipher, AuditRecorder auditRecorder,
                             ObjectMapper objectMapper) {
        this.datasourceMapper = datasourceMapper;
        this.syncRunMapper = syncRunMapper;
        this.feishuClient = feishuClient;
        this.cipher = cipher;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
    }

    public List<DatasourceView> list() {
        String tenantId = TenantContext.require();
        return datasourceMapper.selectList(Wrappers.<Datasource>lambdaQuery()
                        .eq(Datasource::getTenantId, tenantId)
                        .orderByDesc(Datasource::getCreatedAt))
                .stream().map(this::toView).toList();
    }

    @Transactional
    public DatasourceView create(String kbId, String type, String name, Map<String, Object> config,
                                 String secret) {
        String tenantId = TenantContext.require();
        Datasource datasource = new Datasource();
        datasource.setId(Ids.uuid7());
        datasource.setTenantId(tenantId);
        datasource.setKbId(UUID.fromString(kbId));
        datasource.setType(type);
        datasource.setName(name);
        datasource.setConfig(toJson(config));
        datasource.setSecretEnc(secret == null || secret.isBlank() ? null : cipher.encrypt(secret));
        datasource.setStatus("active");
        datasource.setCreatedAt(OffsetDateTime.now());
        datasource.setUpdatedAt(OffsetDateTime.now());
        datasourceMapper.insert(datasource);
        auditRecorder.record("datasource.create", "datasource", datasource.getId().toString(), null, type);
        return toView(datasource);
    }

    public String test(UUID id) {
        Datasource datasource = require(id);
        return switch (datasource.getType()) {
            case "feishu" -> feishuClient.configured() ? "OK" : "飞书未配置 app_id/app_secret";
            case "upload" -> "OK";
            default -> "暂不支持的渠道类型: " + datasource.getType();
        };
    }

    @Transactional
    public UUID sync(UUID id) {
        Datasource datasource = require(id);
        SyncRun run = new SyncRun();
        run.setId(Ids.uuid7());
        run.setTenantId(datasource.getTenantId());
        run.setDatasourceId(datasource.getId());
        run.setStatus("queued");
        run.setStats("{}");
        run.setStartedAt(OffsetDateTime.now());
        run.setCreatedAt(OffsetDateTime.now());
        syncRunMapper.insert(run);
        auditRecorder.record("datasource.sync", "datasource", id.toString(), null, run.getId().toString());
        return run.getId();
    }

    public List<SyncRun> runs(UUID id) {
        Datasource datasource = require(id);
        return syncRunMapper.selectList(Wrappers.<SyncRun>lambdaQuery()
                .eq(SyncRun::getTenantId, datasource.getTenantId())
                .eq(SyncRun::getDatasourceId, id)
                .orderByDesc(SyncRun::getCreatedAt)
                .last("limit 50"));
    }

    private Datasource require(UUID id) {
        Datasource datasource = datasourceMapper.selectOne(Wrappers.<Datasource>lambdaQuery()
                .eq(Datasource::getTenantId, TenantContext.require())
                .eq(Datasource::getId, id));
        if (datasource == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "数据源不存在");
        }
        return datasource;
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value == null ? Map.of() : value);
        } catch (Exception ex) {
            return "{}";
        }
    }

    private DatasourceView toView(Datasource datasource) {
        return new DatasourceView(datasource.getId().toString(), datasource.getKbId().toString(),
                datasource.getType(), datasource.getName(), datasource.getConfig(), datasource.getStatus(),
                datasource.getLastSyncAt() == null ? null : datasource.getLastSyncAt().toString());
    }

    public record DatasourceView(String id, String kbId, String type, String name, String config, String status,
                                 String lastSyncAt) {
    }
}