package com.knowledgehub.common.api;

public record PageQuery(long page, long pageSize) {

    private static final long MAX_PAGE_SIZE = 200;

    public PageQuery {
        if (page < 1) {
            page = 1;
        }
        if (pageSize < 1) {
            pageSize = 20;
        }
        if (pageSize > MAX_PAGE_SIZE) {
            pageSize = MAX_PAGE_SIZE;
        }
    }

    public static PageQuery of(Long page, Long pageSize) {
        return new PageQuery(page == null ? 1 : page, pageSize == null ? 20 : pageSize);
    }

    public long offset() {
        return (page - 1) * pageSize;
    }
}