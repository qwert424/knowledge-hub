package com.knowledgehub.eval.service;

import com.knowledgehub.eval.entity.EvalCase;
import com.knowledgehub.eval.entity.EvalDataset;
import com.knowledgehub.integration.platform.LangfuseConsoleClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 评测 ↔ Langfuse 数据集同步。
 *
 * <p>以前只有 trace 进 Langfuse，评测集本身留在我们自己库里，Langfuse 上既看不到
 * 「期望答案」，也没法按 run 对比。这里做双向：
 * <ul>
 *   <li>数据集与用例 → Langfuse Dataset / Dataset Item（item id 用用例 id，重复同步是覆盖）</li>
 *   <li>每条用例的真实回复 → 一条 trace，并挂到同名的 dataset run 上</li>
 * </ul>
 * Langfuse 未配置或临时失败只记日志，绝不影响评测本身跑完。
 */
@Component
public class EvalLangfuseSync {

    private static final Logger log = LoggerFactory.getLogger(EvalLangfuseSync.class);

    private final LangfuseConsoleClient langfuse;

    public EvalLangfuseSync(LangfuseConsoleClient langfuse) {
        this.langfuse = langfuse;
    }

    public String datasetName(EvalDataset dataset) {
        return "kh-eval:" + dataset.getId();
    }

    public String runName(String datasetId, String runId) {
        return "kh-run:" + runId;
    }

    public boolean enabled() {
        return langfuse.configured();
    }

    /** 数据集本体（名称 + 描述）推到 Langfuse */
    public void syncDataset(EvalDataset dataset) {
        if (!enabled()) {
            return;
        }
        try {
            langfuse.upsertDataset(datasetName(dataset),
                    dataset.getDescription() == null ? dataset.getName() : dataset.getDescription());
        } catch (RuntimeException ex) {
            log.warn("langfuse dataset sync skipped: {}", ex.getMessage());
        }
    }

    /** 一条用例 = 一个 dataset item：input 是问题，expectedOutput 是期望答案 */
    public void syncCase(EvalDataset dataset, EvalCase evalCase) {
        if (!enabled()) {
            return;
        }
        try {
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("expectedDocIds", evalCase.getExpectedDocIds());
            metadata.put("datasetId", dataset.getId().toString());
            langfuse.upsertDatasetItem(datasetName(dataset), evalCase.getId().toString(),
                    evalCase.getQuestion(), evalCase.getExpectedAnswer(), metadata);
        } catch (RuntimeException ex) {
            log.warn("langfuse dataset item sync skipped: {}", ex.getMessage());
        }
    }

    /** 运行结果：把真实回复写成 trace 并挂到 dataset run 上 */
    public void syncRunItem(String runName, String caseId, String traceId, String question,
                            String answer, Map<String, Object> metadata) {
        if (!enabled()) {
            return;
        }
        try {
            langfuse.linkRunItem(runName, caseId, traceId, question, answer, metadata);
        } catch (RuntimeException ex) {
            log.warn("langfuse run item sync skipped: {}", ex.getMessage());
        }
    }
}
