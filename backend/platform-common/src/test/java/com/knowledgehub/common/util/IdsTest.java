package com.knowledgehub.common.util;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class IdsTest {

    @Test
    void generatesTimeOrderedV7Uuids() {
        UUID first = Ids.uuid7();
        UUID second = Ids.uuid7();

        assertThat(first.version()).isEqualTo(7);
        assertThat(first.variant()).isEqualTo(2);
        assertThat(second.toString().compareTo(first.toString())).isGreaterThanOrEqualTo(0);
        assertThat(first).isNotEqualTo(second);
    }
}