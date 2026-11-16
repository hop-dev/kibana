/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EntityUpdateClient } from '@kbn/entity-store/server';

/** The asset criticality that makes an entity a crown jewel. */
export const CROWN_JEWEL_CRITICALITY = 'extreme_impact';

const PAGE_SIZE = 1_000;

/** The ids of every entity marked as a crown jewel in the space. */
export const listCrownJewels = async (crudClient: EntityUpdateClient): Promise<string[]> => {
  const ids: string[] = [];
  let searchAfter: Array<string | number> | undefined;
  do {
    const { entities, nextSearchAfter } = await crudClient.listEntities({
      filter: { term: { 'asset.criticality': CROWN_JEWEL_CRITICALITY } },
      source: ['entity.id'],
      sort: [{ 'entity.id': 'asc' }],
      size: PAGE_SIZE,
      searchAfter,
    });
    for (const { entity } of entities) {
      if (entity?.id) ids.push(entity.id);
    }
    searchAfter = entities.length === PAGE_SIZE ? nextSearchAfter : undefined;
  } while (searchAfter);
  return ids;
};
