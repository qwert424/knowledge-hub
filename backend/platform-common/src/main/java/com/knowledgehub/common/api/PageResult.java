package com.knowledgehub.common.api;

import java.util.List;

public record PageResult<T>(List<T> items, long total, long page, long pageSize) {

    public static <T> PageResult<T> of(List<T> items, long total, long page, long pageSize) {
        return new PageResult<>(items, total, page, pageSize);
    }
}