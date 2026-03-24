/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Entity } from '@kbn/entity-store/common';

import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { EntityType } from '../../../../../common/entity_analytics/types';
import type { RiskScoreWeights } from '../../../../../common/api/entity_analytics/common';
import type { RiskScoreBucket } from '../../types';
import { getCriticalityModifier } from '../../asset_criticality/helpers';
import type { Modifier } from './types';
import { riskScoreDocFactory } from '../apply_score_modifiers';
import { getGlobalWeightForIdentifierType } from '../helpers';

/**
 * Extracts modifier metadata from a pre-fetched Entity document.
 *
 * Returns a tuple of [criticalityModifier, watchlistModifiers],
 * where watchlistModifiers is an array (one per matching watchlist).
 */
export const extractModifiersFromEntity = (
  entity: Entity | undefined,
  globalWeight?: number,
  watchlistConfigs?: Map<string, WatchlistObject>
): [Modifier<'asset_criticality'> | undefined, Array<Modifier<'watchlist'>>] => {
  const criticalityModifier = buildCriticalityModifier(entity, globalWeight);
  const watchlistModifiers = buildWatchlistModifiers(entity, globalWeight, watchlistConfigs);
  return [criticalityModifier, watchlistModifiers];
};

const buildCriticalityModifier = (
  entity: Entity | undefined,
  globalWeight?: number
): Modifier<'asset_criticality'> | undefined => {
  const criticalityLevel = entity?.asset?.criticality;
  const modifier = getCriticalityModifier(criticalityLevel);
  if (modifier == null) {
    return undefined;
  }

  const weightedModifier = globalWeight !== undefined ? modifier * globalWeight : modifier;

  return {
    type: 'asset_criticality',
    modifier_value: weightedModifier,
    metadata: {
      criticality_level: criticalityLevel,
    },
  };
};

const buildWatchlistModifiers = (
  entity: Entity | undefined,
  globalWeight?: number,
  watchlistConfigs?: Map<string, WatchlistObject>
): Array<Modifier<'watchlist'>> => {
  const watchlistIds = entity?.entity?.attributes?.watchlists;
  if (!watchlistIds || watchlistIds.length === 0 || !watchlistConfigs) {
    return [];
  }

  return watchlistIds.reduce<Array<Modifier<'watchlist'>>>((acc, watchlistId) => {
    const config = watchlistConfigs.get(watchlistId);
    if (config) {
      const modifierValue = config.riskModifier;
      const weightedModifier =
        globalWeight !== undefined ? modifierValue * globalWeight : modifierValue;

      acc.push({
        type: 'watchlist',
        subtype: config.name,
        modifier_value: weightedModifier,
        metadata: {
          watchlist_id: watchlistId,
        },
      });
    }
    return acc;
  }, []);
};

interface ApplyModifiersFromEntitiesParams {
  now: string;
  identifierType?: EntityType;
  weights?: RiskScoreWeights;
  page: {
    buckets: RiskScoreBucket[];
    identifierField: string;
  };
  entities: Map<string, Entity>;
  watchlistConfigs?: Map<string, WatchlistObject>;
}

/**
 * Applies score modifiers sourced from pre-fetched Entity Store documents.
 *
 * This replaces the legacy `applyScoreModifiers` for the V2 maintainer path.
 * Instead of querying asset criticality and privileged user indices separately,
 * it reads modifier metadata directly from entity documents.
 */
export const applyScoreModifiersFromEntities = ({
  now,
  identifierType,
  weights,
  page,
  entities,
  watchlistConfigs,
}: ApplyModifiersFromEntitiesParams) => {
  const globalWeight = identifierType
    ? getGlobalWeightForIdentifierType(identifierType, weights)
    : undefined;

  const modifiers = page.buckets.map((bucket) => {
    const entityId = bucket.key[page.identifierField];
    const entity = entities.get(entityId);
    return extractModifiersFromEntity(entity, globalWeight, watchlistConfigs);
  });

  const criticality = modifiers.map(([c]) => c);
  const watchlists = modifiers.map(([, w]) => w);

  const factory = riskScoreDocFactory({
    now,
    identifierField: page.identifierField,
    globalWeight,
  });

  return page.buckets.map((bucket, i) => factory(bucket, criticality[i], watchlists[i]));
};
