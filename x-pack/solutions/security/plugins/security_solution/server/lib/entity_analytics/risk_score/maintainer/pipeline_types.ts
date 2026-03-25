/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * All types internal to the V2 maintainer pipeline.
 * Nothing in this file is exported outside `risk_score/`.
 */

import type { ParsedRiskScore } from './parse_esql_row';

/** Document stored in .entity_analytics.risk_score.lookup-{namespace}.
 * The entity_id is also the ES _id. */
export interface LookupIndexDocument {
  entity_id: string;
  /** Strictly for Alias -> Target Entity resolution. */
  resolution_target_id?: string;
  /** Post-9.4 (Asset Ownership); strictly for cross-type risk transfer. */
  propagation_target_id?: string;
  /** Full ECS path, e.g. 'entity.relationships.resolution.resolved_to'. */
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

/** Output of categorizeEntities(): separates a scored page into the three write paths. */
export interface CategorizedEntities {
  /** Entities that exist in the Entity Store and have no relationships. Dual-write immediately. */
  individual: ParsedRiskScore[];
  /** Entities that have relationships. Write to lookup index; defer scoring to Phase 2. */
  deferred: Array<{ score: ParsedRiskScore; lookupDoc: LookupIndexDocument }>;
  /** Entities not found in the Entity Store. Skip Entity Store write. */
  unknown: ParsedRiskScore[];
  /** Explicit deletes for entities that were active but lost all relationships. */
  lookupDeletes: string[];
}

export interface MaintainerPhase1Stats {
  entitiesScored: number;
  individualWrites: number;
  deferredToLookup: number;
  lookupDeletes: number;
  unknownEntities: number;
}

export interface MaintainerPhase2Stats {
  resolutionGroupsScored: number;
  resolutionWrites: number;
}
