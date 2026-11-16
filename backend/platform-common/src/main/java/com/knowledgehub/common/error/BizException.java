package com.knowledgehub.common.error;

public class BizException extends RuntimeException {

    private final ErrorCode code;

    public BizException(ErrorCode code) {
        super(code.defaultMessage());
        this.code = code;
    }

    public BizException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    public static BizException of(ErrorCode code, String message) {
        return new BizException(code, message);
    }

    public ErrorCode code() {
        return code;
    }
}