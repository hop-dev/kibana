/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { Entity } from '@kbn/entity-store/common';

interface FetchEntitiesByIdsParams {
  crudClient: EntityStoreCRUDClient;
  entityIds: string[];
  logger: Logger;
  errorContext: string;
}

export const fetchEntitiesByIds = async ({
  crudClient,
  entityIds,
  logger,
  errorContext,
}: FetchEntitiesByIdsParams): Promise<Map<string, Entity>> => {
  const entityMap = new Map<string, Entity>();

  if (entityIds.length === 0) {
    return entityMap;
  }

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
    logger.warn(`${errorContext}: ${error}`);
  }

  return entityMap;
};
