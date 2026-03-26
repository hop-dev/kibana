/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Tests for the V2 maintainer resetToZero (see ./reset_to_zero.ts for why this
// is a separate copy from ../reset_to_zero.ts).

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { Entity } from '@kbn/entity-store/common';
import { riskScoreDataClientMock } from '../risk_score_data_client.mock';
import type { RiskScoreDataClient } from '../risk_score_data_client';
import { resetToZero } from './reset_to_zero';
import { EntityType } from '../../../../../common/entity_analytics/types';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';

jest.mock('../persist_risk_scores_to_entity_store');

describe('resetToZero (maintainer)', () => {
  let esClient: ElasticsearchClient;
  let logger: Logger;
  let dataClient: RiskScoreDataClient;
  let writerBulkMock: jest.Mock;
  let crudClient: jest.Mocked<EntityStoreCRUDClient>;
  const emptyWatchlistConfigs = new Map<string, WatchlistObject>();

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
    logger = loggingSystemMock.createLogger();
    dataClient = riskScoreDataClientMock.create();
    writerBulkMock = jest.fn().mockResolvedValue({ errors: [], docs_written: 1 });
    (dataClient.getWriter as jest.Mock).mockResolvedValue({ bulk: writerBulkMock });
    (persistRiskScoresToEntityStore as jest.Mock).mockResolvedValue([]);
    crudClient = {
      createEntity: jest.fn(),
      updateEntity: jest.fn(),
      bulkUpdateEntity: jest.fn().mockResolvedValue([]),
      deleteEntity: jest.fn(),
      listEntities: jest.fn().mockResolvedValue({ entities: [], nextSearchAfter: undefined }),
    } as unknown as jest.Mocked<EntityStoreCRUDClient>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('writes zero scores with entity.id identifier field', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:host-1', null]],
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(result).toEqual({ scoresWritten: 1 });
    expect(writerBulkMock).toHaveBeenCalledWith({
      host: [
        expect.objectContaining({
          id_field: 'entity.id',
          id_value: 'host:host-1',
          calculation_run_id: 'run-id-1',
          calculated_score: 0,
          calculated_score_norm: 0,
        }),
      ],
    });
  });

  it('fetches entities from entity store for modifier application', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:host-1', null]],
    });
    (crudClient.listEntities as jest.Mock).mockResolvedValue({
      entities: [
        { entity: { id: 'host:host-1' }, asset: { criticality: 'high_impact' } } as Entity,
      ],
      nextSearchAfter: undefined,
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(crudClient.listEntities).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { terms: { 'entity.id': ['host:host-1'] } },
      })
    );
    expect(result).toEqual({ scoresWritten: 1 });

    // Zero base score means modifier doesn't change the numeric score (bayesianUpdate(0, ?) = 0),
    // but the modifier metadata should appear in the score document.
    expect(writerBulkMock).toHaveBeenCalledWith({
      host: [
        expect.objectContaining({
          id_value: 'host:host-1',
          calculated_score: 0,
          calculated_score_norm: 0,
          criticality_level: 'high_impact',
          criticality_modifier: expect.any(Number),
        }),
      ],
    });
  });

  it('applies watchlist modifiers from entity store documents', async () => {
    const watchlistId = 'watchlist-1';
    const watchlistConfigs = new Map<string, WatchlistObject>([
      [
        watchlistId,
        {
          id: watchlistId,
          name: 'test-watchlist',
          riskModifier: 2.0,
          description: 'Test',
        } as WatchlistObject,
      ],
    ]);

    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['user:user-1', null]],
    });
    (crudClient.listEntities as jest.Mock).mockResolvedValue({
      entities: [
        {
          entity: {
            id: 'user:user-1',
            attributes: { watchlists: [watchlistId] },
          },
        } as Entity,
      ],
      nextSearchAfter: undefined,
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.user,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs,
    });

    expect(result).toEqual({ scoresWritten: 1 });
    expect(writerBulkMock).toHaveBeenCalledWith({
      user: [
        expect.objectContaining({
          id_value: 'user:user-1',
          calculated_score: 0,
          calculated_score_norm: 0,
        }),
      ],
    });
  });

  it('proceeds with empty entity map when entity fetch fails', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:host-1', null]],
    });
    (crudClient.listEntities as jest.Mock).mockRejectedValue(new Error('Entity store error'));

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(result).toEqual({ scoresWritten: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Error fetching entities for reset-to-zero')
    );
    expect(writerBulkMock).toHaveBeenCalledWith({
      host: [
        expect.objectContaining({
          id_value: 'host:host-1',
          calculated_score: 0,
          calculated_score_norm: 0,
        }),
      ],
    });
  });

  it('returns zero when no stale entities are found', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [],
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(result).toEqual({ scoresWritten: 0 });
    expect(writerBulkMock).not.toHaveBeenCalled();
  });

  it('passes exclusion filter for scored entity IDs', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:host-2', null]],
    });

    await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: ['host:host-1'],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(esClient.esql.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          bool: { must_not: [{ terms: { 'entity.id': ['host:host-1'] } }] },
        },
      })
    );
  });

  it('writes to entity store when idBasedRiskScoringEnabled is true', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:host-1', null]],
    });

    await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      crudClient,
      calculationRunId: 'run-id-1',
      watchlistConfigs: emptyWatchlistConfigs,
    });

    expect(persistRiskScoresToEntityStore).toHaveBeenCalledWith({
      crudClient,
      logger,
      scores: {
        host: [
          expect.objectContaining({
            id_value: 'host:host-1',
            calculated_score: 0,
            calculated_score_norm: 0,
          }),
        ],
      },
    });
  });
});
