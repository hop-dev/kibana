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
import { buildScopedInternalSavedObjectsClientUnsafe } from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { resetToZero } from './reset_to_zero';
import { buildAlertFilters } from './build_alert_filters';
import { scoreBaseEntities } from './score_base_entities';
import { fetchWatchlistConfigs } from './utils/fetch_watchlist_configs';
import { withLogContext } from './utils/with_log_context';
import {
  RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT,
  RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT,
} from '../../../telemetry/event_based/events';

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
const PIPELINE_VERSION = 'v2_phase1';
const ERROR_MESSAGE_MAX_LENGTH = 500;

export const createRiskScoreMaintainer = ({
  getStartServices,
  entityAnalyticsConfig,
  kibanaVersion,
  logger,
  auditLogger,
  productFeaturesService,
  telemetry,
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
    // - Phase 1: base scoring + lookup table synchronization.
    // - Phase 2: propagation + resolution scoring using the Phase 1 lookup table.
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
      const calculationRunId = uuidv4();
      const skipReason = !isFeatureEnabled ? 'feature_disabled' : 'license_insufficient';
      telemetry.reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
        namespace,
        entityType: 'all',
        calculationRunId,
        status: 'skipped',
        skipReason,
        durationMs: 0,
        scoresWrittenTotal: 0,
        scoresWrittenBase: 0,
        scoresWrittenResetToZero: 0,
        pagesProcessed: 0,
        deferToPhase2Count: 0,
        notInStoreCount: 0,
        idBasedRiskScoringEnabled: false,
        pipelineVersion: PIPELINE_VERSION,
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
    const watchlistConfigs = await fetchWatchlistConfigs({ soClient, esClient, namespace, logger });

    const writer = await riskScoreDataClient.getWriter({ namespace });
    const sampleSize =
      configuration.alertSampleSizePerShard ??
      entityAnalyticsConfig.riskEngine.alertSampleSizePerShard;
    const pageSize = configuration.pageSize ?? DEFAULT_RISK_SCORE_PAGE_SIZE;
    const entityTypes = configuration.identifierType
      ? [configuration.identifierType]
      : getEntityAnalyticsEntityTypes();

    if (configuration.enabled === false) {
      const calculationRunId = uuidv4();
      telemetry.reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
        namespace,
        entityType: 'all',
        calculationRunId,
        status: 'skipped',
        skipReason: 'risk_engine_disabled',
        durationMs: 0,
        scoresWrittenTotal: 0,
        scoresWrittenBase: 0,
        scoresWrittenResetToZero: 0,
        pagesProcessed: 0,
        deferToPhase2Count: 0,
        notInStoreCount: 0,
        idBasedRiskScoringEnabled,
        pipelineVersion: PIPELINE_VERSION,
      });
      logger.debug('Risk score maintainer run skipped because risk engine is disabled');
      return status.state;
    }

    for (const entityType of entityTypes) {
      const calculationRunId = uuidv4();
      const runTag = toRunTag(calculationRunId);
      const runStart = Date.now();
      const runLogger = withLogContext(
        logger,
        `[risk_score_maintainer][${entityType}][run:${runTag}]`
      );
      let runStatus: 'success' | 'error' = 'success';
      let runErrorKind:
        | 'esql_query_failed'
        | 'bulk_write_failed'
        | 'entity_store_write_failed'
        | 'entity_fetch_failed'
        | 'unexpected'
        | undefined;
      let runErrorMessage: string | undefined;
      let scoresWrittenBase = 0;
      let scoresWrittenResetToZero = 0;
      let pagesProcessed = 0;
      let deferToPhase2Count = 0;
      let notInStoreCount = 0;
      runLogger.debug('starting base scoring/reset pass');

      // Phase 1 (base scoring):
      // - reads alert inputs for this entity type
      // - applies modifiers from Entity Store/watchlists
      // - categorizes scores into write decisions
      // - persists with temporary behavior for Phase 2 candidates
      //
      // Phase 1 lookup table synchronization is intentionally not in this branch.
      const alertFilters = buildAlertFilters(configuration, entityType);
      const baseScoringStart = Date.now();
      try {
        const baseSummary = await scoreBaseEntities({
          alertFilters,
          alertsIndex,
          crudClient,
          entityType,
          esClient,
          idBasedRiskScoringEnabled,
          logger: runLogger,
          now: new Date().toISOString(),
          calculationRunId,
          pageSize,
          sampleSize,
          watchlistConfigs,
          writer,
        });
        runLogger.debug('completed base scoring pass');
        scoresWrittenBase = baseSummary.scoresWritten;
        pagesProcessed = baseSummary.pagesProcessed;
        deferToPhase2Count = baseSummary.deferToPhase2Count;
        notInStoreCount = baseSummary.notInStoreCount;

        telemetry.reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
          namespace,
          entityType,
          calculationRunId,
          stage: 'phase1_base_scoring',
          status: 'success',
          durationMs: Date.now() - baseScoringStart,
          pagesProcessed: baseSummary.pagesProcessed,
          scoresWritten: baseSummary.scoresWritten,
          deferToPhase2Count: baseSummary.deferToPhase2Count,
          notInStoreCount: baseSummary.notInStoreCount,
          idBasedRiskScoringEnabled,
          pipelineVersion: PIPELINE_VERSION,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        runStatus = 'error';
        runErrorKind = getErrorKind(errorMessage);
        runErrorMessage = errorMessage;
        telemetry.reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
          namespace,
          entityType,
          calculationRunId,
          stage: 'phase1_base_scoring',
          status: 'error',
          errorKind: runErrorKind,
          errorMessage,
          durationMs: Date.now() - baseScoringStart,
          idBasedRiskScoringEnabled,
          pipelineVersion: PIPELINE_VERSION,
        });
        telemetry.reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
          namespace,
          entityType,
          calculationRunId,
          status: runStatus,
          errorKind: runErrorKind,
          errorMessage: runErrorMessage,
          durationMs: Date.now() - runStart,
          scoresWrittenTotal: 0,
          scoresWrittenBase: 0,
          scoresWrittenResetToZero: 0,
          pagesProcessed: 0,
          deferToPhase2Count: 0,
          notInStoreCount: 0,
          idBasedRiskScoringEnabled,
          pipelineVersion: PIPELINE_VERSION,
        });
        throw error;
      }

      // TODO(phase-2): run propagation + resolution scoring here, using the
      // Phase 1 lookup table synchronized during base scoring.
      // Until lookup synchronization lands, keep Phase 2 explicitly skipped.
      runLogger.debug(
        `phase 2 (propagation/resolution) skipped: waiting for phase 1 lookup sync; entityType="${entityType}", calculationRunId="${calculationRunId}"`
      );

      // Cleanup step: clear stale positive scores for entities not scored in this run.
      if (configuration.enableResetToZero !== false) {
        const resetStart = Date.now();
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
          });
          scoresWrittenResetToZero = resetResult.scoresWritten;
          if (resetResult.scoresWritten > 0) {
            runLogger.info(`reset ${resetResult.scoresWritten} stale risk scores to zero`);
          } else {
            runLogger.debug('reset_to_zero found no stale scores');
          }
          telemetry.reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
            namespace,
            entityType,
            calculationRunId,
            stage: 'reset_to_zero',
            status: 'success',
            durationMs: Date.now() - resetStart,
            scoresWritten: resetResult.scoresWritten,
            resetBatchLimitHit: resetResult.resetBatchLimitHit,
            idBasedRiskScoringEnabled,
            pipelineVersion: PIPELINE_VERSION,
          });
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          runStatus = 'error';
          runErrorKind = getErrorKind(errorMessage);
          runErrorMessage = errorMessage;
          telemetry.reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
            namespace,
            entityType,
            calculationRunId,
            stage: 'reset_to_zero',
            status: 'error',
            errorKind: runErrorKind,
            errorMessage,
            durationMs: Date.now() - resetStart,
            idBasedRiskScoringEnabled,
            pipelineVersion: PIPELINE_VERSION,
          });
          runLogger.warn(`error resetting risk scores to zero: ${error}`);
        }
      } else {
        runLogger.debug('reset_to_zero disabled in configuration');
        telemetry.reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
          namespace,
          entityType,
          calculationRunId,
          stage: 'reset_to_zero',
          status: 'skipped',
          skipReason: 'reset_to_zero_disabled',
          durationMs: 0,
          idBasedRiskScoringEnabled,
          pipelineVersion: PIPELINE_VERSION,
        });
      }

      telemetry.reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
        namespace,
        entityType,
        calculationRunId,
        status: runStatus,
        errorKind: runErrorKind,
        errorMessage: runErrorMessage,
        durationMs: Date.now() - runStart,
        scoresWrittenTotal: scoresWrittenBase + scoresWrittenResetToZero,
        scoresWrittenBase,
        scoresWrittenResetToZero,
        pagesProcessed,
        deferToPhase2Count,
        notInStoreCount,
        idBasedRiskScoringEnabled,
        pipelineVersion: PIPELINE_VERSION,
      });
    }

    logger.info(`Risk score maintainer run completed for namespace "${namespace}"`);
    return status.state;
  },
});

export type RegisterRiskScoreMaintainerDeps = RiskScoreMaintainerDeps;

const getErrorMessage = (error: unknown): string => {
  const fallback = 'unknown_error';
  if (!error || typeof error !== 'object') {
    return fallback;
  }

  const message = 'message' in error ? String(error.message) : fallback;
  return message.substring(0, ERROR_MESSAGE_MAX_LENGTH);
};

const getErrorKind = (
  errorMessage: string
):
  | 'esql_query_failed'
  | 'bulk_write_failed'
  | 'entity_store_write_failed'
  | 'entity_fetch_failed'
  | 'unexpected' => {
  const normalized = errorMessage.toLowerCase();

  if (normalized.includes('esql')) {
    return 'esql_query_failed';
  }
  if (normalized.includes('bulk')) {
    return 'bulk_write_failed';
  }
  if (normalized.includes('entity store')) {
    return 'entity_store_write_failed';
  }
  if (normalized.includes('fetch entities')) {
    return 'entity_fetch_failed';
  }

  return 'unexpected';
};
