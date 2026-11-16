package com.knowledgehub.graph.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.knowledgehub.common.api.ApiResponse;
import com.knowledgehub.graph.entity.GraphDocument;
import com.knowledgehub.graph.service.GraphService;
import com.knowledgehub.iam.security.PermissionCatalog;
import com.knowledgehub.iam.security.RequirePermission;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/graph")
@RequirePermission(PermissionCatalog.GRAPH_MANAGE)
public class GraphController {

    private final GraphService graphService;

    public GraphController(GraphService graphService) {
        this.graphService = graphService;
    }

    @GetMapping("/documents")
    public ApiResponse<List<GraphDocument>> documents(@RequestParam(required = false) String kbId) {
        return ApiResponse.ok(graphService.list(kbId));
    }

    @PostMapping("/documents")
    public ApiResponse<GraphDocument> select(@Valid @RequestBody SelectRequest request) {
        return ApiResponse.ok(graphService.select(request.kbId(), request.documentId()));
    }

    /** 取消精选：文档不再参与图谱抽取（已抽出的实体保留） */
    @DeleteMapping("/documents")
    public ApiResponse<Map<String, Object>> unselect(@Valid @RequestBody SelectRequest request) {
        graphService.unselect(request.kbId(), request.documentId());
        return ApiResponse.ok(Map.of("kbId", request.kbId(), "documentId", request.documentId(),
                "unselected", true));
    }

    @PostMapping("/build")
    public ApiResponse<Map<String, Object>> build(@Valid @RequestBody BuildRequest request) {
        return ApiResponse.ok(graphService.build(request.kbId(), request.onlyMissing()));
    }

    /** 取消抽取：当前文档抽完就停，剩余回到待抽取 */
    @PostMapping("/build/cancel")
    public ApiResponse<Map<String, Object>> cancel(@Valid @RequestBody BuildRequest request) {
        return ApiResponse.ok(graphService.cancel(request.kbId()));
    }

    /** 图谱总览：精选/已抽取/失败 文档数与实体、关系总数 */
    @GetMapping("/summary")
    public ApiResponse<Map<String, Object>> summary(@RequestParam(required = false) String kbId) {
        return ApiResponse.ok(graphService.summary(kbId));
    }

    @GetMapping("/entities")
    public ApiResponse<JsonNode> entities(@RequestParam String kbId, @RequestParam String q,
                                          @RequestParam(defaultValue = "2") int hops) {
        return ApiResponse.ok(graphService.query(kbId, q, hops));
    }

    @PostMapping("/query")
    public ApiResponse<JsonNode> query(@Valid @RequestBody QueryRequest request) {
        return ApiResponse.ok(graphService.query(request.kbId(), request.query(),
                request.hops() == null ? 2 : request.hops()));
    }

    public record SelectRequest(@NotBlank String kbId, @NotBlank String documentId) {
    }

    public record BuildRequest(@NotBlank String kbId, boolean onlyMissing) {
    }

    public record QueryRequest(@NotBlank String kbId, @NotBlank String query, Integer hops) {
    }
}