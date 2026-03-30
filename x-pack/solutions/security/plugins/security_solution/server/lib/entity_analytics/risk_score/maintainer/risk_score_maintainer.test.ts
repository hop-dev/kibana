/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import type { AnalyticsServiceSetup } from '@kbn/core/server';
import type { RegisterEntityMaintainerConfig } from '@kbn/entity-store/server';
import { createRiskScoreMaintainer } from './risk_score_maintainer';

type MaintainerRunContext = Parameters<RegisterEntityMaintainerConfig['run']>[0];
import type { EntityAnalyticsConfig } from '../../types';
import type { ProductFeaturesService } from '../../../product_features_service/product_features_service';
import { scoreBaseEntities } from './score_base_entities';
import { resetToZero } from './reset_to_zero';
import { fetchWatchlistConfigs } from './utils/fetch_watchlist_configs';
import { buildAlertFilters } from './build_alert_filters';
import { createRiskScoreMaintainerTelemetryReporter } from './telemetry_reporter';
import {
  getConfiguration,
  initSavedObjects,
} from '../../risk_engine/utils/saved_object_configuration';
import {
  buildScopedInternalSavedObjectsClientUnsafe,
  buildInternalSavedObjectsClientUnsafe,
} from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { RiskScoreDataClient } from '../risk_score_data_client';

jest.mock('./score_base_entities');
jest.mock('./reset_to_zero');
jest.mock('./utils/fetch_watchlist_configs');
jest.mock('./build_alert_filters');
jest.mock('./telemetry_reporter');
jest.mock('../../risk_engine/utils/saved_object_configuration');
jest.mock('../tasks/helpers');
jest.mock('../is_id_based_risk_scoring_enabled');
jest.mock('../risk_score_data_client');
jest.mock('./utils/with_log_context', () => ({
  withLogContext: (_logger: unknown) => _logger,
}));

describe('createRiskScoreMaintainer - run error semantics', () => {
  let logger: ReturnType<typeof loggingSystemMock.createLogger>;
  let mockCompletionSummary: jest.Mock;
  let mockErrorSummary: jest.Mock;
  let getStartServices: jest.Mock;

  const mockStatus = {
    metadata: { namespace: 'default' },
    state: {},
  } as unknown as MaintainerRunContext['status'];
  const mockCrudClient = {} as unknown as MaintainerRunContext['crudClient'];

  const defaultConfiguration = {
    dataViewId: null,
    enabled: false,
    filter: {},
    identifierType: undefined,
    interval: '1h',
    pageSize: 3_500,
    range: { start: 'now-30d', end: 'now' },
    enableResetToZero: true,
    excludeAlertStatuses: ['closed'],
    _meta: { mappingsVersion: 7 },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    logger = loggingSystemMock.createLogger();
    mockCompletionSummary = jest.fn();
    mockErrorSummary = jest.fn();

    (createRiskScoreMaintainerTelemetryReporter as jest.Mock).mockReturnValue({
      forRun: jest.fn().mockReturnValue({
        startBaseStage: jest.fn().mockReturnValue({ success: jest.fn(), error: jest.fn() }),
        startResetStage: jest.fn().mockReturnValue({
          success: jest.fn(),
          error: jest.fn(),
          skipped: jest.fn(),
        }),
        errorSummary: mockErrorSummary,
        completionSummary: mockCompletionSummary,
      }),
      clearGlobalSkipReason: jest.fn(),
      reportGlobalSkipIfChanged: jest.fn(),
      getErrorMessage: jest.fn().mockReturnValue('mock error message'),
    });

    const mockDataClient = {
      init: jest.fn().mockResolvedValue(undefined),
      getRiskInputsIndex: jest.fn().mockResolvedValue({ index: '.siem-signals-default' }),
      getWriter: jest.fn().mockResolvedValue({ bulk: jest.fn().mockResolvedValue({ errors: [] }) }),
    };
    (RiskScoreDataClient as jest.Mock).mockImplementation(() => mockDataClient);

    (initSavedObjects as jest.Mock).mockResolvedValue(undefined);
    (getConfiguration as jest.Mock).mockResolvedValue(defaultConfiguration);
    (buildScopedInternalSavedObjectsClientUnsafe as jest.Mock).mockReturnValue({});
    (buildInternalSavedObjectsClientUnsafe as jest.Mock).mockReturnValue({});
    (getIsIdBasedRiskScoringEnabled as jest.Mock).mockResolvedValue(true);
    (fetchWatchlistConfigs as jest.Mock).mockResolvedValue(new Map());
    (buildAlertFilters as jest.Mock).mockReturnValue([]);

    (scoreBaseEntities as jest.Mock).mockResolvedValue({
      scoresWritten: 1,
      pagesProcessed: 1,
      deferToPhase2Count: 0,
      notInStoreCount: 0,
    });
    (resetToZero as jest.Mock).mockResolvedValue({ scoresWritten: 0, resetBatchLimitHit: false });

    const mockLicense = { hasAtLeast: jest.fn().mockReturnValue(true) };
    const mockCoreStart = {
      elasticsearch: { client: { asInternalUser: {} } },
      uiSettings: { asScopedToClient: jest.fn().mockReturnValue({}) },
      savedObjects: { createInternalRepository: jest.fn() },
    };
    const mockPluginsStart = {
      licensing: { getLicense: jest.fn().mockResolvedValue(mockLicense) },
    };
    getStartServices = jest.fn().mockResolvedValue([mockCoreStart, mockPluginsStart]);
  });

  const createMaintainer = () =>
    createRiskScoreMaintainer({
      getStartServices,
      entityAnalyticsConfig: {
        riskEngine: { alertSampleSizePerShard: 10_000 },
      } as unknown as EntityAnalyticsConfig,
      kibanaVersion: '9.0.0',
      logger,
      auditLogger: undefined,
      productFeaturesService: {
        isEnabled: jest.fn().mockReturnValue(true),
      } as unknown as ProductFeaturesService,
      telemetry: {} as unknown as AnalyticsServiceSetup,
    });

  it('rethrows errors from base scoring stage', async () => {
    const baseError = new Error('base scoring failed');
    (scoreBaseEntities as jest.Mock).mockRejectedValue(baseError);

    const maintainer = createMaintainer();
    await expect(
      maintainer.run!({ status: mockStatus, crudClient: mockCrudClient })
    ).rejects.toThrow(baseError);

    expect(mockErrorSummary).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: 'unexpected' })
    );
  });

  it('logs and continues when reset-to-zero stage fails', async () => {
    const resetError = new Error('reset to zero failed');
    (resetToZero as jest.Mock).mockRejectedValue(resetError);

    const maintainer = createMaintainer();
    await expect(
      maintainer.run!({ status: mockStatus, crudClient: mockCrudClient })
    ).resolves.not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('error resetting risk scores to zero')
    );
    expect(mockCompletionSummary).toHaveBeenCalledWith(
      expect.objectContaining({ runStatus: 'error' })
    );
  });
});
