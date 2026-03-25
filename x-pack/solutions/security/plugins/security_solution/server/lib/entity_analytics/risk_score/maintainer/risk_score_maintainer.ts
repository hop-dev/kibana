/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { RegisterEntityMaintainerConfig } from '@kbn/entity-store/server';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import type { EntityAnalyticsRoutesDeps, RiskEngineConfiguration } from '../../types';
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
import { WatchlistConfigClient } from '../../watchlists/management/watchlist_config';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';

const fetchWatchlistConfigs = async (
  params: ConstructorParameters<typeof WatchlistConfigClient>[0]
): Promise<Map<string, WatchlistObject>> => {
  try {
    const watchlistClient = new WatchlistConfigClient(params);
    const watchlists = await watchlistClient.list();
    return new Map(
      watchlists
        .filter((w): w is WatchlistObject & { id: string } => w.id != null)
        .map((w) => [w.id, w])
    );
  } catch (error) {
    params.logger.warn(
      `Error fetching watchlist configs: ${error}. Scoring will proceed without watchlist modifiers.`
    );
    return new Map();
  }
};

export interface RiskScoreMaintainerDeps {
  getStartServices: EntityAnalyticsRoutesDeps['getStartServices'];
  kibanaVersion: string;
  logger: Logger;
  auditLogger: AuditLogger | undefined;
  productFeaturesService: ProductFeaturesService;
}

type RiskScoreMaintainerConfig = Pick<RegisterEntityMaintainerConfig, 'setup' | 'run'>;

export const createRiskScoreMaintainer = ({
  getStartServices,
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
    const [coreStart, pluginsStart] = await getStartServices();
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

    const configuration: RiskEngineConfiguration =
      (await getConfiguration({ savedObjectsClient: soClient })) ??
      getDefaultRiskEngineConfiguration({ namespace });
    const dataViewId = configuration.dataViewId ?? getAlertsIndex(namespace);
    const { index: alertsIndex } = await riskScoreDataClient.getRiskInputsIndex({ dataViewId });

    const alertFilters = buildAlertFilters(configuration);

    const uiSettingsClient = coreStart.uiSettings.asScopedToClient(soClient);
    const idBasedRiskScoringEnabled = await getIsIdBasedRiskScoringEnabled(uiSettingsClient);

    // Build once per run to avoid repeated SO reads in the scoring loop.
    const watchlistConfigs = await fetchWatchlistConfigs({ soClient, esClient, namespace, logger });

    const writer = await riskScoreDataClient.getWriter({ namespace });
    const now = new Date().toISOString();
    const sampleSize = 10_000;
    const pageSize = DEFAULT_RISK_SCORE_PAGE_SIZE;

    for (const entityType of getEntityAnalyticsEntityTypes()) {
      const scoredEntityIds = await scoreBaseEntities({
        esClient,
        crudClient,
        writer,
        logger,
        entityType,
        alertFilters,
        alertsIndex,
        pageSize,
        sampleSize,
        now,
        watchlistConfigs,
        idBasedRiskScoringEnabled,
      });

      // Phase 2 scoring will run here when propagation/resolution loops are added.

      // Clear stale positive scores for entities that were not scored in this run.
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
