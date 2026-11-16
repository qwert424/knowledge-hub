package com.knowledgehub.eval.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;
import com.knowledgehub.common.spi.AuditRecorder;
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
import java.util.List;
import java.util.UUID;

@Service
public class EvalService {

    private final EvalDatasetMapper datasetMapper;
    private final EvalCaseMapper caseMapper;
    private final EvalRunMapper runMapper;
    private final AuditRecorder auditRecorder;
    private final ObjectMapper objectMapper;

    public EvalService(EvalDatasetMapper datasetMapper, EvalCaseMapper caseMapper, EvalRunMapper runMapper,
                       AuditRecorder auditRecorder, ObjectMapper objectMapper) {
        this.datasetMapper = datasetMapper;
        this.caseMapper = caseMapper;
        this.runMapper = runMapper;
        this.auditRecorder = auditRecorder;
        this.objectMapper = objectMapper;
    }

    public List<EvalDataset> datasets() {
        return datasetMapper.selectList(Wrappers.<EvalDataset>lambdaQuery()
                .eq(EvalDataset::getTenantId, TenantContext.require())
                .orderByDesc(EvalDataset::getCreatedAt));
    }

    @Transactional
    public EvalDataset createDataset(String name, String description, String kbId) {
        EvalDataset dataset = new EvalDataset();
        dataset.setId(Ids.uuid7());
        dataset.setTenantId(TenantContext.require());
        dataset.setKbId(kbId == null || kbId.isBlank() ? null : UUID.fromString(kbId));
        dataset.setName(name);
        dataset.setDescription(description);
        dataset.setCreatedAt(OffsetDateTime.now());
        datasetMapper.insert(dataset);
        auditRecorder.record("eval.dataset.create", "eval_dataset", dataset.getId().toString(), null, name);
        return dataset;
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
        }
        return inputs.size();
    }

    @Transactional
    public UUID createRun(UUID datasetId, UUID profileId) {
        Long count = caseMapper.selectCount(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId));
        if (count == null || count == 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "数据集没有用例");
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
        return run.getId();
    }

    public List<EvalRun> runs(UUID datasetId) {
        return runMapper.selectList(Wrappers.<EvalRun>lambdaQuery()
                .eq(EvalRun::getTenantId, TenantContext.require())
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
}