/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup, Logger } from '@kbn/core/server';
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
import {
  buildScopedInternalSavedObjectsClientUnsafe,
  buildInternalSavedObjectsClientUnsafe,
} from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { resetToZero } from './reset_to_zero';
import { buildAlertFilters } from './build_alert_filters';
import { scoreBaseEntities } from './score_base_entities';
import type { MaintainerErrorKind, MaintainerRunContext } from './telemetry_reporter';
import { createRiskScoreMaintainerTelemetryReporter } from './telemetry_reporter';
import { fetchWatchlistConfigs } from './utils/fetch_watchlist_configs';
import { withLogContext } from './utils/with_log_context';
import { ensureLookupIndex } from './lookup/lookup_index';
import { pruneLookupIndex } from './lookup/prune_lookup_index';
import { runResolutionScoringStep } from './run_resolution_scoring_step';
import { createRunMetricsTracker } from './utils/run_metrics_tracker';

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
  });

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

      logger.debug(`Ensuring risk score resources exist for namespace "${namespace}"`);
      await initSavedObjects({ savedObjectsClient: soClient, namespace });
      await riskScoreDataClient.init();
      await ensureLookupIndex({ esClient, namespace });
      logger.info(`Risk score maintainer setup completed for namespace "${namespace}"`);
      return status.state;
    },
    // eslint-disable-next-line complexity -- keep pipeline orchestration inline in this entrypoint
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

      logger.debug(`Ensuring risk score resources exist for namespace "${namespace}"`);
      await initSavedObjects({ savedObjectsClient: soClient, namespace });
      await riskScoreDataClient.init();
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
      const maintainerRunStartedAtMs = Date.now();
      const metricsTracker = createRunMetricsTracker();

      telemetryReporter.clearGlobalSkipReason();

      for (const entityType of entityTypes) {
        const entityRunStartedAtMs = Date.now();
        const calculationRunId = uuidv4();
        const runNow = new Date().toISOString();
        const runTag = toRunTag(calculationRunId);
        const runLogger = withLogContext(
          logger,
          `[risk_score_maintainer][${entityType}][run:${runTag}]`
        );
        let runStatus: 'success' | 'error' = 'success';
        let runErrorKind: MaintainerErrorKind | undefined;
        const runMetrics = metricsTracker.newRun();
        const runContext: MaintainerRunContext = {
          namespace,
          entityType,
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
        // Phase 1 lookup synchronization runs inline with base scoring categorization.
        const alertFilters = buildAlertFilters(configuration, entityType, runLogger);
        const baseStage = runTelemetry.startBaseStage();
        const lookupStage = runTelemetry.startLookupSyncStage();
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
          metricsTracker.recordBase(runMetrics, baseSummary);

          baseStage.success({
            pagesProcessed: baseSummary.pagesProcessed,
            scoresWritten: baseSummary.scoresWritten,
            deferToPhase2Count: baseSummary.deferToPhase2Count,
            notInStoreCount: baseSummary.notInStoreCount,
          });
          lookupStage.success({
            lookupDocsUpserted: baseSummary.lookupDocsUpserted,
            lookupDocsDeleted: baseSummary.lookupDocsDeleted,
          });
        } catch (error) {
          const errorMessage = telemetryReporter.getErrorMessage(error);
          runStatus = 'error';
          runErrorKind = 'unexpected';
          runLogger.error(`base scoring failed: ${errorMessage}`);
          baseStage.error({
            errorKind: 'unexpected',
          });
          lookupStage.error({
            errorKind: 'unexpected',
          });
          runTelemetry.errorSummary({
            errorKind: 'unexpected',
          });
          throw error;
        }

        if (runMetrics.lookupDocsUpserted > 0) {
          await esClient.indices.refresh({ index: lookupIndex });
          runLogger.debug(`refreshed lookup index after ${runMetrics.lookupDocsUpserted} upserts`);
        }

        const resolutionStage = runTelemetry.startResolutionStage();
        try {
          const resolutionResult = await runResolutionScoringStep({
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
          metricsTracker.recordResolution(runMetrics, resolutionResult);
          if (resolutionResult.skippedReason) {
            resolutionStage.skipped(resolutionResult.skippedReason);
          } else {
            resolutionStage.success({
              pagesProcessed: resolutionResult.pagesProcessed,
              scoresWritten: resolutionResult.scoresWritten,
            });
          }
        } catch (error) {
          const errorMessage = telemetryReporter.getErrorMessage(error);
          runStatus = 'error';
          runErrorKind = 'unexpected';
          runLogger.error(`resolution scoring failed: ${errorMessage}`);
          resolutionStage.error({
            errorKind: 'unexpected',
          });
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
            metricsTracker.recordResetToZero(runMetrics, resetResult);
            if (resetResult.scoresWritten > 0) {
              runLogger.info(`reset ${resetResult.scoresWritten} stale risk scores to zero`);
            } else {
              runLogger.debug('reset_to_zero found no stale scores');
            }
            resetStage.success({
              scoresWritten: resetResult.scoresWritten,
              resetBatchLimitHit: resetResult.resetBatchLimitHit,
            });
          } catch (error) {
            const errorMessage = telemetryReporter.getErrorMessage(error);
            runStatus = 'error';
            runErrorKind = 'unexpected';
            resetStage.error({
              errorKind: 'unexpected',
            });
            runLogger.error(`error resetting risk scores to zero: ${errorMessage}`);
          }

          const riskWindowStart = configuration.range?.start ?? 'now-30d';
          try {
            const prunedDocs = await pruneLookupIndex({
              esClient,
              index: lookupIndex,
              riskWindowStart,
            });
            metricsTracker.recordPrune(runMetrics, prunedDocs);
            if (prunedDocs > 0) {
              runLogger.debug(`pruned ${prunedDocs} stale lookup documents`);
            }
          } catch (error) {
            runStatus = 'error';
            runErrorKind = 'unexpected';
            runLogger.error(
              `error pruning lookup index: ${telemetryReporter.getErrorMessage(error)}`
            );
          }
        } else {
          runLogger.debug('reset_to_zero disabled in configuration');
          runTelemetry.startResetStage().skipped();
        }

        runTelemetry.completionSummary({
          runStatus,
          runErrorKind,
          ...runMetrics,
        });
        const entityRunDurationMs = Date.now() - entityRunStartedAtMs;
        const runSummary = metricsTracker.toRunSummary(runMetrics, {
          entityType,
          status: runStatus,
          errorKind: runErrorKind,
          durationMs: entityRunDurationMs,
          idBasedRiskScoringEnabled,
          namespace,
        });
        runLogger.info(`run summary ${JSON.stringify(runSummary)}`);
        metricsTracker.accumulate(runMetrics);
      }

      const maintainerRunDurationMs = Date.now() - maintainerRunStartedAtMs;
      logger.info(
        `Risk score maintainer run completed for namespace "${namespace}" in ${maintainerRunDurationMs}ms`
      );
      const maintainerTotals = metricsTracker.toAggregateSummary({
        namespace,
        durationMs: maintainerRunDurationMs,
        entityTypesProcessed: entityTypes.length,
        idBasedRiskScoringEnabled,
      });
      logger.info(`maintainer totals ${JSON.stringify(maintainerTotals)}`);
      return status.state;
    },
  };
};

export type RegisterRiskScoreMaintainerDeps = RiskScoreMaintainerDeps;
