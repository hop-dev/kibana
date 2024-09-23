/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { entityDefinitionSchema, type EntityDefinition } from '@kbn/entities-schema';
import { getRiskScoreLatestIndex } from '../../../../common/entity_analytics/risk_engine';
import { getAssetCriticalityIndex } from '../../../../common/entity_analytics/asset_criticality';
import { ENTITY_STORE_DEFAULT_SOURCE_INDICES } from './constants';
import { getEntityDefinitionId } from './utils/utils';
import type { EntityType } from '../../../../common/api/entity_analytics/entity_store/common.gen';

const buildHostEntityDefinition = (): EntityDefinition =>
  entityDefinitionSchema.parse({
    id: getEntityDefinitionId('host'),
    name: 'EA Host Store',
    type: 'host',
    indexPatterns: ENTITY_STORE_DEFAULT_SOURCE_INDICES,
    identityFields: ['host.name'],
    displayNameTemplate: '{{host.name}}',
    metadata: [
      'asset.criticality',
      'host.domain',
      'host.hostname',
      'host.id',
      'host.ip',
      'host.mac',
      'host.name',
      'host.type',
      'host.architecture',
      'host.risk.calculated_level',
    ],
    history: {
      timestampField: '@timestamp',
      interval: '1m',
    },
    version: '1.0.0',
  });

const buildUserEntityDefinition = (): EntityDefinition =>
  entityDefinitionSchema.parse({
    id: getEntityDefinitionId('user'),
    name: 'EA User Store',
    type: 'user',
    indexPatterns: ENTITY_STORE_DEFAULT_SOURCE_INDICES,
    identityFields: ['user.name'],
    displayNameTemplate: '{{user.name}}',
    metadata: [
      'asset.criticality',
      'user.domain',
      'user.email',
      'user.full_name',
      'user.hash',
      'user.id',
      'user.name',
      'user.roles',
      'user.risk.calculated_level',
    ],
    history: {
      timestampField: '@timestamp',
      interval: '1m',
    },
    version: '1.0.0',
  });

const ENTITY_TYPE_TO_ENTITY_DEFINITION: Record<EntityType, EntityDefinition> = {
  host: buildHostEntityDefinition(),
  user: buildUserEntityDefinition(),
};

// TODO: space support
export const getDefinitionForEntityType = (entityType: EntityType, spaceId: string = 'default') => {
  const entityDefinition = { ...ENTITY_TYPE_TO_ENTITY_DEFINITION[entityType] };

  entityDefinition.indexPatterns.push(
    getAssetCriticalityIndex(spaceId),
    getRiskScoreLatestIndex(spaceId)
  );

  return entityDefinition;
};
