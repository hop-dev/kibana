/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// V2 maintainer copy kept separate from legacy reset-to-zero to avoid
// optional-dependency branching between pipelines.

import type { ElasticsearchClient } from '@kbn/core/server';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import {
  EntityIdentifierFields,
  type EntityType,
} from '../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { RiskScoreDataClient } from '../risk_score_data_client';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import { getIndexPatternDataStream } from '../configurations';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import { fetchEntitiesByIds } from './utils/fetch_entities_by_ids';
import type { ScopedLogger } from './utils/with_log_context';
import type { ParsedRiskScore } from './parse_esql_row';

export interface ResetToZeroDependencies {
  esClient: ElasticsearchClient;
  dataClient: RiskScoreDataClient;
  spaceId: string;
  entityType: EntityType;
  logger: ScopedLogger;
  crudClient: EntityUpdateClient;
  watchlistConfigs: Map<string, WatchlistObject>;
  idBasedRiskScoringEnabled: boolean;
  calculationRunId: string;
}

const RISK_SCORE_FIELD = 'risk.calculated_score_norm';
const RISK_SCORE_ID_VALUE_FIELD = 'risk.id_value';
const RISK_SCORE_TYPE_FIELD = 'risk.score_type';
const RISK_SCORE_RUN_ID_FIELD = 'risk.calculation_run_id';

export const resetToZero = async ({
  esClient,
  dataClient,
  spaceId,
  entityType,
  logger,
  crudClient,
  watchlistConfigs,
  idBasedRiskScoringEnabled,
  calculationRunId,
}: ResetToZeroDependencies): Promise<{ scoresWritten: number }> => {
  const { alias } = await getIndexPatternDataStream(spaceId);
  const entityField = `${entityType}.${RISK_SCORE_ID_VALUE_FIELD}`;
  const scoreField = `${entityType}.${RISK_SCORE_FIELD}`;
  const scoreTypeField = `${entityType}.${RISK_SCORE_TYPE_FIELD}`;
  const runIdField = `${entityType}.${RISK_SCORE_RUN_ID_FIELD}`;
  const identifierField = EntityIdentifierFields.generic;
  const esql = /* sql */ `
    FROM ${alias}
    | EVAL id_value = TO_STRING(${entityField})
    | EVAL score = TO_DOUBLE(${scoreField})
    | EVAL score_type = TO_STRING(${scoreTypeField})
    | EVAL calculation_run_id = TO_STRING(${runIdField})
    | WHERE id_value IS NOT NULL AND id_value != ""
    | WHERE score_type IS NULL OR score_type == "base"
    | SORT @timestamp DESC
    | DEDUP id_value
    | WHERE score > 0
    | WHERE calculation_run_id IS NULL OR calculation_run_id != "${calculationRunId}"
    | KEEP id_value
    | LIMIT 10000
    `;

  logger.debug(`reset_to_zero ESQL query:\n${esql}`);

  const response = await esClient.esql.query({ query: esql }).catch((e) => {
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
    logger.debug('reset_to_zero found no stale entities');
    return { scoresWritten: 0 };
  }

  logger.debug(`reset_to_zero found ${entityIds.length} stale entities`);

  const baseScores: ParsedRiskScore[] = entityIds.map((entityId) => ({
    entity_id: entityId,
    alert_count: 0,
    score: 0,
    normalized_score: 0,
    risk_inputs: [],
  }));

  const entities = await fetchEntitiesByIds({
    crudClient,
    entityIds,
    logger,
    errorContext:
      'Error fetching entities for reset-to-zero modifier application. Reset will proceed without modifiers',
  });

  const scores = applyScoreModifiersFromEntities({
    now: new Date().toISOString(),
    identifierType: entityType,
    calculationRunId,
    page: {
      scores: baseScores,
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
