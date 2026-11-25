/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { unflattenObject } from '@kbn/object-utils';
import { BulkDropAggregator } from './bulk_drop_aggregator';
import type { BulkDropTypeSummary } from './bulk_drop_aggregator';

const RETRY_ON_CONFLICT = 3;
/** About 2,500 small partial updates per bulk request. */
const FLUSH_BYTES = 512 * 1024;

export interface EntityDocUpdate {
  readonly docId: string;
  readonly doc: Record<string, unknown>;
}

export interface UpdateEntityDocsResult {
  /** Documents the updates changed. */
  readonly updated: number;
  /** Documents that already held the values, which Elasticsearch left as they were. */
  readonly unchanged: number;
  /** Documents that failed, after rejections for load were retried. */
  readonly failed: number;
  /** The failures grouped by error type. Empty when nothing failed. */
  readonly dropsByType: BulkDropTypeSummary[];
}

/**
 * Applies partial updates to entity documents as they come, through `esClient.helpers.bulk`:
 * requests of about 512 KB, at most `requestsInFlight` at once, and 429s retried with backoff. An
 * update that changes nothing is a no-op in Elasticsearch, so sending the same values again costs a
 * read of the document rather than a reindex.
 */
export const updateEntityDocs = async (
  esClient: ElasticsearchClient,
  {
    index,
    updates,
    requestsInFlight,
    signal,
  }: {
    index: string;
    updates: AsyncIterable<EntityDocUpdate>;
    requestsInFlight: number;
    signal?: AbortSignal;
  }
): Promise<UpdateEntityDocsResult> => {
  const drops = new BulkDropAggregator();
  let unchanged = 0;
  const helper = esClient.helpers.bulk<EntityDocUpdate>(
    {
      datasource: (async function* () {
        yield* updates;
      })(),
      concurrency: requestsInFlight,
      flushBytes: FLUSH_BYTES,
      refresh: false,
      onDocument: ({ docId, doc }) => [
        { update: { _index: index, _id: docId, retry_on_conflict: RETRY_ON_CONFLICT } },
        { doc: unflattenObject(doc) },
      ],
      onSuccess: ({ result }) => {
        if (result.update?.result === 'noop') unchanged++;
      },
      onDrop: (dropped) => drops.record(dropped),
    },
    { signal }
  );
  const abort = () => helper.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const { successful, failed } = await helper;
    signal?.throwIfAborted();
    return { updated: successful - unchanged, unchanged, failed, dropsByType: drops.summary() };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};
