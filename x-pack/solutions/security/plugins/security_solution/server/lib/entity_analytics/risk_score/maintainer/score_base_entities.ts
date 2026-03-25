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
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';

interface ScoreBaseEntitiesParams {
  esClient: ElasticsearchClient;
  crudClient: EntityStoreCRUDClient;
  writer: RiskEngineDataWriter;
  logger: Logger;
  entityType: EntityType;
  alertFilters: QueryDslQueryContainer[];
  alertsIndex: string;
  pageSize: number;
  sampleSize: number;
  now: string;
  watchlistConfigs: Map<string, WatchlistObject>;
  idBasedRiskScoringEnabled: boolean;
}

/**
 * Phase 1: Base Scoring for a single entity type.
 *
 * Paginates through all entities with active alerts using a composite
 * aggregation, scores each page via ES|QL, fetches entity documents
 * for modifier application, and persists scores to both the Risk Index
 * and (optionally) the Entity Store.
 *
 * Returns the list of scored entity IDs for use in reset-to-zero exclusion.
 */
export const scoreBaseEntities = async ({
  esClient,
  crudClient,
  writer,
  logger,
  entityType,
  alertFilters,
  alertsIndex,
  pageSize,
  sampleSize,
  now,
  watchlistConfigs,
  idBasedRiskScoringEnabled,
}: ScoreBaseEntitiesParams): Promise<string[]> => {
  let afterKey: Record<string, string> | undefined;
  const scoredEntityIds: string[] = [];

  do {
    // Step 1: Paginate entity IDs via composite agg using Painless EUID runtime mapping.
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

    // Step 2: Score the page with ES|QL.
    const esqlResponse = await esClient.esql.query({
      query: getBaseScoreESQL(entityType, { lower, upper }, sampleSize, pageSize, alertsIndex),
    });

    // Parse each row into a strong domain type
    const scores = (esqlResponse.values ?? []).map(parseEsqlBaseScoreRow(alertsIndex));

    if (scores.length > 0) {
      // Step 3: Fetch entities from the Entity Store for modifier application.
      const euidValues = scores.map((score) => score.entity_id);
      scoredEntityIds.push(...euidValues);
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

      // Step 4: Apply score modifiers from entity documents.
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

      // Step 5: Persist risk scores.
      await writer.bulk({ [entityType]: finalScores });

      // Step 6: Dual-write to entity store (update existing entities only).
      if (idBasedRiskScoringEnabled) {
        const entityStoreErrors = await persistRiskScoresToEntityStore({
          crudClient,
          logger,
          scores: { [entityType]: finalScores },
        });
        if (entityStoreErrors.length > 0) {
          logger.warn(
            `Entity store dual-write had ${
              entityStoreErrors.length
            } error(s): ${entityStoreErrors.join('; ')}`
          );
        }
      }
    }
  } while (afterKey !== undefined);

  return scoredEntityIds;
};
