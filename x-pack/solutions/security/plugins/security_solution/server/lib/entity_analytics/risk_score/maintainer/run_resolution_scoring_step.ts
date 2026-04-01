/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskScoreDataClient } from '../risk_score_data_client';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import { scoreResolutionEntities } from './score_resolution_entities';
import type { ScopedLogger } from './utils/with_log_context';

interface RunResolutionScoringParams {
  esClient: ElasticsearchClient;
  crudClient: EntityUpdateClient;
  logger: ScopedLogger;
  entityType: EntityType;
  alertsIndex: string;
  lookupIndex: string;
  pageSize: number;
  sampleSize: number;
  now: string;
  calculationRunId: string;
  watchlistConfigs: Map<string, WatchlistObject>;
  idBasedRiskScoringEnabled: boolean;
  writer: Awaited<ReturnType<RiskScoreDataClient['getWriter']>>;
}

export const runResolutionScoringStep = async ({
  esClient,
  crudClient,
  logger: runLogger,
  entityType,
  alertsIndex,
  lookupIndex,
  pageSize,
  sampleSize,
  now,
  calculationRunId,
  watchlistConfigs,
  idBasedRiskScoringEnabled,
  writer,
}: RunResolutionScoringParams): Promise<{
  scoresWritten: number;
  pagesProcessed: number;
  skippedReason?: 'lookup_empty';
}> => {
  runLogger.debug(
    `starting phase 2 resolution scoring: page_size=${pageSize}, sample_size=${sampleSize}`
  );
  const resolutionSummary = await scoreResolutionEntities({
    esClient,
    crudClient,
    logger: runLogger,
    entityType,
    alertsIndex,
    lookupIndex,
    pageSize,
    sampleSize,
    now,
    calculationRunId,
    watchlistConfigs,
  });

  if (resolutionSummary.scores.length === 0) {
    const skipReason =
      resolutionSummary.pagesProcessed === 0 ? 'lookup_empty' : 'no_matching_alerts';
    runLogger.debug(
      `phase 2 resolution scoring produced no writes: reason=${skipReason}, pages=${resolutionSummary.pagesProcessed}`
    );
    return {
      scoresWritten: 0,
      pagesProcessed: resolutionSummary.pagesProcessed,
      skippedReason: resolutionSummary.pagesProcessed === 0 ? 'lookup_empty' : undefined,
    };
  }

  const bulkResponse = await writer.bulk({ [entityType]: resolutionSummary.scores });
  const scoresWrittenResolution = bulkResponse.docs_written;
  runLogger.debug(
    `phase 2 resolution write succeeded: attempted=${resolutionSummary.scores.length}, written=${scoresWrittenResolution}, pages=${resolutionSummary.pagesProcessed}, took=${bulkResponse.took}ms`
  );
  if (bulkResponse.errors.length > 0) {
    runLogger.warn(
      `phase 2 resolution write had ${
        bulkResponse.errors.length
      } error(s): ${bulkResponse.errors.join('; ')}`
    );
  }

  if (idBasedRiskScoringEnabled) {
    const entityStoreErrors = await persistRiskScoresToEntityStore({
      crudClient,
      logger: runLogger,
      scores: { [entityType]: resolutionSummary.scores },
    });
    if (entityStoreErrors.length > 0) {
      runLogger.warn(
        `Entity store resolution write had ${
          entityStoreErrors.length
        } error(s): ${entityStoreErrors.join('; ')}`
      );
    }
  }

  return {
    scoresWritten: scoresWrittenResolution,
    pagesProcessed: resolutionSummary.pagesProcessed,
  };
};
