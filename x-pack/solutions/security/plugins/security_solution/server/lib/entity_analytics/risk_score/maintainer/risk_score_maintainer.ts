/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { RegisterEntityMaintainerConfig } from '@kbn/entity-store/server';
import { v4 as uuidv4 } from 'uuid';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import type {
  EntityAnalyticsConfig,
  EntityAnalyticsRoutesDeps,
  RiskEngineConfiguration,
} from '../../types';
import { DEFAULT_RISK_SCORE_PAGE_SIZE } from '../../../../../common/constants';
import {
  getEntityAnalyticsEntityTypes,
  getAlertsIndex,
} from '../../../../../common/entity_analytics/utils';
import type { ProductFeaturesService } from '../../../product_features_service/product_features_service';
import { RiskScoreDataClient } from '../risk_score_data_client';
import {
  initSavedObjects,
  getConfiguration,
  getDefaultRiskEngineConfiguration,
} from '../../risk_engine/utils/saved_object_configuration';
import { buildScopedInternalSavedObjectsClientUnsafe } from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { resetToZero } from './reset_to_zero';
import { buildAlertFilters } from './build_alert_filters';
import { scoreBaseEntities } from './score_base_entities';
import { fetchWatchlistConfigs } from './utils/fetch_watchlist_configs';

export interface RiskScoreMaintainerDeps {
  getStartServices: EntityAnalyticsRoutesDeps['getStartServices'];
  entityAnalyticsConfig: EntityAnalyticsConfig;
  kibanaVersion: string;
  logger: Logger;
  auditLogger: AuditLogger | undefined;
  productFeaturesService: ProductFeaturesService;
}

type RiskScoreMaintainerConfig = Pick<RegisterEntityMaintainerConfig, 'setup' | 'run'>;

export const createRiskScoreMaintainer = ({
  getStartServices,
  entityAnalyticsConfig,
  kibanaVersion,
  logger,
  auditLogger,
  productFeaturesService,
}: RiskScoreMaintainerDeps): RiskScoreMaintainerConfig => ({
  setup: async ({ status }) => {
    const namespace = status.metadata.namespace;
    const [coreStart] = await getStartServices();
    const esClient = coreStart.elasticsearch.client.asInternalUser;
    const soClient = buildScopedInternalSavedObjectsClientUnsafe({ coreStart, namespace });

    const riskScoreDataClient = new RiskScoreDataClient({
      logger,
      kibanaVersion,
      esClient,
      namespace,
      soClient,
      auditLogger,
    });

    logger.debug(`Initializing risk score maintainer saved objects for namespace "${namespace}"`);
    await initSavedObjects({ savedObjectsClient: soClient, namespace });
    logger.debug(`Initializing risk score maintainer data client for namespace "${namespace}"`);
    await riskScoreDataClient.init();

    logger.info(`Risk score maintainer setup completed for namespace "${namespace}"`);
    return status.state;
  },
  run: async ({ status, crudClient }) => {
    // Two-Phased Risk Scoring pipeline:
    // - Phase 1 (Base Entity Scoring): score entities from their own alerts.
    // - Phase 2 (Cross-Entity Aggregation/Resolution): aggregate deferred scores
    //   across related entities (placeholder until implemented).
    // - Post-phase cleanup: reset stale positive scores to zero.
    const [coreStart, pluginsStart] = await getStartServices();
    const namespace = status.metadata.namespace;
    const esClient = coreStart.elasticsearch.client.asInternalUser;
    const soClient = buildScopedInternalSavedObjectsClientUnsafe({ coreStart, namespace });
    const riskScoreDataClient = new RiskScoreDataClient({
      logger,
      kibanaVersion,
      esClient,
      namespace,
      soClient,
      auditLogger,
    });

    const license = await pluginsStart.licensing.getLicense();

    // Keep both checks so gating works in ESS (license) and Serverless (feature flag).
    const isFeatureEnabled = productFeaturesService.isEnabled(ProductFeatureKey.advancedInsights);
    const hasPlatinumLicense = license.hasAtLeast('platinum');

    if (!isFeatureEnabled || !hasPlatinumLicense) {
      logger.debug(
        'Risk score maintainer run skipped due to insufficient license or feature disabled'
      );
      return status.state;
    }

    const configuration: RiskEngineConfiguration =
      (await getConfiguration({ savedObjectsClient: soClient })) ??
      getDefaultRiskEngineConfiguration({ namespace });
    const dataViewId = configuration.dataViewId ?? getAlertsIndex(namespace);
    const { index: alertsIndex } = await riskScoreDataClient.getRiskInputsIndex({ dataViewId });

    const uiSettingsClient = coreStart.uiSettings.asScopedToClient(soClient);
    const idBasedRiskScoringEnabled = await getIsIdBasedRiskScoringEnabled(uiSettingsClient);

    // Build once per run to avoid repeated SO reads in the scoring loop.
    const watchlistConfigs = await fetchWatchlistConfigs({ soClient, esClient, namespace, logger });

    const writer = await riskScoreDataClient.getWriter({ namespace });
    const sampleSize =
      configuration.alertSampleSizePerShard ??
      entityAnalyticsConfig.riskEngine.alertSampleSizePerShard;
    const pageSize = configuration.pageSize ?? DEFAULT_RISK_SCORE_PAGE_SIZE;
    const entityTypes = configuration.identifierType
      ? [configuration.identifierType]
      : getEntityAnalyticsEntityTypes();

    for (const entityType of entityTypes) {
      const calculationRunId = uuidv4();

      // Phase 1 (Base Entity Scoring):
      // - reads alert inputs for this entity type
      // - applies modifiers from Entity Store/watchlists
      // - categorizes scores into write decisions
      // - persists with temporary behavior for Phase 2 candidates
      const alertFilters = buildAlertFilters(configuration, entityType);
      const scoredEntityIds = await scoreBaseEntities({
        alertFilters,
        alertsIndex,
        crudClient,
        entityType,
        esClient,
        idBasedRiskScoringEnabled,
        logger,
        now: new Date().toISOString(),
        calculationRunId,
        pageSize,
        sampleSize,
        watchlistConfigs,
        writer,
      });

      // Phase 2 (Cross-Entity Aggregation/Resolution) will run here.
      // This is where deferred scores will stop writing "as-is" and instead be
      // aggregated/resolved before persistence.

      // Cleanup step: clear stale positive scores for entities not scored in this run.
      if (configuration.enableResetToZero !== false) {
        try {
          const resetResult = await resetToZero({
            esClient,
            dataClient: riskScoreDataClient,
            spaceId: namespace,
            entityType,
            logger,
            excludedEntities: scoredEntityIds,
            idBasedRiskScoringEnabled,
            crudClient,
            watchlistConfigs,
            calculationRunId,
          });
          if (resetResult.scoresWritten > 0) {
            logger.info(
              `Reset ${resetResult.scoresWritten} stale ${entityType} risk scores to zero`
            );
          }
        } catch (error) {
          logger.warn(`Error resetting ${entityType} risk scores to zero: ${error}`);
        }
      }
    }

    logger.info(`Risk score maintainer run completed for namespace "${namespace}"`);
    return status.state;
  },
});

export type RegisterRiskScoreMaintainerDeps = RiskScoreMaintainerDeps;
