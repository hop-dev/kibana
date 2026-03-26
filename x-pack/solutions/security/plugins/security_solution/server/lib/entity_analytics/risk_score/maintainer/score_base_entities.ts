/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskEngineDataWriter } from '../risk_engine_data_writer';
import { getEuidCompositeQuery, getBaseScoreESQL } from '../calculate_esql_risk_scores';
import { parseEsqlBaseScoreRow } from './parse_esql_row';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import type { ScoredEntityPage } from './pipeline_types';
import { categorizePhase1Entities } from './categorize_phase1_entities';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import { fetchEntitiesByIds } from './utils/fetch_entities_by_ids';
import type { ScopedLogger } from './utils/with_log_context';

interface ScoreBaseEntitiesParams {
  esClient: ElasticsearchClient;
  crudClient: EntityUpdateClient;
  logger: ScopedLogger;
  entityType: EntityType;
  alertFilters: QueryDslQueryContainer[];
  alertsIndex: string;
  pageSize: number;
  sampleSize: number;
  now: string;
  watchlistConfigs: Map<string, WatchlistObject>;
  calculationRunId: string;
}

interface ScoreAndPersistBaseEntitiesParams extends ScoreBaseEntitiesParams {
  writer: RiskEngineDataWriter;
  idBasedRiskScoringEnabled: boolean;
}

export interface Phase1BaseScoringSummary {
  pagesProcessed: number;
  writeNowCount: number;
  deferToPhase2Count: number;
  notInStoreCount: number;
  scoresWritten: number;
}

/**
 * Phase 1: Base Scoring for a single entity type.
 * "Base" means risk derived directly from this entity's own alert inputs in the
 * current run window, before any cross-entity propagation/resolution phases.
 *
 * Streams scored pages for one entity type:
 * - page entity ids via composite aggregation on EUID
 * - compute base scores with ES|QL for each page bound
 * - fetch matching Entity Store documents once and reuse for:
 *   - modifier application
 *   - downstream category decisions in the persistence path
 *
 * Returns scored pages without any persistence.
 */
export const calculateBaseEntityScores = async function* ({
  esClient,
  crudClient,
  logger,
  entityType,
  alertFilters,
  alertsIndex,
  pageSize,
  sampleSize,
  now,
  watchlistConfigs,
  calculationRunId,
}: ScoreBaseEntitiesParams): AsyncGenerator<ScoredEntityPage> {
  let afterKey: Record<string, string> | undefined;
  let previousPageUpperBound: string | undefined;

  do {
    // Composite paging gives deterministic page bounds for the ES|QL score query.
    const compositeResponse = await esClient.search(
      getEuidCompositeQuery(entityType, alertFilters, {
        index: alertsIndex,
        pageSize,
        afterKey,
      })
    );

    interface CompositeAgg {
      buckets: Array<{ key: Record<string, string> }>;
      after_key?: Record<string, string>;
    }
    const compositeAgg = (
      compositeResponse.aggregations as { by_entity_id?: CompositeAgg } | undefined
    )?.by_entity_id;
    const buckets = compositeAgg?.buckets ?? [];

    if (buckets.length === 0) break;

    const upper = buckets[buckets.length - 1].key.entity_id;
    afterKey = compositeAgg?.after_key;

    const esqlResponse = await esClient.esql.query({
      query: getBaseScoreESQL(
        entityType,
        { lower: previousPageUpperBound, upper },
        sampleSize,
        pageSize,
        alertsIndex
      ),
    });
    previousPageUpperBound = upper;

    const scores = (esqlResponse.values ?? []).map(parseEsqlBaseScoreRow(alertsIndex));

    if (scores.length > 0) {
      const euidValues = scores.map((score) => score.entity_id);
      const entityMap = await fetchEntitiesByIds({
        crudClient,
        entityIds: euidValues,
        logger,
        errorContext:
          'Error fetching entities for modifier application. Scoring will proceed without modifiers',
      });

      const finalScores = applyScoreModifiersFromEntities({
        now,
        identifierType: entityType,
        scoreType: 'base',
        calculationRunId,
        weights: [],
        page: {
          scores,
          identifierField: 'entity_id',
        },
        entities: entityMap,
        watchlistConfigs,
      });

      yield { entityIds: euidValues, scores: finalScores, entities: entityMap };
    }
  } while (afterKey !== undefined);
};

export const scoreBaseEntities = async ({
  writer,
  idBasedRiskScoringEnabled,
  ...params
}: ScoreAndPersistBaseEntitiesParams): Promise<Phase1BaseScoringSummary> => {
  // Persists each base-score page in explicit phase-1 categories so phase-2
  // defer/lookup routing can be introduced without reshaping this loop.
  let writeNowCount = 0;
  let deferToPhase2Count = 0;
  let notInStoreCount = 0;
  let pagesProcessed = 0;
  let scoresWritten = 0;

  for await (const page of calculateBaseEntityScores(params)) {
    pagesProcessed += 1;
    const categorized = categorizePhase1Entities(page);

    writeNowCount += categorized.write_now.length;
    deferToPhase2Count += categorized.defer_to_phase_2.length;
    notInStoreCount += categorized.not_in_store.length;

    params.logger.debug(
      `[page:${pagesProcessed}] categorization: write_now=${categorized.write_now.length}, defer_to_phase_2=${categorized.defer_to_phase_2.length}, not_in_store=${categorized.not_in_store.length}`
    );

    // Temporary Phase 1 behavior: defer_to_phase_2 scores are still written now.
    // When Phase 2 aggregation is implemented, this write set will become
    // write_now only and defer_to_phase_2 will be handled in that phase.
    const riskIndexWrites = [...categorized.write_now, ...categorized.defer_to_phase_2];
    await writer.bulk({ [params.entityType]: riskIndexWrites });
    scoresWritten += riskIndexWrites.length;

    if (idBasedRiskScoringEnabled) {
      const entityStoreErrors = await persistRiskScoresToEntityStore({
        crudClient: params.crudClient,
        logger: params.logger,
        scores: { [params.entityType]: riskIndexWrites },
      });
      if (entityStoreErrors.length > 0) {
        params.logger.warn(
          `Entity store dual-write had ${
            entityStoreErrors.length
          } error(s): ${entityStoreErrors.join('; ')}`
        );
      }

      if (categorized.not_in_store.length > 0) {
        params.logger.debug(
          `[page:${pagesProcessed}] skipped writes for ${categorized.not_in_store.length} not_in_store entities`
        );
      }
    }
  }

  params.logger.debug(
    `categorization totals: pages=${pagesProcessed}, write_now=${writeNowCount}, defer_to_phase_2=${deferToPhase2Count}, not_in_store=${notInStoreCount}`
  );

  return {
    pagesProcessed,
    writeNowCount,
    deferToPhase2Count,
    notInStoreCount,
    scoresWritten,
  };
};
