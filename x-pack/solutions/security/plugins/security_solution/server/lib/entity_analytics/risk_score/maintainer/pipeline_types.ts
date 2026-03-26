/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Shared types for the active Phase 1 maintainer runtime path. */

import type { Entity } from '@kbn/entity-store/common';
import type { EntityRiskScoreRecord } from '../../../../../common/api/entity_analytics/common';

/** Output of categorizeEntities() for downstream write/routing decisions. */
export interface CategorizedEntities {
  /** Entities missing in Entity Store. */
  not_in_store: EntityRiskScoreRecord[];
  /** Scores that are final in Phase 1 and safe to persist immediately. */
  write_now: EntityRiskScoreRecord[];
  /** Scores that should be deferred to Phase 2 once aggregation is enabled. */
  defer_to_phase_2: EntityRiskScoreRecord[];
}

/** Shared scored page shape used across maintainer loops. */
export interface ScoredEntityPage {
  entityIds: string[];
  scores: EntityRiskScoreRecord[];
  entities: Map<string, Entity>;
}
