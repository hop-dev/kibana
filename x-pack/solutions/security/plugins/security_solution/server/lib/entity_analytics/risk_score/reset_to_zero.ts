/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../common/entity_analytics/types';
import type { RiskScoreDataClient } from './risk_score_data_client';
import type { AssetCriticalityService } from '../asset_criticality';
import type { RiskScoreBucket } from '../types';
import { getOutputIdentifierField, processScores } from './helpers';
import { getIndexPatternDataStream } from './configurations';
import { persistRiskScoresToEntityStore } from './persist_risk_scores_to_entity_store';

export interface ResetToZeroDependencies {
  esClient: ElasticsearchClient;
  dataClient: RiskScoreDataClient;
  spaceId: string;
  entityType: EntityType;
  assetCriticalityService: AssetCriticalityService;
  logger: Logger;
  excludedEntities: string[];
  idBasedRiskScoringEnabled: boolean;
  entityStoreCRUDClient?: EntityStoreCRUDClient;
  refresh?: 'wait_for';
}

const RISK_SCORE_FIELD = 'risk.calculated_score_norm';
const RISK_SCORE_ID_VALUE_FIELD = 'risk.id_value';

export const resetToZero = async ({
  esClient,
  dataClient,
  spaceId,
  entityType,
  assetCriticalityService,
  logger,
  refresh,
  excludedEntities,
  idBasedRiskScoringEnabled,
  entityStoreCRUDClient,
}: ResetToZeroDependencies): Promise<{ scoresWritten: number }> => {
  const { alias } = await getIndexPatternDataStream(spaceId);
  const identifierField = getOutputIdentifierField(entityType, idBasedRiskScoringEnabled);

  const entities = await fetchEntitiesWithNonZeroScores({
    esClient,
    logger,
    alias,
    entityType,
    excludedEntities,
  });

  if (entities.length === 0) {
    return { scoresWritten: 0 };
  }

  const buckets = buildZeroScoreBuckets(entities, identifierField);

  const scores = await processScores({
    assetCriticalityService,
    buckets,
    identifierField,
    logger,
    now: new Date().toISOString(),
  });

  const writer = await dataClient.getWriter({ namespace: spaceId });
  await writer.bulk({ [entityType]: scores, refresh }).catch((e) => {
    logger.error(`Error resetting ${entityType} risk scores to zero: ${e.message}`);
    throw e;
  });

  if (idBasedRiskScoringEnabled && entityStoreCRUDClient) {
    const entityStoreErrors = await persistRiskScoresToEntityStore({
      entityStoreCRUDClient,
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

/**
 * Query the risk score index for entities with non-zero scores that were NOT part of the
 * current scoring run (i.e. not in `excludedEntities`). These need to be reset to zero.
 *
 * The `id_value` field in the risk index already contains the correct identifier for both
 * V1 (entity name like "server-1") and V2 (EUID like "host:server-1"). No runtime mapping
 * is needed here because the EUID was computed and persisted during the scoring phase.
 */
const fetchEntitiesWithNonZeroScores = async ({
  esClient,
  logger,
  alias,
  entityType,
  excludedEntities,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
  alias: string;
  entityType: EntityType;
  excludedEntities: string[];
}): Promise<string[]> => {
  const entityField = `${entityType}.${RISK_SCORE_ID_VALUE_FIELD}`;
  const excludedEntitiesClause =
    excludedEntities.length > 0
      ? `AND id_value NOT IN (${excludedEntities.map((e) => `"${e}"`).join(',')})`
      : '';

  const esql = /* ESQL */ `
    FROM ${alias}
    | WHERE ${entityType}.${RISK_SCORE_FIELD} > 0
    | EVAL id_value = TO_STRING(${entityField})
    | WHERE id_value IS NOT NULL AND id_value != "" ${excludedEntitiesClause}
    | STATS count = count(id_value) BY id_value
    | KEEP id_value
    `;

  logger.debug(`Reset to zero ESQL query:\n${esql}`);

  const response = await esClient.esql.query({ query: esql }).catch((e) => {
    logger.error(
      `Error executing ESQL query to reset ${entityType} risk scores to zero: ${e.message}`
    );
    logger.debug(
      `Full reset-to-zero query error: ${JSON.stringify(e?.body?.error?.root_cause || e)}`
    );
    throw e;
  });

  return response.values.reduce<string[]>((acc, row) => {
    const [entity] = row;
    if (typeof entity === 'string' && entity !== '') {
      acc.push(entity);
    }
    return acc;
  }, []);
};

const buildZeroScoreBuckets = (entities: string[], identifierField: string): RiskScoreBucket[] =>
  entities.map((entity) => ({
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
