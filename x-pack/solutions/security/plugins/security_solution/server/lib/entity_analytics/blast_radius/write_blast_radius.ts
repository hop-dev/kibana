/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { BulkObjectResponse, EntityUpdateClient } from '@kbn/entity-store/server';
import { hashEuid } from '@kbn/entity-store/server';
import type { MultiSeedWalkResult, NodeReach } from '@kbn/graph-algorithms';

// The daily job's output, as the output contract has it: a summary on each entity reached
// (entity.blast_radius) and one detail document per entity beside it, keyed by the same EUID,
// with its hops, next entity and contribution for each crown jewel it reaches. A run keeps the
// last good result: what an older run wrote for entities this run no longer reaches is removed.
// Readers can see two runs mixed while the pages are written.

/** Each crown jewel an entity reaches adds this to its score. */
const CONTRIBUTION = 1;
const CLEAR_PAGE_SIZE = 1_000;

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
  /** Entities given a summary and a detail document. */
  readonly entitiesWritten: number;
  /** Summaries that failed, such as an entity missing from the latest index. */
  readonly summaryErrors: number;
  /** Entities an older run reached and this one didn't, whose results were removed. */
  readonly entitiesCleared: number;
  /** The first few failures, to log. */
  readonly sampleErrors: readonly BulkObjectResponse[];
}

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

export const writeBlastRadius = async (
  {
    crudClient,
    esClient,
    namespace,
    signal,
  }: {
    crudClient: EntityUpdateClient;
    esClient: ElasticsearchClient;
    namespace: string;
    signal: AbortSignal;
  },
  result: Extract<MultiSeedWalkResult, { outcome: 'completed' }>,
  { runId, timestamp }: { runId: string; timestamp: string }
): Promise<WriteBlastRadiusResult> => {
  const index = getBlastRadiusIndexName(namespace);
  await ensureIndex(esClient, index, signal);

  // Scores are whole numbers up to the number of crown jewels, so a count per score gives each
  // score's percentile.
  const counts = new Array<number>(result.seeds.length * CONTRIBUTION + 1).fill(0);
  for (const page of result.nodes()) for (const node of page) counts[scoreOf(node)]++;
  const percentiles = percentilesByScore(counts);

  let entitiesWritten = 0;
  let summaryErrors = 0;
  const sampleErrors: BulkObjectResponse[] = [];
  const keepErrors = (errors: readonly BulkObjectResponse[]) => {
    summaryErrors += errors.length;
    sampleErrors.push(...errors.slice(0, Math.max(0, 5 - sampleErrors.length)));
  };

  for (const page of result.nodes()) {
    signal.throwIfAborted();
    const details = page.flatMap((node) => [
      { index: { _index: index, _id: hashEuid(node.nodeId) } },
      {
        '@timestamp': timestamp,
        entity: { id: node.nodeId },
        calculation_run_id: runId,
        crown_jewels: node.seeds.map(({ seedId, hops, nextNodeId }) => ({
          entity_id: seedId,
          hops,
          next_entity_id: nextNodeId,
          contribution: CONTRIBUTION,
        })),
      } satisfies BlastRadiusDetail,
    ]);
    const summaries = page.map((node) => {
      const score = scoreOf(node);
      return {
        entityId: node.nodeId,
        doc: { entity: { blast_radius: { score, percentile: percentiles[score], timestamp } } },
      };
    });
    const [detailResponse, errors] = await Promise.all([
      esClient.bulk({ operations: details }, { signal }),
      crudClient.bulkUpdateEntitiesById(summaries),
    ]);
    if (detailResponse.errors) {
      const failed = detailResponse.items.find((item) => item.index?.error);
      throw new Error(`Writing blast radius details failed: ${failed?.index?.error?.reason}`);
    }
    keepErrors(errors);
    entitiesWritten += page.length;
  }

  const entitiesCleared = await clearOlderRuns({ crudClient, esClient, index, runId, signal });
  return { entitiesWritten, summaryErrors, entitiesCleared, sampleErrors };
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
      entityIds.map((entityId) => ({ entityId, doc: { entity: { blast_radius: null } } }))
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
