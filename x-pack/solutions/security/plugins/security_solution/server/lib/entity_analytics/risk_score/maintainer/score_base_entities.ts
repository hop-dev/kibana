/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { Entity } from '@kbn/entity-store/common';
import type { EntityType } from '../../../../../common/search_strategy';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskEngineDataWriter } from '../risk_engine_data_writer';
import { getEuidCompositeQuery, getBaseScoreESQL } from '../calculate_esql_risk_scores';
import { parseEsqlBaseScoreRow } from './parse_esql_row';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import type { ScoredEntityPage } from './pipeline_types';
import { persistScoredPage } from './persist_scored_page';

interface ScoreBaseEntitiesParams {
  esClient: ElasticsearchClient;
  crudClient: EntityStoreCRUDClient;
  logger: Logger;
  entityType: EntityType;
  alertFilters: QueryDslQueryContainer[];
  alertsIndex: string;
  pageSize: number;
  sampleSize: number;
  now: string;
  watchlistConfigs: Map<string, WatchlistObject>;
}

interface ScoreAndPersistBaseEntitiesParams extends ScoreBaseEntitiesParams {
  writer: RiskEngineDataWriter;
  idBasedRiskScoringEnabled: boolean;
}

/**
 * Phase 1: Base Scoring for a single entity type.
 * "Base" means risk derived directly from this entity's own alert inputs in the
 * current run window, before any cross-entity propagation/resolution phases.
 *
 * Streams scored pages for one entity type:
 * - page entity ids via composite aggregation on EUID
 * - compute base scores with ES|QL for each page bound
 * - fetch matching Entity Store documents and apply modifiers
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
}: ScoreBaseEntitiesParams): AsyncGenerator<ScoredEntityPage> {
  let afterKey: Record<string, string> | undefined;

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

    const lower = buckets[0].key.entity_id;
    const upper = buckets[buckets.length - 1].key.entity_id;
    afterKey = compositeAgg?.after_key;

    const esqlResponse = await esClient.esql.query({
      query: getBaseScoreESQL(entityType, { lower, upper }, sampleSize, pageSize, alertsIndex),
    });

    const scores = (esqlResponse.values ?? []).map(parseEsqlBaseScoreRow(alertsIndex));

    if (scores.length > 0) {
      const euidValues = scores.map((score) => score.entity_id);
      let entityMap = new Map<string, Entity>();

      try {
        let searchAfter: Array<string | number> | undefined;
        do {
          const { entities: batch, nextSearchAfter } = await crudClient.listEntities({
            filter: { terms: { 'entity.id': euidValues } },
            size: euidValues.length,
            searchAfter,
          });
          for (const entity of batch) {
            if (entity.entity?.id) {
              entityMap.set(entity.entity.id, entity);
            }
          }
          searchAfter = nextSearchAfter;
        } while (searchAfter !== undefined);
      } catch (error) {
        logger.warn(
          `Error fetching entities for modifier application: ${error}. Scoring will proceed without modifiers.`
        );
        entityMap = new Map();
      }

      const finalScores = applyScoreModifiersFromEntities({
        now,
        identifierType: entityType,
        weights: [],
        page: {
          scores,
          identifierField: 'entity_id',
        },
        entities: entityMap,
        watchlistConfigs,
      });

      yield { entityIds: euidValues, scores: finalScores };
    }
  } while (afterKey !== undefined);
};

export const scoreBaseEntities = async ({
  writer,
  idBasedRiskScoringEnabled,
  ...params
}: ScoreAndPersistBaseEntitiesParams): Promise<string[]> => {
  // Persists each base-score page to the risk score index and, when enabled,
  // dual-writes the same base scores to Entity Store via persistScoredPage().
  const scoredEntityIds: string[] = [];

  for await (const page of calculateBaseEntityScores(params)) {
    scoredEntityIds.push(...page.entityIds);
    await persistScoredPage({
      writer,
      crudClient: params.crudClient,
      logger: params.logger,
      entityType: params.entityType,
      idBasedRiskScoringEnabled,
      page,
    });
  }

  return scoredEntityIds;
};
