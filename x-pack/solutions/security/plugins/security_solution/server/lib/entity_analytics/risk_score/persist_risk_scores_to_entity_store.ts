/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { EntityStoreCRUDClient, BulkObject } from '@kbn/entity-store/server';
import type { Entity } from '@kbn/entity-store/common';
import type { EntityType } from '../../../../common/entity_analytics/types';
import type { EntityRiskScoreRecord } from '../../../../common/api/entity_analytics/common';

const scoreToEntityDoc = (
  entityType: EntityType,
  score: EntityRiskScoreRecord
): { type: EntityType; doc: Entity } => ({
  type: entityType,
  doc: {
    entity: {
      id: score.id_value,
      risk: {
        calculated_level: score.calculated_level,
        calculated_score: score.calculated_score,
        calculated_score_norm: score.calculated_score_norm,
      },
    },
  } as Entity,
});

export const persistRiskScoresToEntityStore = async ({
  crudClient,
  logger,
  scores,
}: {
  crudClient: EntityStoreCRUDClient;
  logger: Logger;
  scores: Partial<Record<EntityType, EntityRiskScoreRecord[]>>;
}): Promise<string[]> => {
  const allObjects: BulkObject[] = [];
  for (const [entityType, entityScores] of Object.entries(scores)) {
    if (entityScores && entityScores.length > 0) {
      for (const score of entityScores) {
        allObjects.push(scoreToEntityDoc(entityType as EntityType, score));
      }
    }
  }

  if (allObjects.length === 0) {
    return [];
  }

  // Pre-filter to entities that already exist in the store — bulkUpdateEntity
  // is update-only and will error for missing documents.
  const euidValues = allObjects.map((obj) => obj.doc.entity?.id).filter(Boolean) as string[];
  const { entities: existing } = await crudClient.listEntities({
    filter: { terms: { 'entity.id': euidValues } },
    size: euidValues.length,
  });

  const existingIds = new Set(existing.map((e) => e.entity?.id).filter(Boolean));
  const objectsToUpdate = allObjects.filter((obj) => {
    const id = obj.doc.entity?.id;
    return id && existingIds.has(id);
  });

  if (objectsToUpdate.length === 0) {
    logger.debug(
      `persistRiskScoresToEntityStore: ${allObjects.length} score(s) had no matching entities — skipping bulk update`
    );
    return [];
  }

  logger.debug(
    `persistRiskScoresToEntityStore: updating ${objectsToUpdate.length} of ${allObjects.length} scored entities`
  );

  const errors = await crudClient.bulkUpdateEntity({
    objects: objectsToUpdate,
    force: true,
  });

  return errors.map((e) => `[${e._id}] ${e.reason}`);
};
