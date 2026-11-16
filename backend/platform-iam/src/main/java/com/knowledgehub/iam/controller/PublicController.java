package com.knowledgehub.iam.controller;

import com.knowledgehub.common.api.ApiResponse;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Unauthenticated endpoints needed before login (tenant picker on the login form).
 * Only non-sensitive tenant identity is exposed.
 */
@RestController
@RequestMapping("/api/v1/public")
public class PublicController {

    private final JdbcTemplate jdbcTemplate;

    public PublicController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/tenants")
    public ApiResponse<Map<String, Object>> tenants() {
        List<Map<String, Object>> items = jdbcTemplate.query(
                "select id, code, name from tenant where status = 'active' order by created_at",
                (rs, rowNum) -> {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", rs.getString("id"));
                    item.put("code", rs.getString("code"));
                    item.put("name", rs.getString("name"));
                    return item;
                });
        return ApiResponse.ok(Map.of("items", items));
    }
}