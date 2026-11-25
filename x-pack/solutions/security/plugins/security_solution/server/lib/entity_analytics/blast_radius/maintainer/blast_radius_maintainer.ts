/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import type { RegisterEntityMaintainerConfig, RelationshipsReader } from '@kbn/entity-store/server';
import { formatBulkDropSummary } from '@kbn/entity-store/server';
import { multiSeedWalk, type EdgeReader } from '@kbn/graph-algorithms';
import type { ConfigType } from '../../../../config';
import { listCrownJewels } from '../crown_jewels';
import { startRunRecord, type RunRecord } from '../run_record';
import { WALKED_KINDS } from '../walked_kinds';
import { writeBlastRadius } from '../write_blast_radius';

export type BlastRadiusConfig = ConfigType['entityAnalytics']['blastRadius'];
type MaintainerRun = RegisterEntityMaintainerConfig['run'];
type MaintainerState = Awaited<ReturnType<MaintainerRun>>;

const toEdgeReader = (relationships: RelationshipsReader, record?: RunRecord): EdgeReader => ({
  async *edgesInto(nodeIds) {
    for await (const page of relationships.relationshipsInto(nodeIds)) {
      record?.page(page);
      yield page.map(({ entityId, kind, targetEntityId }) => ({
        fromId: entityId,
        kind,
        toId: targetEntityId,
      }));
    }
  },
});

/**
 * The daily job: lists the crown jewels, walks back from all of them at once over the space's
 * relationships, and writes each entity's blast radius. A run that reads more than
 * maxRelationshipsRead writes nothing.
 */
export const createBlastRadiusMaintainer =
  (config: BlastRadiusConfig): MaintainerRun =>
  async ({ status, signal, logger, esClient, crudClient, relationshipsClient }) => {
    const { namespace } = status.metadata;
    const { requestsInFlight, maxRelationshipsRead, runRecord } = config;
    const runId = uuidv4();
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    const record = runRecord
      ? startRunRecord({
          runId,
          namespace,
          settings: { requestsInFlight, maxRelationshipsRead },
        })
      : undefined;
    logger.info(`Blast radius run ${runId} started`);

    const finish = async (
      lastRun: MaintainerState,
      seeds?: Parameters<RunRecord['finish']>[1]
    ): Promise<MaintainerState> => {
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
      logger.info(
        `Blast radius run ${runId} ended: ${JSON.stringify({ ...lastRun, durationSeconds })}`
      );
      if (record) logger.info(`Blast radius run record: ${await record.finish(lastRun, seeds)}`);
      return { lastRun: { runId, timestamp, durationSeconds, ...lastRun } };
    };

    try {
      const crownJewelIds = await listCrownJewels(crudClient);
      record?.endPhase('crownJewels');
      if (crownJewelIds.length === 0) return await finish({ outcome: 'no_crown_jewels' });

      const result = await relationshipsClient.withReader(
        { kinds: WALKED_KINDS, requestsInFlight, signal, onSearch: record?.search },
        (relationships) =>
          multiSeedWalk(toEdgeReader(relationships, record), crownJewelIds, {
            maxEdgesRead: maxRelationshipsRead,
            signal,
            onSeedComputed: record?.seedComputed,
            onHop: (hop) => {
              logger.debug(
                `Hop ${hop.hop}: ${hop.frontierSize} entities, ${hop.edgesRead} relationships read`
              );
              record?.hop(hop);
            },
          })
      );
      record?.endWalk();
      record?.endPhase('compute');
      const totals = {
        crownJewels: crownJewelIds.length,
        relationshipsRead: result.edgesRead,
        hops: result.hops,
      };
      if (result.outcome === 'cap') return await finish({ outcome: 'cap', ...totals });

      const written = await writeBlastRadius(
        { crudClient, esClient, namespace, requestsInFlight, signal },
        result,
        { runId, timestamp },
        record?.endWriteStep
      );
      record?.endPhase('writeBack');
      if (written.summaryErrors > 0) {
        logger.warn(
          `Blast radius summaries failed for ${
            written.summaryErrors
          } entities: ${formatBulkDropSummary([...written.summaryErrorsByType])}`
        );
      }
      return await finish(
        {
          outcome: 'completed',
          ...totals,
          entitiesReached: result.nodesReached,
          entitiesWritten: written.entitiesWritten,
          summariesChanged: written.summariesChanged,
          summariesUnchanged: written.summariesUnchanged,
          summaryErrors: written.summaryErrors,
          entitiesCleared: written.entitiesCleared,
        },
        result.seeds
      );
    } catch (error) {
      logger.error(`Blast radius run ${runId} failed: ${error.message}`);
      if (record) await record.finish({ outcome: 'failed', error: error.message });
      throw error;
    }
  };
