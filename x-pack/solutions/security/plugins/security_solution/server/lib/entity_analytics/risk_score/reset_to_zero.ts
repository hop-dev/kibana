/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import {
  EntityTypeToIdentifierField,
  type EntityType,
} from '../../../../common/entity_analytics/types';
import type { ExperimentalFeatures } from '../../../../common';
import type { RiskScoreDataClient } from './risk_score_data_client';
import type { AssetCriticalityService } from '../asset_criticality';
import type { PrivmonUserCrudService } from '../privilege_monitoring/users/privileged_users_crud';
import type { RiskScoreBucket } from '../types';
import { applyScoreModifiers } from './apply_score_modifiers';
import { getIndexPatternDataStream } from './configurations';

export interface ResetToZeroDependencies {
  esClient: ElasticsearchClient;
  dataClient: RiskScoreDataClient;
  spaceId: string;
  entityType: EntityType;
  assetCriticalityService: AssetCriticalityService;
  privmonUserCrudService: PrivmonUserCrudService;
  logger: Logger;
  excludedEntities: string[];
  refresh?: 'wait_for';
  experimentalFeatures: ExperimentalFeatures;
}

const RISK_SCORE_FIELD = 'risk.calculated_score_norm';

export const resetToZero = async ({
  esClient,
  dataClient,
  spaceId,
  entityType,
  assetCriticalityService,
  privmonUserCrudService,
  logger,
  refresh,
  excludedEntities,
  experimentalFeatures,
}: ResetToZeroDependencies): Promise<{ scoresWritten: number }> => {
  const { alias } = await getIndexPatternDataStream(spaceId);
  const entityField = EntityTypeToIdentifierField[entityType];

  // Avoid interpolating a large exclusion list into the ES|QL query string.
  // We filter in JavaScript after receiving results instead.
  const esql = /* esql */ `
    FROM ${alias}
    | WHERE ${entityType}.${RISK_SCORE_FIELD} > 0
    | STATS count = count(${entityField}) BY ${entityField}, score_type
    | KEEP ${entityField}, score_type
    | LIMIT 10000
  `;

  logger.debug(`Reset to zero ESQL query:\n${esql}`);

  const response = await esClient.esql
    .query({ query: esql, format: 'array' })
    .catch((e) => {
      logger.error(
        `Error executing ESQL query to reset ${entityType} risk scores to zero: ${e.message}`
      );
      throw e;
    });

  const excludedSet = new Set(excludedEntities);
  const rowsToReset = (response.values as Array<[string, string | null]>).filter(
    ([entity]) => entity !== null && !excludedSet.has(entity)
  );

  const buckets: RiskScoreBucket[] = rowsToReset.map(([entity]) => {
    if (typeof entity !== 'string') {
      throw new Error(`Invalid entity value: ${entity}`);
    }
    return {
      key: { [entityField]: entity },
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
  });

  const scoreTypes = rowsToReset.map(([, scoreType]) => scoreType ?? 'individual');

  const now = new Date().toISOString();
  const rawScores = await applyScoreModifiers({
    now,
    identifierType: entityType,
    deps: { assetCriticalityService, privmonUserCrudService, logger },
    weights: [],
    page: { buckets, bounds: {}, identifierField: entityField },
    experimentalFeatures,
  });

  const scores = rawScores.map((score, i) => ({
    ...score,
    score_type: scoreTypes[i] as 'individual' | 'resolution' | undefined,
  }));

  const writer = await dataClient.getWriter({ namespace: spaceId });
  if (entityType === 'host') {
    await writer.bulk({ host: scores, refresh });
  } else if (entityType === 'user') {
    await writer.bulk({ user: scores, refresh });
  } else if (entityType === 'service') {
    await writer.bulk({ service: scores, refresh });
  }

  return { scoresWritten: scores.length };
};
