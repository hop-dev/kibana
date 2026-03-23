/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { EntityType } from '../../../../common/search_strategy';
import type { EntityRiskScoreRecord } from '../../../../common/api/entity_analytics/common';

/**
 * Persists risk scores to the entity store v2 (dual-write path).
 * TODO Phase 2: integrate with the entity store v2 writer once available.
 */
export const persistRiskScoresToEntityStore = async ({
  esClient: _esClient,
  logger,
  spaceId: _spaceId,
  scores,
  refresh: _refresh,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
  spaceId: string;
  scores: Partial<Record<EntityType, EntityRiskScoreRecord[]>>;
  refresh?: boolean | 'wait_for';
}): Promise<string[]> => {
  const total = Object.values(scores).reduce((sum, arr) => sum + (arr?.length ?? 0), 0);
  logger.debug(
    `persistRiskScoresToEntityStore: stub called with ${total} score(s) — Phase 2 not yet implemented`
  );
  return [];
};
