/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Shared types for the maintainer pipeline.
 */

import type { EntityRiskScoreRecord } from '../../../../../common/api/entity_analytics/common';
import type { Entity } from '@kbn/entity-store/common';

/** Document stored in .entity_analytics.risk_score.lookup-{namespace}. */
export interface LookupIndexDocument {
  entity_id: string;
  /** Alias -> target entity resolution routing key. */
  resolution_target_id?: string;
  /** Cross-entity propagation routing key (for example host -> user). */
  propagation_target_id?: string;
  /** Relationship field path from the source entity. */
  relationship_type: string;
  '@timestamp': string;
}

/** Raw ES|QL row returned by the Phase 2 Loop 2 resolution scoring query. */
export interface EsqlResolutionScoreRow {
  resolution_target_id: string;
  scores: number;
  /** "entity_id|relationship_type" */
  contributing_entities_raw: string | string[];
  risk_inputs: string | string[];
}

/** Output of categorizeEntities() for downstream write/routing decisions. */
export interface CategorizedEntities {
  /** Entities missing in Entity Store. */
  not_in_store: EntityRiskScoreRecord[];
  /** Scores that are final in Phase 1 and safe to persist immediately. */
  write_now: EntityRiskScoreRecord[];
  /** Scores that should be deferred to Phase 2 once aggregation is enabled. */
  defer_to_phase_2: Array<{ score: EntityRiskScoreRecord; lookupDoc: LookupIndexDocument }>;
  /** Lookup ids to delete when relationships are removed. */
  lookupDeletes: string[];
}

export interface MaintainerPhase1Stats {
  entitiesScored: number;
  writeNowCount: number;
  deferToPhase2Count: number;
  lookupDeletes: number;
  notInStoreCount: number;
}

export interface MaintainerPhase2Stats {
  resolutionGroupsScored: number;
  resolutionWrites: number;
}

/** Shared scored page shape used across maintainer loops. */
export interface ScoredEntityPage {
  entityIds: string[];
  scores: EntityRiskScoreRecord[];
  entities: Map<string, Entity>;
}
