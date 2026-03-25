/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Entity } from '@kbn/entity-store/common';
import type { EntityRiskScoreRecord } from '../../../../../common/api/entity_analytics/common';
import { categorizePhase1Entities } from './categorize_phase1_entities';
import type { ScoredEntityPage } from './pipeline_types';

const score = (id: string): EntityRiskScoreRecord => ({
  '@timestamp': '2026-01-01T00:00:00.000Z',
  id_field: 'entity_id',
  id_value: id,
  calculated_level: 'Low',
  calculated_score: 10,
  calculated_score_norm: 10,
  category_1_score: 10,
  category_1_count: 1,
  inputs: [],
  notes: [],
});

describe('categorizePhase1Entities', () => {
  it('splits known and unknown entities using the fetched entity map', () => {
    const scoredPage: ScoredEntityPage = {
      entityIds: ['host:known-1', 'host:unknown-1'],
      scores: [score('host:known-1'), score('host:unknown-1')],
      entities: new Map<string, Entity>([['host:known-1', { entity: { id: 'host:known-1' } } as Entity]]),
    };

    const categorized = categorizePhase1Entities(scoredPage);

    expect(categorized.write_now).toEqual([score('host:known-1')]);
    expect(categorized.not_in_store).toEqual([score('host:unknown-1')]);
    expect(categorized.defer_to_phase_2).toEqual([]);
    expect(categorized.lookupDeletes).toEqual([]);
  });

  it('classifies all scores as unknown when no entities are found', () => {
    const scoredPage: ScoredEntityPage = {
      entityIds: ['user:unknown-1'],
      scores: [score('user:unknown-1')],
      entities: new Map<string, Entity>(),
    };

    const categorized = categorizePhase1Entities(scoredPage);

    expect(categorized.write_now).toEqual([]);
    expect(categorized.not_in_store).toEqual([score('user:unknown-1')]);
  });
});
