/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { BulkDropTypeSummary, EntityUpdateClient } from '@kbn/entity-store/server';
import { hashEuid } from '@kbn/entity-store/server';
import type { MultiSeedWalkResult, NodeReach } from '@kbn/graph-algorithms';

// The daily job's output, as the output contract has it: a summary on each entity reached
// (entity.blast_radius) and one detail document per entity beside it, keyed by the same EUID,
// with its hops, next entity and contribution for each crown jewel it reaches. Details are written
// first, then summaries, each through the bulk helper with at most requestsInFlight requests open
// and 429s retried. A summary that hasn't changed since the last run is a no-op in Elasticsearch.
// A run keeps the last good result: what an older run wrote for entities this run no longer
// reaches is removed. Readers can see two runs mixed while the results are written.

/** Each crown jewel an entity reaches adds this to its score. */
const CONTRIBUTION = 1;
const CLEAR_PAGE_SIZE = 1_000;
/** About 1,000 detail documents per bulk request. */
const FLUSH_BYTES = 512 * 1024;

export const getBlastRadiusIndexName = (namespace: string): string =>
  `blast-radius.blast-radius-latest-${namespace}`;

export interface BlastRadiusDetail {
  readonly '@timestamp': string;
  readonly entity: { readonly id: string };
  readonly calculation_run_id: string;
  readonly crown_jewels: ReadonlyArray<{
    readonly entity_id: string;
    readonly hops: number;
    readonly next_entity_id: string;
    readonly contribution: number;
  }>;
}

export interface WriteBlastRadiusResult {
  /** Entities given a detail document. */
  readonly entitiesWritten: number;
  /** Summaries this run changed. */
  readonly summariesChanged: number;
  /** Summaries that already held this run's values, which Elasticsearch left as they were. */
  readonly summariesUnchanged: number;
  /** Summaries that failed, such as an entity missing from the latest index. */
  readonly summaryErrors: number;
  /** The summary failures grouped by error type, to log. */
  readonly summaryErrorsByType: readonly BulkDropTypeSummary[];
  /** Entities an older run reached and this one didn't, whose results were removed. */
  readonly entitiesCleared: number;
}

interface WriteContext {
  readonly crudClient: EntityUpdateClient;
  readonly esClient: ElasticsearchClient;
  readonly namespace: string;
  readonly requestsInFlight: number;
  readonly signal: AbortSignal;
}

type CompletedWalk = Extract<MultiSeedWalkResult, { outcome: 'completed' }>;

const ensureIndex = async (
  esClient: ElasticsearchClient,
  index: string,
  signal: AbortSignal
): Promise<void> => {
  if (await esClient.indices.exists({ index }, { signal })) return;
  await esClient.indices.create(
    {
      index,
      mappings: {
        dynamic: 'strict',
        properties: {
          '@timestamp': { type: 'date' },
          entity: { properties: { id: { type: 'keyword' } } },
          calculation_run_id: { type: 'keyword' },
          crown_jewels: {
            properties: {
              entity_id: { type: 'keyword' },
              hops: { type: 'short' },
              next_entity_id: { type: 'keyword' },
              contribution: { type: 'float' },
            },
          },
        },
      },
    },
    { signal, ignore: [400] }
  );
};

/** The percentile of each score, by the share of entities scoring the same or lower. */
const percentilesByScore = (counts: readonly number[]): number[] => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  let atOrBelow = 0;
  return counts.map((count) => {
    atOrBelow += count;
    return total === 0 ? 0 : Math.round((1000 * atOrBelow) / total) / 10;
  });
};

const scoreOf = (node: NodeReach): number => node.seeds.length * CONTRIBUTION;

/** Writes one detail document per entity reached, and fails the run if any is refused. */
const writeDetails = async (
  { esClient, requestsInFlight, signal }: WriteContext,
  index: string,
  result: CompletedWalk,
  { runId, timestamp }: { runId: string; timestamp: string }
): Promise<number> => {
  let firstFailure: string | undefined;
  const helper = esClient.helpers.bulk<BlastRadiusDetail>(
    {
      datasource: (async function* () {
        for (const page of result.nodes()) {
          for (const node of page) {
            yield {
              '@timestamp': timestamp,
              entity: { id: node.nodeId },
              calculation_run_id: runId,
              crown_jewels: node.seeds.map(({ seedId, hops, nextNodeId }) => ({
                entity_id: seedId,
                hops,
                next_entity_id: nextNodeId,
                contribution: CONTRIBUTION,
              })),
            };
          }
        }
      })(),
      concurrency: requestsInFlight,
      flushBytes: FLUSH_BYTES,
      refresh: false,
      onDocument: (detail) => ({ index: { _index: index, _id: hashEuid(detail.entity.id) } }),
      onDrop: ({ error }) => {
        firstFailure ??= error?.reason ?? 'unknown error';
      },
    },
    { signal }
  );
  const abort = () => helper.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const { successful, failed } = await helper;
    signal.throwIfAborted();
    if (failed > 0) {
      throw new Error(
        `Writing blast radius details failed for ${failed} entities: ${firstFailure}`
      );
    }
    return successful;
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

export const writeBlastRadius = async (
  context: WriteContext,
  result: CompletedWalk,
  run: { runId: string; timestamp: string }
): Promise<WriteBlastRadiusResult> => {
  const { crudClient, esClient, namespace, requestsInFlight, signal } = context;
  const index = getBlastRadiusIndexName(namespace);
  await ensureIndex(esClient, index, signal);

  // Scores are whole numbers up to the number of crown jewels, so a count per score gives each
  // score's percentile.
  const counts = new Array<number>(result.seeds.length * CONTRIBUTION + 1).fill(0);
  for (const page of result.nodes()) for (const node of page) counts[scoreOf(node)]++;
  const percentiles = percentilesByScore(counts);

  const entitiesWritten = await writeDetails(context, index, result, run);
  const summaries = await crudClient.bulkUpdateEntitiesById(
    (function* () {
      for (const page of result.nodes()) {
        for (const node of page) {
          const score = scoreOf(node);
          yield {
            entityId: node.nodeId,
            doc: { entity: { blast_radius: { score, percentile: percentiles[score] } } },
          };
        }
      }
    })(),
    { requestsInFlight, signal }
  );

  const entitiesCleared = await clearOlderRuns({
    crudClient,
    esClient,
    index,
    runId: run.runId,
    signal,
  });
  return {
    entitiesWritten,
    summariesChanged: summaries.updated,
    summariesUnchanged: summaries.unchanged,
    summaryErrors: summaries.failed,
    summaryErrorsByType: summaries.dropsByType,
    entitiesCleared,
  };
};

/** Clears the summary on, and deletes the details of, entities only an older run reached. */
const clearOlderRuns = async ({
  crudClient,
  esClient,
  index,
  runId,
  signal,
}: {
  crudClient: EntityUpdateClient;
  esClient: ElasticsearchClient;
  index: string;
  runId: string;
  signal: AbortSignal;
}): Promise<number> => {
  await esClient.indices.refresh({ index }, { signal });
  let cleared = 0;
  for (;;) {
    const { hits } = await esClient.search<BlastRadiusDetail>(
      {
        index,
        size: CLEAR_PAGE_SIZE,
        track_total_hits: false,
        _source: ['entity.id'],
        query: { bool: { must_not: [{ term: { calculation_run_id: runId } }] } },
      },
      { signal }
    );
    if (hits.hits.length === 0) return cleared;
    const entityIds = hits.hits.flatMap(({ _source }) => (_source ? [_source.entity.id] : []));
    await crudClient.bulkUpdateEntitiesById(
      entityIds.map((entityId) => ({ entityId, doc: { entity: { blast_radius: null } } })),
      { requestsInFlight: 1, signal }
    );
    await esClient.bulk(
      {
        operations: hits.hits.map(({ _id }) => ({ delete: { _index: index, _id } })),
        refresh: true,
      },
      { signal }
    );
    cleared += hits.hits.length;
  }
};
