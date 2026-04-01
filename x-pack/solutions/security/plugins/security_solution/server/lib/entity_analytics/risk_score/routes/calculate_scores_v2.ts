/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger, SavedObjectsClientContract } from '@kbn/core/server';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import type { RiskScoresPreviewResponse } from '../../../../../common/api/entity_analytics';
import type { CalculateScoresParams } from '../../types';
import type { EntityType } from '../../../../../common/search_strategy';
import { EntityTypeToIdentifierField } from '../../../../../common/entity_analytics/types';
import { getEntityAnalyticsEntityTypes } from '../../../../../common/entity_analytics/utils';
import {
  getEuidCompositeQuery,
  getBaseScoreESQL,
  type EuidCompositeAggregation,
} from '../calculate_esql_risk_scores';
import { parseEsqlBaseScoreRow } from '../maintainer/steps/parse_esql_row';
import { fetchEntitiesByIds } from '../maintainer/utils/fetch_entities_by_ids';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import { fetchWatchlistConfigs } from '../maintainer/utils/fetch_watchlist_configs';
import { buildCommonAlertFilters } from '../maintainer/steps/build_alert_filters';

interface CalculateScoresWithESQLV2Params extends CalculateScoresParams {
  esClient: ElasticsearchClient;
  logger: Logger;
  crudClient: EntityUpdateClient;
  soClient: SavedObjectsClientContract;
  namespace: string;
}

const getEntityAfterKey = (
  afterKey: Record<string, string> | undefined,
  entityType: EntityType
): Record<string, string> | undefined => {
  if (!afterKey) return undefined;

  if (typeof afterKey.entity_id === 'string') {
    return { entity_id: afterKey.entity_id };
  }

  const identifierField = EntityTypeToIdentifierField[entityType];
  const identifierValue = afterKey[identifierField];
  if (typeof identifierValue === 'string') {
    if (identifierValue.startsWith(`${entityType}:`)) {
      return { entity_id: identifierValue };
    }
    return { entity_id: `${entityType}:${identifierValue}` };
  }

  const fallback = Object.values(afterKey).find(
    (value): value is string => typeof value === 'string'
  );
  return fallback ? { entity_id: fallback } : undefined;
};

const toResponseAfterKey = (
  afterKey: Record<string, string> | undefined,
  entityType: EntityType
): Record<string, string> => {
  if (!afterKey?.entity_id) {
    return {};
  }

  const identifierField = EntityTypeToIdentifierField[entityType];
  const prefix = `${entityType}:`;
  const entityIdValue = afterKey.entity_id;
  const identifierValue = entityIdValue.startsWith(prefix)
    ? entityIdValue.slice(prefix.length)
    : entityIdValue;

  return { [identifierField]: identifierValue };
};

const toLegacyPreviewId = (entityType: EntityType, entityId: string): string => {
  const prefix = `${entityType}:`;
  return entityId.startsWith(prefix) ? entityId.slice(prefix.length) : entityId;
};

export const calculateScoresWithESQLV2 = async ({
  afterKeys,
  identifierType,
  index,
  pageSize,
  range,
  filter,
  weights,
  alertSampleSizePerShard,
  excludeAlertStatuses,
  excludeAlertTags,
  filters,
  esClient,
  logger,
  crudClient,
  soClient,
  namespace,
}: CalculateScoresWithESQLV2Params): Promise<RiskScoresPreviewResponse> => {
  const now = new Date().toISOString();
  const sampleSize = alertSampleSizePerShard ?? 10000;
  const identifierTypes: EntityType[] = identifierType
    ? [identifierType]
    : getEntityAnalyticsEntityTypes();
  const watchlistConfigs = await fetchWatchlistConfigs({ soClient, esClient, namespace, logger });

  const response: RiskScoresPreviewResponse = { after_keys: {}, scores: {} };

  for (const currentEntityType of identifierTypes) {
    const entityAfterKey = getEntityAfterKey(afterKeys[currentEntityType], currentEntityType);
    const entityFilters = buildCommonAlertFilters(
      {
        range,
        filter,
        excludeAlertStatuses,
        excludeAlertTags,
        filters,
      },
      currentEntityType
    );

    const compositeResponse = await esClient.search(
      getEuidCompositeQuery(currentEntityType, entityFilters, {
        index,
        pageSize,
        afterKey: entityAfterKey,
      })
    );

    const compositeAgg = (
      compositeResponse.aggregations as { by_entity_id?: EuidCompositeAggregation } | undefined
    )?.by_entity_id;
    const buckets = compositeAgg?.buckets ?? [];
    response.after_keys[currentEntityType] = toResponseAfterKey(
      compositeAgg?.after_key,
      currentEntityType
    );

    if (buckets.length === 0) {
      response.scores[currentEntityType] = [];
    } else {
      const upper = buckets[buckets.length - 1].key.entity_id;
      const query = getBaseScoreESQL(
        currentEntityType,
        { lower: entityAfterKey?.entity_id, upper },
        sampleSize,
        pageSize,
        index
      );
      const esqlResponse = await esClient.esql.query({ query });
      const baseScores = (esqlResponse.values ?? []).map(parseEsqlBaseScoreRow(index));
      const entityIds = baseScores.map((score) => score.entity_id);
      const entities = await fetchEntitiesByIds({
        crudClient,
        entityIds,
        logger,
        errorContext:
          'Error fetching entities for preview modifier application. Scoring will proceed without modifiers',
      });

      const scores = applyScoreModifiersFromEntities({
        now,
        identifierType: currentEntityType,
        scoreType: 'base',
        weights,
        page: {
          scores: baseScores,
          identifierField: 'entity_id',
        },
        entities,
        watchlistConfigs,
      }).map((score) => ({
        ...score,
        id_field: EntityTypeToIdentifierField[currentEntityType],
        id_value: toLegacyPreviewId(currentEntityType, score.id_value),
      }));

      response.scores[currentEntityType] = scores;
    }
  }

  return response;
};
