package com.knowledgehub.common.security;

import com.knowledgehub.common.error.BizException;
import com.knowledgehub.common.error.ErrorCode;

public final class UserContext {

    private static final ThreadLocal<CurrentUser> USER = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(CurrentUser user) {
        USER.set(user);
    }

    public static CurrentUser get() {
        return USER.get();
    }

    public static CurrentUser require() {
        CurrentUser user = USER.get();
        if (user == null) {
            throw new BizException(ErrorCode.AUTH_401);
        }
        return user;
    }

    public static void clear() {
        USER.remove();
    }
}