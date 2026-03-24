/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Dedicated V2 copy of ../reset_to_zero.ts. Duplicated rather than shared so
// each pipeline has its own required-dep signature with no optional-dep
// polymorphism. The V1 original will be removed when legacy scoring is deleted.

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { Entity } from '@kbn/entity-store/common';
import {
  EntityIdentifierFields,
  type EntityType,
} from '../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskScoreDataClient } from '../risk_score_data_client';
import type { RiskScoreBucket } from '../../types';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import { getIndexPatternDataStream } from '../configurations';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';

export interface ResetToZeroDependencies {
  esClient: ElasticsearchClient;
  dataClient: RiskScoreDataClient;
  spaceId: string;
  entityType: EntityType;
  logger: Logger;
  excludedEntities: string[];
  crudClient: EntityStoreCRUDClient;
  watchlistConfigs: Map<string, WatchlistObject>;
  idBasedRiskScoringEnabled: boolean;
}

const RISK_SCORE_FIELD = 'risk.calculated_score_norm';
const RISK_SCORE_ID_VALUE_FIELD = 'risk.id_value';

export const resetToZero = async ({
  esClient,
  dataClient,
  spaceId,
  entityType,
  logger,
  excludedEntities,
  crudClient,
  watchlistConfigs,
  idBasedRiskScoringEnabled,
}: ResetToZeroDependencies): Promise<{ scoresWritten: number }> => {
  const { alias } = await getIndexPatternDataStream(spaceId);
  const entityField = `${entityType}.${RISK_SCORE_ID_VALUE_FIELD}`;
  const identifierField = EntityIdentifierFields.generic;
  const esql = /* sql */ `
    FROM ${alias}
    | WHERE ${entityType}.${RISK_SCORE_FIELD} > 0
    | EVAL id_value = TO_STRING(${entityField})
    | WHERE id_value IS NOT NULL AND id_value != ""
    | STATS count = count(id_value) BY id_value
    | KEEP id_value
    | LIMIT 10000
    `;

  logger.debug(`Reset to zero ESQL query:\n${esql}`);

  const exclusionFilter =
    excludedEntities.length > 0
      ? { bool: { must_not: [{ terms: { [identifierField]: excludedEntities } }] } }
      : undefined;

  const response = await esClient.esql
    .query({
      query: esql,
      ...(exclusionFilter ? { filter: exclusionFilter } : {}),
    })
    .catch((e) => {
      logger.error(
        `Error executing ESQL query to reset ${entityType} risk scores to zero: ${e.message}`
      );
      throw e;
    });

  const entityIds = response.values.reduce<string[]>((acc, row) => {
    const [entity] = row;
    if (typeof entity !== 'string' || entity === '') {
      return acc;
    }
    acc.push(entity);
    return acc;
  }, []);

  if (entityIds.length === 0) {
    return { scoresWritten: 0 };
  }

  const buckets: RiskScoreBucket[] = entityIds.map((entity) => ({
    key: { [identifierField]: entity },
    doc_count: 0,
    top_inputs: {
      doc_count: 0,
      risk_details: {
        value: {
          score: 0,
          normalized_score: 0,
          notes: [],
          category_1_score: 0,
          category_1_count: 0,
          risk_inputs: [],
        },
      },
    },
  }));

  const entities = await fetchEntitiesForReset({ crudClient, entityIds, logger });

  const scores = applyScoreModifiersFromEntities({
    now: new Date().toISOString(),
    identifierType: entityType,
    page: {
      buckets,
      identifierField,
    },
    entities,
    watchlistConfigs,
  });

  const writer = await dataClient.getWriter({ namespace: spaceId });
  await writer.bulk({ [entityType]: scores }).catch((e) => {
    logger.error(`Error resetting ${entityType} risk scores to zero: ${e.message}`);
    throw e;
  });

  if (idBasedRiskScoringEnabled) {
    const entityStoreErrors = await persistRiskScoresToEntityStore({
      crudClient,
      logger,
      scores: { [entityType]: scores },
    });

    if (entityStoreErrors.length > 0) {
      logger.warn(
        `Entity store v2 write had ${
          entityStoreErrors.length
        } error(s) during reset: ${entityStoreErrors.join('; ')}`
      );
    }
  }

  return { scoresWritten: scores.length };
};

const fetchEntitiesForReset = async ({
  crudClient,
  entityIds,
  logger,
}: {
  crudClient: EntityStoreCRUDClient;
  entityIds: string[];
  logger: Logger;
}): Promise<Map<string, Entity>> => {
  const entityMap = new Map<string, Entity>();

  try {
    let searchAfter: Array<string | number> | undefined;
    do {
      const { entities: batch, nextSearchAfter } = await crudClient.listEntities({
        filter: { terms: { 'entity.id': entityIds } },
        size: entityIds.length,
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
      `Error fetching entities for reset-to-zero modifier application: ${error}. Reset will proceed without modifiers.`
    );
  }

  return entityMap;
};
