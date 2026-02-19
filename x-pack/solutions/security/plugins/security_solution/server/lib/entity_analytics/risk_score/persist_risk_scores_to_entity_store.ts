/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { set } from '@kbn/safer-lodash-set';

import { EntityType } from '../../../../common/search_strategy';
import type { EntityRiskScoreRecord } from '../../../../common/api/entity_analytics/common';
import type { BulkObject } from '../entity_store_v2/temp_entity_store_v2_writer';
import { TempEntityStoreV2Writer } from '../entity_store_v2/temp_entity_store_v2_writer';

type ScoreWithIdentity = EntityRiskScoreRecord & {
  euid_fields?: Record<string, string | null>;
};

const scoreToV2Document = (score: ScoreWithIdentity): Record<string, unknown> => {
  const document: Record<string, unknown> = {
    '@timestamp': score['@timestamp'],
    entity: {
      id: score.id_value,
      risk: {
        calculated_score: score.calculated_score,
        calculated_score_norm: score.calculated_score_norm,
        calculated_level: score.calculated_level,
      },
    },
  };
  // euid fields are flattened and may conain null or empty values
  // apply them to the document if they are not null or empty
  Object.entries(score.euid_fields || {}).forEach(([path, value]) => {
    if (value != null && value !== '') {
      set(document, path, value);
    }
  });

  return document;
};

const buildV2BulkObjectsFromScores = (
  scores: Partial<Record<EntityType, EntityRiskScoreRecord[]>>
): BulkObject[] => {
  const result: BulkObject[] = [];
  Object.values(EntityType).forEach((entityType) => {
    const entityScores = scores[entityType];
    if (entityScores) {
      entityScores.forEach((score) => {
        result.push({
          type: entityType,
          document: scoreToV2Document(score as ScoreWithIdentity),
        });
      });
    }
  });
  return result;
};

export const persistRiskScoresToEntityStore = async ({
  esClient,
  logger,
  spaceId,
  scores,
  refresh,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
  spaceId: string;
  scores: Partial<Record<EntityType, EntityRiskScoreRecord[]>>;
  refresh?: boolean | 'wait_for';
}): Promise<string[]> => {
  const errors: string[] = [];
  try {
    const storeWriter = new TempEntityStoreV2Writer(esClient, spaceId);
    const bulkObjects = buildV2BulkObjectsFromScores(scores);
    const result = await storeWriter.upsertEntitiesBulk(bulkObjects, { refresh });
    if (result.errors.length > 0) {
      logger.warn(
        `Entity store v2 write had ${result.errors.length} error(s): ${result.errors.join('; ')}`
      );
      errors.push(...result.errors);
    }
  } catch (err) {
    logger.error(`Failed to write risk scores to entity store v2: ${(err as Error).message}`);
    errors.push((err as Error).message);
  }
  return errors;
};
