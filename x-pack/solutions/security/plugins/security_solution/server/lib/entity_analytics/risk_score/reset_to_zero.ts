/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import {
  EntityIdentifierFields,
  EntityTypeToIdentifierField,
  type EntityType,
} from '../../../../common/entity_analytics/types';
import type { RiskScoreDataClient } from './risk_score_data_client';
import type { AssetCriticalityService } from '../asset_criticality';
import type { RiskScoreBucket } from '../types';
import { processScores } from './helpers';
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
  useEntityStoreV2: boolean;
  refresh?: 'wait_for';
}

const RISK_SCORE_FIELD = 'risk.calculated_score_norm';
const RISK_SCORE_ID_VALUE_FIELD = 'risk.id_value';
const RISK_SCORE_ID_FIELD = 'risk.id_field';

const getExpectedIdentifierField = ({
  entityType,
  useEntityStoreV2,
}: {
  entityType: EntityType;
  useEntityStoreV2: boolean;
}) => (useEntityStoreV2 ? EntityIdentifierFields.generic : EntityTypeToIdentifierField[entityType]);

export const resetToZero = async ({
  esClient,
  dataClient,
  spaceId,
  entityType,
  assetCriticalityService,
  logger,
  refresh,
  excludedEntities,
  useEntityStoreV2,
}: ResetToZeroDependencies): Promise<{ scoresWritten: number }> => {
  const { alias } = await getIndexPatternDataStream(spaceId);
  const entityField = `${entityType}.${RISK_SCORE_ID_VALUE_FIELD}`;
  const expectedIdentifierField = getExpectedIdentifierField({ entityType, useEntityStoreV2 });
  const excludedEntitiesClause = `AND id_value NOT IN (${excludedEntities
    .map((e) => `"${e}"`)
    .join(',')})`;
  const esql = /* sql */ `
    FROM ${alias} 
    | WHERE ${entityType}.${RISK_SCORE_FIELD} > 0
    | EVAL id_value = TO_STRING(${entityField}),
           id_field = TO_STRING(${entityType}.${RISK_SCORE_ID_FIELD})
    | WHERE id_value IS NOT NULL AND id_value != "" ${
      excludedEntities.length > 0 ? excludedEntitiesClause : ''
    }
    | STATS count = count(id_value), id_field = FIRST(id_field) BY id_value
    | KEEP id_value, id_field
    `;

  logger.debug(`Reset to zero ESQL query:\n${esql}`);

  const response = await esClient.esql
    .query({
      query: esql,
    })
    .catch((e) => {
      logger.error(
        `Error executing ESQL query to reset ${entityType} risk scores to zero: ${e.message}`
      );
      throw e;
    });

  const entities = response.values.reduce<string[]>((acc, row) => {
    const [entity] = row;
    if (typeof entity !== 'string' || entity === '') {
      return acc;
    }
    acc.push(entity);
    return acc;
  }, []);

  const extractedIdentifierFields = Array.from(
    new Set(
      response.values.flatMap((row) => {
        const [, idField] = row;
        return typeof idField === 'string' && idField !== '' ? [idField] : [];
      })
    )
  );

  const identifierField =
    extractedIdentifierFields.length === 1 ? extractedIdentifierFields[0] : expectedIdentifierField;

  if (extractedIdentifierFields.length > 1) {
    logger.warn(
      `Multiple id_field values found while resetting ${entityType} scores (${extractedIdentifierFields.join(
        ', '
      )}); falling back to ${expectedIdentifierField}.`
    );
  }

  const buckets: RiskScoreBucket[] = entities.map((entity) => {
    const bucket: RiskScoreBucket = {
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
    };
    return bucket;
  });

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

  if (useEntityStoreV2) {
    const entityStoreErrors = await persistRiskScoresToEntityStore({
      esClient,
      logger,
      spaceId,
      scores: { [entityType]: scores },
      refresh,
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
