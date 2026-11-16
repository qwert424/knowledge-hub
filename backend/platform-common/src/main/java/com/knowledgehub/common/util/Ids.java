package com.knowledgehub.common.util;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.UUID;

/** UUID v7 (time-ordered) per RFC 9562. */
public final class Ids {

    private static final SecureRandom RANDOM = new SecureRandom();

    private Ids() {
    }

    public static UUID uuid7() {
        long timestamp = Instant.now().toEpochMilli();
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);

        long msb = (timestamp & 0xFFFFFFFFFFFFL) << 16;
        msb |= 0x7000L;
        msb |= ((long) (random[0] & 0x0F) << 8);
        msb |= (random[1] & 0xFFL);

        long lsb = 0x8000000000000000L;
        lsb |= ((long) (random[2] & 0x3F)) << 56;
        for (int i = 3; i < 10; i++) {
            lsb |= ((long) (random[i] & 0xFF)) << (8 * (9 - i));
        }
        return new UUID(msb, lsb);
    }

    public static String uuid7String() {
        return uuid7().toString();
    }
}