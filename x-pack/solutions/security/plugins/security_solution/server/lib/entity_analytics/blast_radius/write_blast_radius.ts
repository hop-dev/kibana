/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { BulkDropTypeSummary, EntityUpdateClient } from '@kbn/entity-store/server';
import { hashEuid } from '@kbn/entity-store/server';
import { eventLoopBudget } from '@kbn/graph-algorithms';
import type { EventLoopBudget, MultiSeedWalkResult, NodeReach } from '@kbn/graph-algorithms';

// The daily job's output, as the output contract has it: a summary on each entity reached
// (entity.blast_radius) and one detail document per entity beside it, keyed by the same EUID,
// with its hops, next entity and contribution for each crown jewel it reaches. Choke points are
// marked on both: the summary's cut_off is the most a choke point cuts off from any one crown
// jewel, and its detail entry for that crown jewel has its cut_off as a choke node and the choke
// links from it, each as the walk kept them (its top choke points per crown jewel). Details are written
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

interface ChokeLinkDetail {
  readonly kind: string;
  readonly to_entity_id: string;
  /** Entities that lose every path to the crown jewel without this link. */
  readonly cut_off: number;
}

export interface BlastRadiusDetail {
  readonly '@timestamp': string;
  readonly entity: { readonly id: string };
  readonly calculation_run_id: string;
  readonly crown_jewels: ReadonlyArray<{
    readonly entity_id: string;
    readonly hops: number;
    readonly next_entity_id: string;
    readonly contribution: number;
    /** On a choke node only: entities that lose every path to the crown jewel without it. */
    readonly cut_off?: number;
    /** On the source of choke links only. */
    readonly choke_links?: readonly ChokeLinkDetail[];
  }>;
}

/** An entity's choke points for one crown jewel. */
interface ChokePointsFor {
  cutOff?: number;
  readonly links: ChokeLinkDetail[];
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

const DETAIL_MAPPINGS = {
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
        cut_off: { type: 'long' },
        choke_links: {
          properties: {
            kind: { type: 'keyword' },
            to_entity_id: { type: 'keyword' },
            cut_off: { type: 'long' },
          },
        },
      },
    },
  },
} as const;

/** Creates the detail index, or adds fields this version writes to one an older version made. */
const ensureIndex = async (
  esClient: ElasticsearchClient,
  index: string,
  signal: AbortSignal
): Promise<void> => {
  if (await esClient.indices.exists({ index }, { signal })) {
    await esClient.indices.putMapping({ index, ...DETAIL_MAPPINGS }, { signal });
    return;
  }
  await esClient.indices.create({ index, mappings: DETAIL_MAPPINGS }, { signal, ignore: [400] });
};

const scoreOf = (node: NodeReach): number => node.seeds.length * CONTRIBUTION;

/**
 * Each score's percentile, by the share of entities scoring the same or lower. Scores are whole
 * numbers up to the number of crown jewels, so it counts entities per score, then keeps a running
 * total: one pass over the entities, letting the event loop run as it goes.
 */
export const percentilesByScore = async (
  result: CompletedWalk,
  budget: EventLoopBudget
): Promise<number[]> => {
  const counts = new Array<number>(result.seeds.length * CONTRIBUTION + 1).fill(0);
  let total = 0;
  for (const page of result.nodes()) {
    for (const node of page) {
      if (budget.spent()) await budget.yield();
      counts[scoreOf(node)]++;
      total++;
    }
  }
  let atOrBelow = 0;
  return counts.map((count) => {
    atOrBelow += count;
    return total === 0 ? 0 : Math.round((1000 * atOrBelow) / total) / 10;
  });
};

/** The walk's choke nodes and links, by entity and then by crown jewel. */
const chokePointsByEntity = (
  seeds: CompletedWalk['seeds']
): Map<string, Map<string, ChokePointsFor>> => {
  const byEntity = new Map<string, Map<string, ChokePointsFor>>();
  const entryOf = (entityId: string, seedId: string): ChokePointsFor => {
    const bySeed = byEntity.get(entityId) ?? new Map<string, ChokePointsFor>();
    byEntity.set(entityId, bySeed);
    const entry = bySeed.get(seedId) ?? { links: [] };
    bySeed.set(seedId, entry);
    return entry;
  };
  for (const { seedId, chokePoints } of seeds) {
    for (const { nodeId, cutOff } of chokePoints.nodes) entryOf(nodeId, seedId).cutOff = cutOff;
    for (const { fromId, kind, toId, cutOff } of chokePoints.links) {
      entryOf(fromId, seedId).links.push({ kind, to_entity_id: toId, cut_off: cutOff });
    }
  }
  return byEntity;
};

/** The most an entity cuts off from any one crown jewel, or null when it isn't a choke point. */
const cutOffOf = (bySeed: Map<string, ChokePointsFor> | undefined): number | null => {
  if (!bySeed) return null;
  let most = 0;
  for (const { cutOff = 0, links } of bySeed.values()) {
    most = Math.max(most, cutOff, ...links.map((link) => link.cut_off));
  }
  return most;
};

/** Writes one detail document per entity reached, and fails the run if any is refused. */
const writeDetails = async (
  { esClient, requestsInFlight, signal }: WriteContext,
  index: string,
  result: CompletedWalk,
  chokePoints: Map<string, Map<string, ChokePointsFor>>,
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
              crown_jewels: node.seeds.map(({ seedId, hops, nextNodeId }) => {
                const choke = chokePoints.get(node.nodeId)?.get(seedId);
                return {
                  entity_id: seedId,
                  hops,
                  next_entity_id: nextNodeId,
                  contribution: CONTRIBUTION,
                  ...(choke?.cutOff !== undefined && { cut_off: choke.cutOff }),
                  ...(choke && choke.links.length > 0 && { choke_links: choke.links }),
                };
              }),
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

/** The steps of a write, in order, for a caller that times them. writeDetails includes the setup. */
export type WriteStep = 'writeDetails' | 'writeSummaries' | 'clearOlderRuns';

export const writeBlastRadius = async (
  context: WriteContext,
  result: CompletedWalk,
  run: { runId: string; timestamp: string },
  onStepEnd?: (step: WriteStep) => void
): Promise<WriteBlastRadiusResult> => {
  const { crudClient, esClient, namespace, requestsInFlight, signal } = context;
  const index = getBlastRadiusIndexName(namespace);
  await ensureIndex(esClient, index, signal);

  const percentiles = await percentilesByScore(result, eventLoopBudget(signal));

  const chokePoints = chokePointsByEntity(result.seeds);
  const entitiesWritten = await writeDetails(context, index, result, chokePoints, run);
  onStepEnd?.('writeDetails');
  const summaries = await crudClient.bulkUpdateEntitiesById(
    (function* () {
      for (const page of result.nodes()) {
        for (const node of page) {
          const score = scoreOf(node);
          // Null rather than absent, so a partial update clears an earlier run's cut_off.
          const cutOff = cutOffOf(chokePoints.get(node.nodeId));
          yield {
            entityId: node.nodeId,
            doc: {
              entity: {
                blast_radius: { score, percentile: percentiles[score], cut_off: cutOff },
              },
            },
          };
        }
      }
    })(),
    { requestsInFlight, signal }
  );
  onStepEnd?.('writeSummaries');

  const entitiesCleared = await clearOlderRuns({
    crudClient,
    esClient,
    index,
    runId: run.runId,
    signal,
  });
  onStepEnd?.('clearOlderRuns');
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
