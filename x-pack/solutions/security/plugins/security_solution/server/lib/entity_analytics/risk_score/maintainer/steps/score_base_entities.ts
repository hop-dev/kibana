/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskEngineDataWriter } from '../../risk_engine_data_writer';
import { getEuidCompositeQuery, getBaseScoreESQL } from '../../calculate_esql_risk_scores';
import { parseEsqlBaseScoreRow } from './parse_esql_row';
import { applyScoreModifiersFromEntities } from '../../modifiers/apply_modifiers_from_entities';
import type { ScoredEntityPage } from './pipeline_types';
import { categorizePhase1Entities } from './categorize_phase1_entities';
import { persistRiskScoresToEntityStore } from '../../persist_risk_scores_to_entity_store';
import { fetchEntitiesByIds } from '../utils/fetch_entities_by_ids';
import type { ScopedLogger } from '../utils/with_log_context';
import { syncLookupIndexForCategorizedPage } from '../lookup/sync_lookup_index';

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
  lookupIndex: string;
}

export interface Phase1BaseScoringSummary {
  pagesProcessed: number;
  writeNowCount: number;
  deferToPhase2Count: number;
  notInStoreCount: number;
  scoresWritten: number;
  lookupDocsUpserted: number;
  lookupDocsDeleted: number;
}

/**
 * Computes base risk scores for one entity type and streams paginated results.
 *
 * Each page is scored from alert inputs, enriched with entity-derived modifiers,
 * and returned without persistence.
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
    // Composite paging gives deterministic bounds for the ES|QL score query.
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
    const query = getBaseScoreESQL(
      entityType,
      { lower: previousPageUpperBound, upper },
      sampleSize,
      pageSize,
      alertsIndex
    );
    const esqlResponse = await esClient.esql.query({ query });
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
  lookupIndex,
  ...params
}: ScoreAndPersistBaseEntitiesParams): Promise<Phase1BaseScoringSummary> => {
  // Persist using categorized write groups to keep routing explicit.
  let writeNowCount = 0;
  let deferToPhase2Count = 0;
  let notInStoreCount = 0;
  let pagesProcessed = 0;
  let scoresWritten = 0;
  let lookupDocsUpserted = 0;
  let lookupDocsDeleted = 0;

  for await (const page of calculateBaseEntityScores(params)) {
    pagesProcessed += 1;
    const categorized = categorizePhase1Entities(page);
    const lookupSyncResult = await syncLookupIndexForCategorizedPage({
      esClient: params.esClient,
      index: lookupIndex,
      page,
      categorized,
      now: params.now,
    });

    writeNowCount += categorized.write_now.length;
    deferToPhase2Count += categorized.defer_to_phase_2.length;
    notInStoreCount += categorized.not_in_store.length;
    lookupDocsUpserted += lookupSyncResult.upserted;
    lookupDocsDeleted += lookupSyncResult.deleted;

    params.logger.debug(
      `[page:${pagesProcessed}] categorization: write_now=${categorized.write_now.length}, defer_to_phase_2=${categorized.defer_to_phase_2.length}, not_in_store=${categorized.not_in_store.length}`
    );
    params.logger.debug(
      `[page:${pagesProcessed}] lookup sync: upserts=${lookupSyncResult.upserted}, deletes=${lookupSyncResult.deleted}`
    );

    // Keep dual-write semantics from phase 1 categorization:
    // `defer_to_phase_2` remains persisted to the risk index for continuity.
    const riskIndexWrites = [...categorized.write_now, ...categorized.defer_to_phase_2];
    const bulkResponse = await writer.bulk({ [params.entityType]: riskIndexWrites });
    scoresWritten += bulkResponse.docs_written;
    if (bulkResponse.errors.length > 0) {
      params.logger.warn(
        `[page:${pagesProcessed}] risk score bulk write had ${
          bulkResponse.errors.length
        } error(s): ${bulkResponse.errors.join('; ')}`
      );
    } else {
      params.logger.debug(
        `[page:${pagesProcessed}] risk score bulk write succeeded: attempted=${riskIndexWrites.length}, written=${bulkResponse.docs_written}, took=${bulkResponse.took}ms`
      );
    }

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
    }

    if (categorized.not_in_store.length > 0) {
      params.logger.debug(
        `[page:${pagesProcessed}] skipped writes for ${categorized.not_in_store.length} not_in_store entities`
      );
    }
  }

  params.logger.debug(
    `categorization totals: pages=${pagesProcessed}, write_now=${writeNowCount}, defer_to_phase_2=${deferToPhase2Count}, not_in_store=${notInStoreCount}`
  );
  params.logger.debug(
    `lookup sync totals: upserts=${lookupDocsUpserted}, deletes=${lookupDocsDeleted}`
  );

  return {
    pagesProcessed,
    writeNowCount,
    deferToPhase2Count,
    notInStoreCount,
    scoresWritten,
    lookupDocsUpserted,
    lookupDocsDeleted,
  };
};
