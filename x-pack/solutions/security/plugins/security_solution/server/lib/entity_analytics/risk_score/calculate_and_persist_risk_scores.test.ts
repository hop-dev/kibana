/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { elasticsearchServiceMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { assetCriticalityServiceMock } from '../asset_criticality/asset_criticality_service.mock';
import { privmonUserCrudServiceMock } from '../privilege_monitoring/users/privileged_users_crud.mock';

import { calculateAndPersistRiskScores } from './calculate_and_persist_risk_scores';
import { calculateScoresWithESQL } from './calculate_esql_risk_scores';
import { calculateScoresWithESQLMock } from './calculate_esql_risk_scores.mock';
import { riskScoreDataClientMock } from './risk_score_data_client.mock';
import type { RiskScoreDataClient } from './risk_score_data_client';
import type { ExperimentalFeatures } from '../../../../common';
import { EntityType } from '../../../../common/search_strategy';
import { EntityRiskLevelsEnum } from '../../../../common/api/entity_analytics/common';

jest.mock('./calculate_esql_risk_scores');

const mockUpsertEntitiesBulk = jest.fn().mockResolvedValue({ errors: [], docs_written: 1 });
jest.mock('../entity_store_v2/temp_entity_store_v2_writer', () => ({
  TempEntityStoreV2Writer: jest.fn().mockImplementation(() => ({
    upsertEntitiesBulk: mockUpsertEntitiesBulk,
  })),
}));

const { TempEntityStoreV2Writer: MockTempEntityStoreV2Writer } = jest.requireMock(
  '../entity_store_v2/temp_entity_store_v2_writer'
);

const calculateAndPersistRecentHostRiskScores = (
  esClient: ElasticsearchClient,
  logger: Logger,
  riskScoreDataClient: RiskScoreDataClient,
  useEntityStoreV2 = false
) => {
  return calculateAndPersistRiskScores({
    afterKeys: {},
    identifierType: EntityType.host,
    esClient,
    logger,
    index: 'index',
    pageSize: 500,
    spaceId: 'default',
    range: { start: 'now - 15d', end: 'now' },
    riskScoreDataClient,
    assetCriticalityService: assetCriticalityServiceMock.create(),
    privmonUserCrudService: privmonUserCrudServiceMock.create(),
    runtimeMappings: {},
    experimentalFeatures: {} as ExperimentalFeatures,
    useEntityStoreV2,
  });
};

describe('calculateAndPersistRiskScores', () => {
  let esClient: ElasticsearchClient;
  let logger: Logger;
  let riskScoreDataClient: RiskScoreDataClient;

  const calculate = (useEntityStoreV2 = false) =>
    calculateAndPersistRecentHostRiskScores(
      esClient,
      logger,
      riskScoreDataClient,
      useEntityStoreV2
    );

  beforeEach(() => {
    esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
    logger = loggingSystemMock.createLogger();
    riskScoreDataClient = riskScoreDataClientMock.create();
    mockUpsertEntitiesBulk.mockClear();
    (MockTempEntityStoreV2Writer as jest.Mock).mockClear();
  });

  describe('with no risk scores to persist', () => {
    beforeEach(() => {
      (calculateScoresWithESQL as jest.Mock).mockResolvedValueOnce(
        calculateScoresWithESQLMock.buildResponse({ scores: { host: [] } })
      );
    });

    it('does not upgrade configurations', async () => {
      await calculate();

      expect(riskScoreDataClient.upgradeIfNeeded).not.toHaveBeenCalled();
    });

    it('returns an appropriate response', async () => {
      const results = await calculate();

      const entities = {
        host: [],
        user: [],
        service: [],
        generic: [],
      };
      expect(results).toEqual({ after_keys: {}, errors: [], scores_written: 0, entities });
    });
  });

  describe('with risk scores to persist', () => {
    beforeEach(() => {
      (calculateScoresWithESQL as jest.Mock).mockResolvedValueOnce(
        calculateScoresWithESQLMock.buildResponseWithOneScore()
      );
    });

    it('upgrades configurations when persisting risk scores', async () => {
      await calculate();

      expect(riskScoreDataClient.upgradeIfNeeded).toHaveBeenCalled();
    });

    it('does not call TempEntityStoreV2Writer when useEntityStoreV2 is false', async () => {
      await calculate(false);

      expect(MockTempEntityStoreV2Writer).not.toHaveBeenCalled();
      expect(mockUpsertEntitiesBulk).not.toHaveBeenCalled();
    });
  });

  describe('when useEntityStoreV2 is true', () => {
    it('does not call TempEntityStoreV2Writer when there are no scores to persist', async () => {
      (calculateScoresWithESQL as jest.Mock).mockResolvedValueOnce(
        calculateScoresWithESQLMock.buildResponse({ scores: { host: [] } })
      );

      await calculate(true);

      expect(MockTempEntityStoreV2Writer).not.toHaveBeenCalled();
      expect(mockUpsertEntitiesBulk).not.toHaveBeenCalled();
    });

    it('calls TempEntityStoreV2Writer.upsertEntitiesBulk with BulkObjects derived from scores', async () => {
      const hostScore = {
        '@timestamp': '2024-01-15T12:00:00Z',
        id_field: 'host.entity.id',
        id_value: 'host:abc123',
        calculated_level: EntityRiskLevelsEnum.High,
        calculated_score: 75,
        calculated_score_norm: 42,
        category_1_score: 50,
        category_1_count: 5,
        notes: [],
        inputs: [],
      };
      (calculateScoresWithESQL as jest.Mock).mockResolvedValueOnce(
        calculateScoresWithESQLMock.buildResponse({
          scores: { host: [hostScore], user: [], service: [], generic: [] },
        })
      );

      await calculate(true);

      expect(MockTempEntityStoreV2Writer).toHaveBeenCalledWith(esClient, 'default');
      expect(mockUpsertEntitiesBulk).toHaveBeenCalledTimes(1);
      const [bulkObjects, options] = mockUpsertEntitiesBulk.mock.calls[0];
      expect(bulkObjects).toHaveLength(1);
      expect(bulkObjects[0]).toEqual({
        type: EntityType.host,
        document: {
          '@timestamp': hostScore['@timestamp'],
          entity: {
            id: hostScore.id_value,
            risk: {
              calculated_score: hostScore.calculated_score,
              calculated_score_norm: hostScore.calculated_score_norm,
              calculated_level: hostScore.calculated_level,
            },
          },
        },
      });
      expect(options).toEqual({ refresh: undefined });
    });
  });
});
