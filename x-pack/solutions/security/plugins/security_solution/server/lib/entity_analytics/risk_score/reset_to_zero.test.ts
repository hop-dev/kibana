/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import { assetCriticalityServiceMock } from '../asset_criticality/asset_criticality_service.mock';
import { riskScoreDataClientMock } from './risk_score_data_client.mock';
import type { RiskScoreDataClient } from './risk_score_data_client';
import { resetToZero } from './reset_to_zero';
import { EntityType } from '../../../../common/entity_analytics/types';
import { persistRiskScoresToEntityStore } from './persist_risk_scores_to_entity_store';

jest.mock('./persist_risk_scores_to_entity_store');

describe('resetToZero', () => {
  let esClient: ElasticsearchClient;
  let logger: Logger;
  let dataClient: RiskScoreDataClient;
  let writerBulkMock: jest.Mock;
  let mockEntityStoreCRUDClient: EntityStoreCRUDClient;

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
    logger = loggingSystemMock.createLogger();
    dataClient = riskScoreDataClientMock.create();
    writerBulkMock = jest.fn().mockResolvedValue({ errors: [], docs_written: 1 });
    (dataClient.getWriter as jest.Mock).mockResolvedValue({ bulk: writerBulkMock });
    (persistRiskScoresToEntityStore as jest.Mock).mockResolvedValue([]);
    mockEntityStoreCRUDClient = {
      upsertEntitiesBulk: jest.fn().mockResolvedValue([]),
    } as unknown as EntityStoreCRUDClient;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses legacy id field and does not write to entity store when V2 is disabled', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host-a']],
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      assetCriticalityService: assetCriticalityServiceMock.create(),
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: false,
      refresh: 'wait_for',
    });

    expect(result).toEqual({ scoresWritten: 1 });

    const esqlQuery = (esClient.esql.query as jest.Mock).mock.calls[0][0].query;
    expect(esqlQuery).toContain('host.risk.id_value');

    expect(writerBulkMock).toHaveBeenCalledWith({
      host: [
        expect.objectContaining({
          id_field: 'host.name',
          id_value: 'host-a',
          calculated_score: 0,
          calculated_score_norm: 0,
        }),
      ],
      refresh: 'wait_for',
    });
    expect(persistRiskScoresToEntityStore).not.toHaveBeenCalled();
  });

  it('uses entity.id and writes zero scores to entity store when V2 is enabled', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['host:abc123', { 'host.name': 'abc123' }]],
    });

    await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      assetCriticalityService: assetCriticalityServiceMock.create(),
      logger,
      excludedEntities: ['host:do-not-reset'],
      idBasedRiskScoringEnabled: true,
      entityStoreCRUDClient: mockEntityStoreCRUDClient,
      refresh: 'wait_for',
    });

    const esqlQuery = (esClient.esql.query as jest.Mock).mock.calls[0][0].query;
    expect(esqlQuery).toContain('host.risk.id_value');
    expect(esqlQuery).toContain('NOT IN ("host:do-not-reset")');
    expect(esqlQuery).toContain('host.risk.euid_fields IS NOT NULL');

    expect(writerBulkMock).toHaveBeenCalledWith({
      host: [
        expect.objectContaining({
          id_field: 'entity.id',
          id_value: 'host:abc123',
          calculated_score: 0,
          calculated_score_norm: 0,
          euid_fields: { 'host.name': 'abc123' },
        }),
      ],
      refresh: 'wait_for',
    });
    expect(persistRiskScoresToEntityStore).toHaveBeenCalledWith({
      entityStoreCRUDClient: mockEntityStoreCRUDClient,
      logger,
      scores: {
        host: [
          expect.objectContaining({
            id_field: 'entity.id',
            id_value: 'host:abc123',
            calculated_score: 0,
            calculated_score_norm: 0,
            euid_fields: { 'host.name': 'abc123' },
          }),
        ],
      },
    });
  });

  it('returns zero scores written when no entities have non-zero scores', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [],
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      assetCriticalityService: assetCriticalityServiceMock.create(),
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: false,
    });

    expect(result).toEqual({ scoresWritten: 0 });
    expect(writerBulkMock).not.toHaveBeenCalled();
  });

  it('ignores invalid id_value rows safely', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [[null], ['']],
    });

    const result = await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.host,
      assetCriticalityService: assetCriticalityServiceMock.create(),
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: false,
    });

    expect(result).toEqual({ scoresWritten: 0 });
    expect(writerBulkMock).not.toHaveBeenCalled();
  });

  it('handles user entity type with V2 enabled', async () => {
    (esClient.esql.query as jest.Mock).mockResolvedValue({
      values: [['user:jane.doe']],
    });

    await resetToZero({
      esClient,
      dataClient,
      spaceId: 'default',
      entityType: EntityType.user,
      assetCriticalityService: assetCriticalityServiceMock.create(),
      logger,
      excludedEntities: [],
      idBasedRiskScoringEnabled: true,
      entityStoreCRUDClient: mockEntityStoreCRUDClient,
      refresh: 'wait_for',
    });

    const esqlQuery = (esClient.esql.query as jest.Mock).mock.calls[0][0].query;
    expect(esqlQuery).toContain('user.risk.id_value');
    expect(esqlQuery).toContain('user.risk.calculated_score_norm');

    expect(writerBulkMock).toHaveBeenCalledWith({
      user: [
        expect.objectContaining({
          id_field: 'entity.id',
          id_value: 'user:jane.doe',
          calculated_score: 0,
        }),
      ],
      refresh: 'wait_for',
    });
    expect(persistRiskScoresToEntityStore).toHaveBeenCalled();
  });
});
