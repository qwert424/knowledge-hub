package com.knowledgehub.common.spi;

import java.util.UUID;

/** Implemented by platform-index; used by platform-kb to enqueue indexing without a compile cycle. */
public interface IndexJobPort {

    UUID enqueue(IndexJobCommand command);

    void cancel(UUID jobId);
}