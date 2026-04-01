/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup, ElasticsearchClient, Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { RegisterEntityMaintainerConfig } from '@kbn/entity-store/server';
import { v4 as uuidv4 } from 'uuid';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import type {
  EntityAnalyticsConfig,
  EntityAnalyticsRoutesDeps,
  RiskEngineConfiguration,
} from '../../types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import type { EntityType } from '../../../../../common/entity_analytics/types';
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
import {
  buildScopedInternalSavedObjectsClientUnsafe,
  buildInternalSavedObjectsClientUnsafe,
} from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { resetToZero } from './reset_to_zero';
import { buildAlertFilters } from './build_alert_filters';
import { scoreBaseEntities } from './score_base_entities';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import type { MaintainerErrorKind, MaintainerRunContext } from './telemetry_reporter';
import { createRiskScoreMaintainerTelemetryReporter } from './telemetry_reporter';
import { fetchWatchlistConfigs } from './utils/fetch_watchlist_configs';
import { withLogContext } from './utils/with_log_context';
import { ensureLookupIndex } from './lookup/lookup_index';
import { scoreResolutionEntities } from './score_resolution_entities';
import { pruneLookupIndex } from './lookup/prune_lookup_index';

export interface RiskScoreMaintainerDeps {
  getStartServices: EntityAnalyticsRoutesDeps['getStartServices'];
  entityAnalyticsConfig: EntityAnalyticsConfig;
  kibanaVersion: string;
  logger: Logger;
  auditLogger: AuditLogger | undefined;
  productFeaturesService: ProductFeaturesService;
  telemetry: AnalyticsServiceSetup;
}

type RiskScoreMaintainerConfig = Pick<RegisterEntityMaintainerConfig, 'setup' | 'run'>;
const toRunTag = (calculationRunId: string) => calculationRunId.slice(0, 8);
const PIPELINE_VERSION = 'v2_phase2_resolution';

export const createRiskScoreMaintainer = ({
  getStartServices,
  entityAnalyticsConfig,
  kibanaVersion,
  logger,
  auditLogger,
  productFeaturesService,
  telemetry,
}: RiskScoreMaintainerDeps): RiskScoreMaintainerConfig => {
  const telemetryReporter = createRiskScoreMaintainerTelemetryReporter({
    telemetry,
    pipelineVersion: PIPELINE_VERSION,
  });

  const ensureRiskScoreResources = async ({
    namespace,
    esClient,
    riskScoreDataClient,
    soClient,
  }: {
    namespace: string;
    esClient: ElasticsearchClient;
    riskScoreDataClient: RiskScoreDataClient;
    soClient: ReturnType<typeof buildScopedInternalSavedObjectsClientUnsafe>;
  }) => {
    logger.debug(`Ensuring risk score resources exist for namespace "${namespace}"`);
    await initSavedObjects({ savedObjectsClient: soClient, namespace });
    await riskScoreDataClient.init();
    await ensureLookupIndex({ esClient, namespace });
  };

  const runResolutionScoring = async ({
    esClient,
    crudClient,
    logger: runLogger,
    entityType,
    alertsIndex,
    lookupIndex,
    pageSize,
    sampleSize,
    now,
    calculationRunId,
    watchlistConfigs,
    idBasedRiskScoringEnabled,
    writer,
  }: {
    esClient: ElasticsearchClient;
    crudClient: Parameters<RiskScoreMaintainerConfig['run']>[0]['crudClient'];
    logger: Logger;
    entityType: EntityType;
    alertsIndex: string;
    lookupIndex: string;
    pageSize: number;
    sampleSize: number;
    now: string;
    calculationRunId: string;
    watchlistConfigs: Map<string, WatchlistObject>;
    idBasedRiskScoringEnabled: boolean;
    writer: Awaited<ReturnType<RiskScoreDataClient['getWriter']>>;
  }): Promise<number> => {
    const resolutionSummary = await scoreResolutionEntities({
      esClient,
      crudClient,
      logger: runLogger,
      entityType,
      alertsIndex,
      lookupIndex,
      pageSize,
      sampleSize,
      now,
      calculationRunId,
      watchlistConfigs,
    });

    if (resolutionSummary.scores.length === 0) {
      runLogger.debug(
        `phase 2 (resolution) skipped for ${entityType}: lookup_empty or no matching alerts`
      );
      return 0;
    }

    const bulkResponse = await writer.bulk({ [entityType]: resolutionSummary.scores });
    const scoresWrittenResolution = bulkResponse.docs_written;
    runLogger.debug(
      `resolution scoring wrote ${scoresWrittenResolution} score documents across ${resolutionSummary.pagesProcessed} page(s)`
    );

    if (idBasedRiskScoringEnabled) {
      const entityStoreErrors = await persistRiskScoresToEntityStore({
        crudClient,
        logger: runLogger,
        scores: { [entityType]: resolutionSummary.scores },
      });
      if (entityStoreErrors.length > 0) {
        runLogger.warn(
          `Entity store resolution write had ${
            entityStoreErrors.length
          } error(s): ${entityStoreErrors.join('; ')}`
        );
      }
    }

    return scoresWrittenResolution;
  };

  return {
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

      await ensureRiskScoreResources({ namespace, esClient, riskScoreDataClient, soClient });
      logger.info(`Risk score maintainer setup completed for namespace "${namespace}"`);
      return status.state;
    },
    run: async ({ status, crudClient }) => {
      // Two-Phased Risk Scoring pipeline:
      // - Phase 1: base scoring + lookup table synchronization.
      // - Phase 2: propagation + resolution scoring using the Phase 1 lookup table.
      // - Post-phase cleanup: reset stale positive scores to zero.
      const [coreStart, pluginsStart] = await getStartServices();
      const namespace = status.metadata.namespace;
      const esClient = coreStart.elasticsearch.client.asInternalUser;
      const soClient = buildScopedInternalSavedObjectsClientUnsafe({ coreStart, namespace });
      const internalSoClient = buildInternalSavedObjectsClientUnsafe({ coreStart });
      const riskScoreDataClient = new RiskScoreDataClient({
        logger,
        kibanaVersion,
        esClient,
        namespace,
        soClient,
        auditLogger,
      });

      await ensureRiskScoreResources({ namespace, esClient, riskScoreDataClient, soClient });
      const lookupIndex = await ensureLookupIndex({ esClient, namespace });

      const license = await pluginsStart.licensing.getLicense();

      // Keep both checks so gating works in ESS (license) and Serverless (feature flag).
      const isFeatureEnabled = productFeaturesService.isEnabled(ProductFeatureKey.advancedInsights);
      const hasPlatinumLicense = license.hasAtLeast('platinum');

      if (!isFeatureEnabled || !hasPlatinumLicense) {
        const skipReason = !isFeatureEnabled ? 'feature_disabled' : 'license_insufficient';
        telemetryReporter.reportGlobalSkipIfChanged({
          namespace,
          skipReason,
          idBasedRiskScoringEnabled: false,
          calculationRunId: uuidv4(),
        });
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
      const watchlistConfigs = await fetchWatchlistConfigs({
        soClient: internalSoClient,
        esClient,
        namespace,
        logger,
      });

      const writer = await riskScoreDataClient.getWriter({ namespace });
      const sampleSize =
        configuration.alertSampleSizePerShard ??
        entityAnalyticsConfig?.riskEngine?.alertSampleSizePerShard ??
        10000;
      const pageSize = configuration.pageSize ?? DEFAULT_RISK_SCORE_PAGE_SIZE;
      const entityTypes = configuration.identifierType
        ? [configuration.identifierType]
        : getEntityAnalyticsEntityTypes();

      telemetryReporter.clearGlobalSkipReason();

      for (const entityType of entityTypes) {
        const calculationRunId = uuidv4();
        const runNow = new Date().toISOString();
        const runTag = toRunTag(calculationRunId);
        const runLogger = withLogContext(
          logger,
          `[risk_score_maintainer][${entityType}][run:${runTag}]`
        );
        let runStatus: 'success' | 'error' = 'success';
        let runErrorKind: MaintainerErrorKind | undefined;
        let runErrorMessage: string | undefined;
        let scoresWrittenBase = 0;
        let scoresWrittenResolution = 0;
        let scoresWrittenResetToZero = 0;
        let pagesProcessed = 0;
        let deferToPhase2Count = 0;
        let notInStoreCount = 0;
        const runContext: MaintainerRunContext = {
          namespace,
          entityType,
          calculationRunId,
          idBasedRiskScoringEnabled,
        };
        const runTelemetry = telemetryReporter.forRun(runContext);
        runLogger.debug('starting base scoring/reset pass');

        // Phase 1 (base scoring):
        // - "base entity" means an entity scored directly from its own alert inputs in this run
        //   (before any propagation/resolution adjustments)
        // - reads alert inputs for this entity type
        // - applies modifiers from Entity Store/watchlists
        // - categorizes scores into write decisions
        // - persists with temporary behavior for Phase 2 candidates
        //
        // Phase 1 lookup table synchronization is intentionally not in this branch.
        const alertFilters = buildAlertFilters(configuration, entityType, runLogger);
        const baseStage = runTelemetry.startBaseStage();
        try {
          const baseSummary = await scoreBaseEntities({
            alertFilters,
            alertsIndex,
            crudClient,
            entityType,
            esClient,
            lookupIndex,
            logger: runLogger,
            now: runNow,
            calculationRunId,
            pageSize,
            sampleSize,
            watchlistConfigs,
            idBasedRiskScoringEnabled,
            writer,
          });
          runLogger.debug('completed base scoring pass');
          scoresWrittenBase = baseSummary.scoresWritten;
          pagesProcessed = baseSummary.pagesProcessed;
          deferToPhase2Count = baseSummary.deferToPhase2Count;
          notInStoreCount = baseSummary.notInStoreCount;

          baseStage.success({
            pagesProcessed: baseSummary.pagesProcessed,
            scoresWritten: baseSummary.scoresWritten,
            deferToPhase2Count: baseSummary.deferToPhase2Count,
            notInStoreCount: baseSummary.notInStoreCount,
          });
        } catch (error) {
          const errorMessage = telemetryReporter.getErrorMessage(error);
          runStatus = 'error';
          runErrorKind = 'unexpected';
          runErrorMessage = errorMessage;
          runLogger.error(`base scoring failed: ${errorMessage}`);
          baseStage.error({
            errorKind: 'unexpected',
            errorMessage,
          });
          runTelemetry.errorSummary({
            errorKind: 'unexpected',
            errorMessage,
          });
          throw error;
        }

        try {
          scoresWrittenResolution = await runResolutionScoring({
            esClient,
            crudClient,
            logger: runLogger,
            entityType,
            alertsIndex,
            lookupIndex,
            pageSize,
            sampleSize,
            now: runNow,
            calculationRunId,
            watchlistConfigs,
            idBasedRiskScoringEnabled,
            writer,
          });
        } catch (error) {
          const errorMessage = telemetryReporter.getErrorMessage(error);
          runStatus = 'error';
          runErrorKind = 'unexpected';
          runErrorMessage = errorMessage;
          runLogger.error(`resolution scoring failed: ${errorMessage}`);
        }

        // Cleanup step: clear stale positive scores for entities not scored in this run.
        if (configuration.enableResetToZero !== false) {
          const resetStage = runTelemetry.startResetStage();
          try {
            const resetResult = await resetToZero({
              esClient,
              dataClient: riskScoreDataClient,
              spaceId: namespace,
              entityType,
              logger: runLogger,
              idBasedRiskScoringEnabled,
              crudClient,
              watchlistConfigs,
              calculationRunId,
              now: runNow,
            });
            scoresWrittenResetToZero = resetResult.scoresWritten;
            if (resetResult.scoresWritten > 0) {
              runLogger.info(`reset ${resetResult.scoresWritten} stale risk scores to zero`);
            } else {
              runLogger.debug('reset_to_zero found no stale scores');
            }
            resetStage.success({
              scoresWritten: resetResult.scoresWritten,
              resetBatchLimitHit: resetResult.resetBatchLimitHit,
            });

            const riskWindowStart = configuration.range?.start ?? 'now-30d';
            const prunedDocs = await pruneLookupIndex({
              esClient,
              index: lookupIndex,
              riskWindowStart,
            });
            if (prunedDocs > 0) {
              runLogger.debug(`pruned ${prunedDocs} stale lookup documents`);
            }
          } catch (error) {
            const errorMessage = telemetryReporter.getErrorMessage(error);
            runStatus = 'error';
            runErrorKind = 'unexpected';
            runErrorMessage = errorMessage;
            resetStage.error({
              errorKind: 'unexpected',
              errorMessage,
            });
            runLogger.error(`error resetting risk scores to zero: ${error}`);
          }
        } else {
          runLogger.debug('reset_to_zero disabled in configuration');
          runTelemetry.startResetStage().skipped();
        }

        runTelemetry.completionSummary({
          runStatus,
          runErrorKind,
          runErrorMessage,
          scoresWrittenBase,
          scoresWrittenResetToZero,
          pagesProcessed,
          deferToPhase2Count,
          notInStoreCount,
        });
      }

      logger.info(`Risk score maintainer run completed for namespace "${namespace}"`);
      return status.state;
    },
  };
};

export type RegisterRiskScoreMaintainerDeps = RiskScoreMaintainerDeps;
