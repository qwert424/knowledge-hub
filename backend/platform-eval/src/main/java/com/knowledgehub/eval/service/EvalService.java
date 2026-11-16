package com.knowledgehub.eval.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.spi.AuditRecorder;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.common.util.Ids;
import com.knowledgehub.eval.entity.EvalCase;
import com.knowledgehub.eval.entity.EvalDataset;
import com.knowledgehub.eval.entity.EvalRun;
import com.knowledgehub.eval.mapper.EvalCaseMapper;
import com.knowledgehub.eval.mapper.EvalDatasetMapper;
import com.knowledgehub.eval.mapper.EvalRunMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class EvalService {

    private final EvalDatasetMapper datasetMapper;
    private final EvalCaseMapper caseMapper;
    private final EvalRunMapper runMapper;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;
    private final EvalRunner runner;
    private final EvalLangfuseSync langfuseSync;

    public EvalService(EvalDatasetMapper datasetMapper, EvalCaseMapper caseMapper, EvalRunMapper runMapper,
                       AuditRecorder auditRecorder, ObjectMapper objectMapper, EvalRunner runner,
                       EvalLangfuseSync langfuseSync) {
        this.datasetMapper = datasetMapper;
        this.caseMapper = caseMapper;
        this.runMapper = runMapper;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
        this.runner = runner;
        this.langfuseSync = langfuseSync;
    }

    public List<DatasetView> datasets() {
        String tenantId = TenantContext.require();
        List<EvalDataset> rows = datasetMapper.selectList(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .isNull(EvalDataset::getDeletedAt)
                .orderByDesc(EvalDataset::getCreatedAt));
        List<DatasetView> views = new ArrayList<>();
        for (EvalDataset dataset : rows) {
            Long caseCount = caseMapper.selectCount(Wrappers.<EvalCase>lambdaQuery()
                    .eq(EvalCase::getTenantId, tenantId)
                    .eq(EvalCase::getDatasetId, dataset.getId()));
            EvalRun lastRun = runMapper.selectOne(Wrappers.<EvalRun>lambdaQuery()
                    .eq(EvalRun::getTenantId, tenantId)
                    .eq(EvalRun::getDatasetId, dataset.getId())
                    .isNull(EvalRun::getDeletedAt)
                    .orderByDesc(EvalRun::getCreatedAt)
                    .last("limit 1"));
            views.add(new DatasetView(dataset.getId().toString(), dataset.getName(), dataset.getDescription(),
                    parseKbIds(dataset), caseCount == null ? 0 : caseCount.intValue(),
                    lastRun == null ? null : lastRun.getStatus(),
                    lastRun == null ? null : lastRun.getMetrics(),
                    lastRun == null || lastRun.getFinishedAt() == null ? null : lastRun.getFinishedAt().toString()));
        }
        return views;
    }

    @Transactional
    public DatasetView createDataset(String name, String description, List<String> kbIds) {
        EvalDataset dataset = new EvalDataset();
        dataset.setId(Ids.uuid7());
        dataset.setTenantId(TenantContext.require());
        List<String> clean = kbIds == null ? List.of()
                : kbIds.stream().filter(id -> id != null && !id.isBlank()).distinct().toList();
        dataset.setKbIds(toJson(clean));
        // 兼容旧列：只绑一个库时同步写 kb_id，其它报表/查询还能用
        dataset.setKbId(clean.size() == 1 ? UUID.fromString(clean.get(0)) : null);
        dataset.setName(name);
        dataset.setDescription(description);
        dataset.setCreatedAt(OffsetDateTime.now());
        datasetMapper.insert(dataset);
        auditRecorder.record("eval.dataset.create", "eval_dataset", dataset.getId().toString(), null, name);
        // 推一份到 Langfuse（未配置或失败只记日志）
        langfuseSync.syncDataset(dataset);
        return datasets().stream().filter(view -> view.id().equals(dataset.getId().toString())).findFirst()
                .orElseGet(() -> new DatasetView(dataset.getId().toString(), name, description, clean, 0,
                        null, null, null));
    }

    /** 删除数据集：连带它的用例与运行记录一起进回收站，可整体恢复。 */
    @Transactional
    public void deleteDataset(UUID datasetId) {
        String tenantId = TenantContext.require();
        EvalDataset dataset = datasetMapper.selectOne(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .eq(EvalDataset::getId, datasetId)
                .isNull(EvalDataset::getDeletedAt));
        if (dataset == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "评测数据集不存在");
        }
        OffsetDateTime now = OffsetDateTime.now();
        datasetMapper.update(null, Wrappers.<EvalDataset>lambdaUpdate()
                .eq(EvalDataset::getId, datasetId)
                .set(EvalDataset::getDeletedAt, now));
        // 用例与运行记录跟着数据集走，恢复时一起回来
        runMapper.update(null, Wrappers.<EvalRun>lambdaUpdate()
                .eq(EvalRun::getTenantId, tenantId)
                .eq(EvalRun::getDatasetId, datasetId)
                .isNull(EvalRun::getDeletedAt)
                .set(EvalRun::getDeletedAt, now));
        auditRecorder.record("eval.dataset.delete", "eval_dataset", datasetId.toString(), dataset.getName(), "回收站");
    }

    /** 删除一条运行记录（只是评测结果，不影响数据集与用例）：进回收站。 */
    @Transactional
    public void deleteRun(UUID runId) {
        String tenantId = TenantContext.require();
        EvalRun run = runMapper.selectOne(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, tenantId)
                .eq(EvalRun::getId, runId)
                .isNull(EvalRun::getDeletedAt));
        if (run == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "评测运行不存在");
        }
        if ("running".equals(run.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "运行中的评测请先取消，再删除");
        }
        runMapper.update(null, Wrappers.<EvalRun>lambdaUpdate()
                .eq(EvalRun::getId, runId)
                .set(EvalRun::getDeletedAt, OffsetDateTime.now()));
        auditRecorder.record("eval.run.delete", "eval_run", runId.toString(), run.getStatus(), "回收站");
    }

    /** 回收站内容：数据集和运行记录分开列，界面一眼能分清恢复哪个。 */
    public Map<String, Object> trash() {
        String tenantId = TenantContext.require();
        List<EvalDataset> datasets = datasetMapper.selectList(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .isNotNull(EvalDataset::getDeletedAt)
                .orderByDesc(EvalDataset::getDeletedAt));
        List<EvalRun> runs = runMapper.selectList(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, tenantId)
                .isNotNull(EvalRun::getDeletedAt)
                .orderByDesc(EvalRun::getDeletedAt));
        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("datasets", datasets.stream().map(d -> Map.of(
                "id", d.getId().toString(),
                "name", d.getName() == null ? "" : d.getName(),
                "deletedAt", String.valueOf(d.getDeletedAt()))).toList());
        payload.put("runs", runs.stream().map(r -> Map.of(
                "id", r.getId().toString(),
                "datasetId", r.getDatasetId().toString(),
                "status", r.getStatus(),
                "deletedAt", String.valueOf(r.getDeletedAt()))).toList());
        return payload;
    }

    @Transactional
    public void restoreDataset(UUID datasetId) {
        String tenantId = TenantContext.require();
        datasetMapper.update(null, Wrappers.<EvalDataset>lambdaUpdate()
                .eq(EvalDataset::getTenantId, tenantId)
                .eq(EvalDataset::getId, datasetId)
                .set(EvalDataset::getDeletedAt, null));
        runMapper.update(null, Wrappers.<EvalRun>lambdaUpdate()
                .eq(EvalRun::getTenantId, tenantId)
                .eq(EvalRun::getDatasetId, datasetId)
                .set(EvalRun::getDeletedAt, null));
        auditRecorder.record("eval.dataset.restore", "eval_dataset", datasetId.toString(), "回收站", "已恢复");
    }

    @Transactional
    public void restoreRun(UUID runId) {
        runMapper.update(null, Wrappers.<EvalRun>lambdaUpdate()
                .eq(EvalRun::getTenantId, TenantContext.require())
                .eq(EvalRun::getId, runId)
                .set(EvalRun::getDeletedAt, null));
        auditRecorder.record("eval.run.restore", "eval_run", runId.toString(), "回收站", "已恢复");
    }

    /** 彻底删除：数据集连用例与运行记录一起真删 */
    @Transactional
    public void purgeDataset(UUID datasetId) {
        String tenantId = TenantContext.require();
        caseMapper.delete(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, tenantId)
                .eq(EvalCase::getDatasetId, datasetId));
        runMapper.delete(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, tenantId)
                .eq(EvalRun::getDatasetId, datasetId));
        datasetMapper.delete(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .eq(EvalDataset::getId, datasetId));
        auditRecorder.record("eval.dataset.purge", "eval_dataset", datasetId.toString(), null, "彻底删除");
    }

    @Transactional
    public void purgeRun(UUID runId) {
        runMapper.delete(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, TenantContext.require())
                .eq(EvalRun::getId, runId));
        auditRecorder.record("eval.run.purge", "eval_run", runId.toString(), null, "彻底删除");
    }

    /** 清空回收站 */
    @Transactional
    public int purgeAll() {
        String tenantId = TenantContext.require();
        List<EvalDataset> datasets = datasetMapper.selectList(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .isNotNull(EvalDataset::getDeletedAt));
        for (EvalDataset dataset : datasets) {
            purgeDataset(dataset.getId());
        }
        int runs = runMapper.delete(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, tenantId)
                .isNotNull(EvalRun::getDeletedAt));
        auditRecorder.record("eval.trash.purge", "eval_dataset", null, null, "清空回收站");
        return datasets.size() + runs;
    }

    private List<String> parseKbIds(EvalDataset dataset) {
        String raw = dataset.getKbIds();
        if (raw != null && !raw.isBlank()) {
            try {
                List<?> parsed = objectMapper.readValue(raw, List.class);
                List<String> ids = parsed.stream().map(String::valueOf).filter(id -> !id.isBlank()).toList();
                if (!ids.isEmpty()) {
                    return ids;
                }
            } catch (Exception ignored) {
                // 落到下面的旧列兜底
            }
        }
        return dataset.getKbId() == null ? List.of() : List.of(dataset.getKbId().toString());
    }

    public List<EvalCase> cases(UUID datasetId) {
        return caseMapper.selectList(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId)
                .orderByAsc(EvalCase::getCreatedAt));
    }

    @Transactional
    public int addCases(UUID datasetId, List<CaseInput> inputs) {
        if (inputs == null || inputs.isEmpty()) {
            return 0;
        }
        String tenantId = TenantContext.require();
        // 数据集必须先存在：否则用例会挂到不存在的 dataset_id 上，永远跑不出来也查不到
        EvalDataset dataset = datasetMapper.selectOne(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, tenantId)
                .eq(EvalDataset::getId, datasetId));
        if (dataset == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "评测数据集不存在");
        }
        for (CaseInput input : inputs) {
            EvalCase evalCase = new EvalCase();
            evalCase.setId(Ids.uuid7());
            evalCase.setTenantId(tenantId);
            evalCase.setDatasetId(datasetId);
            evalCase.setQuestion(input.question());
            evalCase.setExpectedAnswer(input.expectedAnswer());
            evalCase.setExpectedDocIds(toJson(input.expectedDocIds()));
            evalCase.setCreatedAt(OffsetDateTime.now());
            caseMapper.insert(evalCase);
            langfuseSync.syncCase(dataset, evalCase);
        }
        return inputs.size();
    }

    /** ???????????????????????? */
    @Transactional
    public void updateCase(UUID datasetId, UUID caseId, CaseInput input) {
        EvalCase evalCase = caseMapper.selectOne(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId)
                .eq(EvalCase::getId, caseId));
        if (evalCase == null) {
            throw new IllegalArgumentException("case not found");
        }
        evalCase.setQuestion(input.question());
        evalCase.setExpectedAnswer(input.expectedAnswer());
        evalCase.setExpectedDocIds(toJson(input.expectedDocIds()));
        caseMapper.updateById(evalCase);
        EvalDataset dataset = datasetMapper.selectById(datasetId);
        if (dataset != null) {
            langfuseSync.syncCase(dataset, evalCase);
        }
    }

    @Transactional
    public void deleteCase(UUID datasetId, UUID caseId) {
        caseMapper.delete(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId)
                .eq(EvalCase::getId, caseId));
    }

    @Transactional
    public UUID createRun(UUID datasetId, UUID profileId) {
        return createRuns(List.of(datasetId), profileId).get(0);
    }

    /**
     * 一次给多个数据集发起评测（同一个策略）：每个数据集生成一条运行记录，
     * 这样"同一策略横向对比多个数据集"和"逐个看明细"都不冲突。
     */
    @Transactional
    public List<UUID> createRuns(List<UUID> datasetIds, UUID profileId) {
        if (datasetIds == null || datasetIds.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请至少选择一个数据集");
        }
        List<UUID> runIds = new ArrayList<>();
        for (UUID datasetId : datasetIds.stream().distinct().toList()) {
            runIds.add(createSingleRun(datasetId, profileId));
        }
        return runIds;
    }

    private UUID createSingleRun(UUID datasetId, UUID profileId) {
        Long count = caseMapper.selectCount(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId));
        if (count == null || count == 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "数据集没有用例，无法发起评测");
        }
        EvalRun run = new EvalRun();
        run.setId(Ids.uuid7());
        run.setTenantId(TenantContext.require());
        run.setDatasetId(datasetId);
        run.setProfileId(profileId);
        run.setStatus("queued");
        run.setMetrics("{}");
        run.setCreatedAt(OffsetDateTime.now());
        runMapper.insert(run);
        auditRecorder.record("eval.run.create", "eval_run", run.getId().toString(), null, datasetId.toString());
        // 真正跑起来：逐条用例走真实检索链路，结果写回 metrics（链路会出现在 Langfuse）
        EvalDataset dataset = datasetMapper.selectById(datasetId);
        List<String> scope = dataset == null ? List.of() : parseKbIds(dataset);
        runner.submit(run.getId(), datasetId, profileId, UserContext.require(), TenantContext.require(), scope);
        return run.getId();
    }

    /** 取消一个评测：排队中的直接置为 canceled，执行中的会在下一个用例前停下 */
    public void cancelRun(UUID runId) {
        EvalRun run = runMapper.selectOne(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, TenantContext.require())
                .eq(EvalRun::getId, runId));
        if (run == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "评测运行不存在");
        }
        if ("succeeded".equals(run.getStatus()) || "failed".equals(run.getStatus())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "已结束的评测不能取消");
        }
        runner.cancel(runId);
        auditRecorder.record("eval.run.cancel", "eval_run", runId.toString(), run.getStatus(), null);
    }

    public List<EvalRun> runs(UUID datasetId) {
        return runMapper.selectList(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, TenantContext.require())
                .isNull(EvalRun::getDeletedAt)
                .eq(datasetId != null, EvalRun::getDatasetId, datasetId)
                .orderByDesc(EvalRun::getCreatedAt));
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value == null ? List.of() : value);
        } catch (Exception ex) {
            return "[]";
        }
    }

    public record CaseInput(String question, String expectedAnswer, List<String> expectedDocIds) {
    }

    /** 数据集视图：带用例数、绑定知识库与最近一次运行的分数，列表一屏能看懂 */
    public record DatasetView(String id, String name, String description, List<String> kbIds, int caseCount,
                              String lastRunStatus, String lastRunMetrics, String lastRunAt) {
    }
}