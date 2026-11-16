package com.knowledgehub.eval.service;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.knowledgehub.common.security.CurrentUser;
import com.knowledgehub.common.security.UserContext;
import com.knowledgehub.common.tenant.TenantContext;
import com.knowledgehub.eval.entity.EvalCase;
import com.knowledgehub.eval.entity.EvalRun;
import com.knowledgehub.eval.mapper.EvalCaseMapper;
import com.knowledgehub.eval.mapper.EvalRunMapper;
import com.knowledgehub.kb.service.DocumentService;
import com.knowledgehub.retrieval.service.RetrievalProfileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 评测执行器。
 *
 * <p>逐条用例走真实链路（和用户端同一条 chat 链路 + 同一个检索策略），产出四件事：
 * 召回到了哪些文档、真实回复、回复与「期望答案」的相似度、以及命中判定。
 * 三块分数分开算，避免"检索命中但答错"被算成通过：
 * <ul>
 *   <li>hitRate：只统计填了「期望文档」的用例</li>
 *   <li>answerAccuracy：只统计填了「期望答案」的用例，字符二元组 F1 ≥ 0.5 记为答对</li>
 *   <li>answerRate：模型到底给出内容没有（防止全是空回复还显示高分）</li>
 * </ul>
 */
@Component
public class EvalRunner {

    private static final Logger log = LoggerFactory.getLogger(EvalRunner.class);

    /** 答案判定通过线：字符二元组 F1，0.5 大致等于"主要信息点都说到了" */
    private static final double ANSWER_PASS = 0.5;

    private static final ExecutorService POOL = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "eval-runner");
        thread.setDaemon(true);
        return thread;
    });

    /** runId -> 取消标记：每个用例开始前检查一次 */
    private final Map<UUID, Boolean> cancelFlags = new ConcurrentHashMap<>();

    private final EvalRunMapper runMapper;
    private final EvalCaseMapper caseMapper;
    private final RetrievalProfileService profileService;
    private final com.knowledgehub.kb.service.KbService kbService;
    private final DocumentService documentService;
    private final ObjectMapper objectMapper;
    private final EvalLangfuseSync langfuseSync;
    private final com.knowledgehub.eval.mapper.EvalDatasetMapper datasetMapper;

    public EvalRunner(EvalRunMapper runMapper, EvalCaseMapper caseMapper,
                      RetrievalProfileService profileService,
                      com.knowledgehub.kb.service.KbService kbService,
                      DocumentService documentService,
                      ObjectMapper objectMapper,
                      EvalLangfuseSync langfuseSync,
                      com.knowledgehub.eval.mapper.EvalDatasetMapper datasetMapper) {
        this.runMapper = runMapper;
        this.caseMapper = caseMapper;
        this.profileService = profileService;
        this.kbService = kbService;
        this.documentService = documentService;
        this.objectMapper = objectMapper;
        this.langfuseSync = langfuseSync;
        this.datasetMapper = datasetMapper;
    }

    /** 提交到后台执行；执行期间 run 状态是 running，用户能实时看到进度。 */
    public void submit(UUID runId, UUID datasetId, UUID profileId, CurrentUser user, String tenantId,
                       List<String> kbIds) {
        POOL.submit(() -> {
            UserContext.set(user);
            TenantContext.set(tenantId);
            try {
                execute(runId, datasetId, profileId, kbIds);
            } catch (RuntimeException ex) {
                log.warn("eval run {} failed: {}", runId, ex.getMessage());
                finish(runId, "failed", Map.of("error", String.valueOf(ex.getMessage())));
            } finally {
                UserContext.clear();
                TenantContext.clear();
                cancelFlags.remove(runId);
            }
        });
    }

    public void cancel(UUID runId) {
        cancelFlags.put(runId, Boolean.TRUE);
        EvalRun run = runMapper.selectById(runId);
        if (run != null && "queued".equals(run.getStatus())) {
            finish(runId, "canceled", Map.of("canceled", true));
        }
    }

    private void execute(UUID runId, UUID datasetId, UUID profileId, List<String> kbIds) {
        List<EvalCase> cases = caseMapper.selectList(Wrappers.<EvalCase>lambdaQuery()
                .eq(EvalCase::getTenantId, TenantContext.require())
                .eq(EvalCase::getDatasetId, datasetId)
                .orderByAsc(EvalCase::getCreatedAt));
        Stats stats = new Stats();
        stats.total = cases.size();
        markRunning(runId, stats.total);

        List<Map<String, Object>> details = new ArrayList<>();

        // 数据集没绑知识库时，"不限库"= 调用者有权访问的全部知识库。
        // 票据里 kb_ids 为空就等于没有检索范围，引擎会直接返回空——所以这里必须先展开。
        List<String> scope = kbIds == null || kbIds.isEmpty() ? accessibleKbIds() : kbIds;
        Map<String, String> docTitles = documentTitles(scope);
        String runName = langfuseSync.runName(datasetId.toString(), runId.toString());
        com.knowledgehub.eval.entity.EvalDataset datasetForSync = datasetMapper.selectById(datasetId);

        for (EvalCase evalCase : cases) {
            if (Boolean.TRUE.equals(cancelFlags.get(runId))) {
                finish(runId, "canceled", metrics(stats, details));
                return;
            }
            Map<String, Object> row = runCase(evalCase, scope, profileId, docTitles, stats);
            if (datasetForSync != null) {
                // 同步第一步：确保数据集与条目在 Langfuse 侧存在（旧数据也能补齐）
                langfuseSync.syncDataset(datasetForSync);
                langfuseSync.syncCase(datasetForSync, evalCase);
            }
            langfuseSync.syncRunItem(runName, evalCase.getId().toString(),
                    evalCase.getId().toString(), evalCase.getQuestion(),
                    String.valueOf(row.getOrDefault("answer", "")),
                    Map.of(
                            "answerScore", String.valueOf(row.getOrDefault("answerScore", "")),
                            "docHit", String.valueOf(row.getOrDefault("docHit", "")),
                            "hitDocs", String.valueOf(row.getOrDefault("hitDocTitles", ""))));
            details.add(row);
            stats.done++;
            updateProgress(runId, stats);
        }
        finish(runId, "succeeded", metrics(stats, details));
    }

    /** 跑一条用例：先取召回文档（判命中），再走真实问答（判答案）。 */
    private Map<String, Object> runCase(EvalCase evalCase, List<String> scope, UUID profileId,
                                       Map<String, String> docTitles, Stats stats) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("caseId", evalCase.getId().toString());
        row.put("question", evalCase.getQuestion());
        row.put("expectedAnswer", evalCase.getExpectedAnswer());
        List<String> expected = parseIds(evalCase.getExpectedDocIds());
        row.put("expectedDocs", expected);
        row.put("expectedDocTitles", expected.stream().map(id -> docTitles.getOrDefault(id, id)).toList());

        // 1) 召回：和调试台同一条链路
        Set<String> gotDocs = new HashSet<>();
        String error = null;
        try {
            JsonNode result = profileService.test(evalCase.getQuestion(), scope, profileId, 8, List.of());
            for (JsonNode chunk : result.path("chunks")) {
                String docId = chunk.path("doc_id").asText("");
                String title = chunk.path("title").asText("");
                if (!docId.isBlank()) {
                    gotDocs.add(docId);
                    if (!title.isBlank()) {
                        docTitles.putIfAbsent(docId, title);
                    }
                }
            }
            JsonNode retrError = result.path("error");
            if (!retrError.isMissingNode() && !retrError.isNull()) {
                error = retrError.asText("");
            }
        } catch (RuntimeException ex) {
            error = String.valueOf(ex.getMessage());
        }
        List<String> hitIds = gotDocs.stream().toList();
        row.put("hitDocs", hitIds);
        row.put("hitDocTitles", hitIds.stream().map(id -> docTitles.getOrDefault(id, id)).toList());
        Boolean docHit = expected.isEmpty()
                ? (gotDocs.isEmpty() ? Boolean.FALSE : Boolean.TRUE)
                : gotDocs.stream().anyMatch(expected::contains);
        row.put("docHit", docHit);
        if (!expected.isEmpty()) {
            stats.docScored++;
            if (Boolean.TRUE.equals(docHit)) {
                stats.docHit++;
            }
        }

        // 2) 真实回复：走 chat 链路，和用户看到的答复一致
        String answer = "";
        try {
            JsonNode reply = profileService.answer(evalCase.getQuestion(), scope, profileId, null);
            answer = reply.path("answer").asText("");
            JsonNode answerError = reply.path("error");
            if (!answerError.isMissingNode() && !answerError.isNull() && answer.isBlank()) {
                error = answerError.path("message").asText("模型未返回内容");
            }
        } catch (RuntimeException ex) {
            error = String.valueOf(ex.getMessage());
        }
        row.put("answer", answer);
        row.put("error", error);
        if (!answer.isBlank()) {
            stats.answered++;
        } else if (error != null) {
            stats.failed++;
        }

        // 3) 答案判定：只统计填了期望答案的用例
        String expectedAnswer = evalCase.getExpectedAnswer();
        if (expectedAnswer != null && !expectedAnswer.isBlank()) {
            double score = similarity(answer, expectedAnswer);
            stats.answerScored++;
            stats.answerScoreSum += score;
            boolean pass = score >= ANSWER_PASS;
            if (pass) {
                stats.answerPassed++;
            }
            row.put("answerScore", round(score));
            row.put("answerPass", pass);
        } else {
            row.put("answerScore", null);
            row.put("answerPass", null);
        }
        return row;
    }

    /**
     * 字符二元组 F1，中文友好且不引入额外依赖。
     * 期望答案整段出现在回复里（要点说全了）直接给 1.0。
     */
    static double similarity(String answer, String expected) {
        String a = normalise(answer);
        String e = normalise(expected);
        if (a.isEmpty() || e.isEmpty()) {
            return 0.0;
        }
        if (a.contains(e)) {
            return 1.0;
        }
        Map<String, Integer> aGrams = grams(a);
        Map<String, Integer> eGrams = grams(e);
        int overlap = 0;
        for (Map.Entry<String, Integer> entry : eGrams.entrySet()) {
            Integer mine = aGrams.get(entry.getKey());
            if (mine != null) {
                overlap += Math.min(mine, entry.getValue());
            }
        }
        int aTotal = aGrams.values().stream().mapToInt(Integer::intValue).sum();
        int eTotal = eGrams.values().stream().mapToInt(Integer::intValue).sum();
        if (aTotal == 0 || eTotal == 0) {
            return 0.0;
        }
        double precision = (double) overlap / aTotal;
        double recall = (double) overlap / eTotal;
        return precision + recall == 0 ? 0.0 : 2 * precision * recall / (precision + recall);
    }

    private static String normalise(String text) {
        if (text == null) {
            return "";
        }
        return text.toLowerCase(Locale.ROOT)
                .replaceAll("[\\s\\p{Punct}，。；：！？、“”‘’（）《》【】、·—…]", "");
    }

    private static Map<String, Integer> grams(String text) {
        Map<String, Integer> counts = new HashMap<>();
        if (text.length() == 1) {
            counts.merge(text, 1, Integer::sum);
            return counts;
        }
        for (int i = 0; i + 1 < text.length(); i++) {
            counts.merge(text.substring(i, i + 2), 1, Integer::sum);
        }
        return counts;
    }

    private Map<String, Object> metrics(Stats stats, List<Map<String, Object>> details) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("cases", stats.total);
        payload.put("done", stats.done);
        payload.put("docScored", stats.docScored);
        payload.put("answerScored", stats.answerScored);
        // 没有期望文档的用例不参与命中率，避免"全命中"的假象
        if (stats.docScored > 0) {
            payload.put("hitRate", round((double) stats.docHit / stats.docScored));
        }
        if (stats.answerScored > 0) {
            payload.put("answerAccuracy", round((double) stats.answerPassed / stats.answerScored));
            payload.put("answerScore", round(stats.answerScoreSum / stats.answerScored));
        }
        payload.put("answerRate", stats.done == 0 ? 0 : round((double) stats.answered / stats.done));
        payload.put("failed", stats.failed);
        payload.put("details", details.size() > 50 ? details.subList(0, 50) : details);
        return payload;
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }

    /** 当前用户可读的知识库 id（评测"不限库"时的检索范围）。 */
    private List<String> accessibleKbIds() {
        CurrentUser user = UserContext.require();
        return kbService.list(null, 1, 200, user).items().stream()
                .map(com.knowledgehub.kb.service.KbService.KbView::id)
                .filter(id -> id != null && !id.isBlank())
                .toList();
    }

    /** 检索范围内全部文档 id -> 标题，明细里给人看标题而不是裸 UUID。 */
    private Map<String, String> documentTitles(List<String> kbIds) {
        Map<String, String> titles = new HashMap<>();
        for (String kbId : kbIds) {
            try {
                documentService.list(kbId, null, null, 1, 200).items()
                        .forEach(doc -> titles.put(doc.id(), doc.title()));
            } catch (RuntimeException ex) {
                log.debug("eval: cannot list documents of kb {}: {}", kbId, ex.getMessage());
            }
        }
        return titles;
    }

    private List<String> parseIds(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            JsonNode node = objectMapper.readTree(raw);
            List<String> ids = new ArrayList<>();
            node.forEach(item -> ids.add(item.asText()));
            return ids;
        } catch (Exception ex) {
            return List.of();
        }
    }

    private void markRunning(UUID runId, int total) {
        EvalRun run = runMapper.selectById(runId);
        if (run == null) {
            return;
        }
        run.setStatus("running");
        run.setStartedAt(OffsetDateTime.now());
        run.setMetrics(writeJson(Map.of("cases", total, "done", 0)));
        runMapper.updateById(run);
    }

    private void updateProgress(UUID runId, Stats stats) {
        EvalRun run = runMapper.selectById(runId);
        if (run == null) {
            return;
        }
        Map<String, Object> progress = new LinkedHashMap<>();
        progress.put("cases", stats.total);
        progress.put("done", stats.done);
        progress.put("docScored", stats.docScored);
        progress.put("answerScored", stats.answerScored);
        if (stats.docScored > 0) {
            progress.put("hitRate", round((double) stats.docHit / stats.docScored));
        }
        if (stats.answerScored > 0) {
            progress.put("answerAccuracy", round((double) stats.answerPassed / stats.answerScored));
            progress.put("answerScore", round(stats.answerScoreSum / stats.answerScored));
        }
        progress.put("answerRate", stats.done == 0 ? 0 : round((double) stats.answered / stats.done));
        progress.put("failed", stats.failed);
        run.setMetrics(writeJson(progress));
        runMapper.updateById(run);
    }

    private void finish(UUID runId, String status, Map<String, Object> metrics) {
        EvalRun run = runMapper.selectById(runId);
        if (run == null) {
            return;
        }
        run.setStatus(status);
        run.setFinishedAt(OffsetDateTime.now());
        run.setMetrics(writeJson(metrics));
        runMapper.updateById(run);
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ex) {
            return "{}";
        }
    }

    /** 一次运行的累计计数，省得在方法间来回传一长串局部变量 */
    private static final class Stats {
        private int total;
        private int done;
        private int docScored;
        private int docHit;
        private int answerScored;
        private int answerPassed;
        private double answerScoreSum;
        private int answered;
        private int failed;
    }
}
