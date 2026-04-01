/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup } from '@kbn/core/server';
import {
  RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT,
  RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT,
} from '../../../telemetry/event_based/events';

const ERROR_MESSAGE_MAX_LENGTH = 500;

type MaintainerStatus = 'success' | 'error' | 'skipped' | 'aborted';
type GlobalSkipReason = 'feature_disabled' | 'license_insufficient';
export type MaintainerErrorKind =
  | 'esql_query_failed'
  | 'bulk_write_failed'
  | 'entity_store_write_failed'
  | 'entity_fetch_failed'
  | 'unexpected';

export interface MaintainerRunContext {
  namespace: string;
  entityType: string;
  calculationRunId: string;
  idBasedRiskScoringEnabled: boolean;
}

interface GlobalSkipInput {
  namespace: string;
  skipReason: GlobalSkipReason;
  idBasedRiskScoringEnabled: boolean;
  calculationRunId: string;
}

export const createRiskScoreMaintainerTelemetryReporter = ({
  telemetry,
  pipelineVersion,
}: {
  telemetry: AnalyticsServiceSetup;
  pipelineVersion: string;
}) => {
  const reportEvent = (eventType: string, properties: Record<string, unknown>) => {
    telemetry?.reportEvent?.(eventType, properties);
  };

  let lastGlobalSkipReason: GlobalSkipReason | undefined;

  const forRun = (runContext: MaintainerRunContext) => {
    const runStartedAtMs = Date.now();
    const getRunDurationMs = () => Date.now() - runStartedAtMs;

    const reportStageSummary = ({
      stage,
      status,
      durationMs,
      skipReason,
      errorKind,
      errorMessage,
      pagesProcessed,
      scoresWritten,
      deferToPhase2Count,
      notInStoreCount,
      resetBatchLimitHit,
    }: {
      stage: 'phase1_base_scoring' | 'reset_to_zero';
      status: MaintainerStatus;
      durationMs: number;
      skipReason?: 'reset_to_zero_disabled';
      errorKind?: MaintainerErrorKind;
      errorMessage?: string;
      pagesProcessed?: number;
      scoresWritten?: number;
      deferToPhase2Count?: number;
      notInStoreCount?: number;
      resetBatchLimitHit?: boolean;
    }) => {
      reportEvent(RISK_SCORE_MAINTAINER_STAGE_SUMMARY_EVENT.eventType, {
        namespace: runContext.namespace,
        entityType: runContext.entityType,
        stage,
        status,
        durationMs,
        skipReason,
        errorKind,
        pagesProcessed,
        scoresWritten,
        deferToPhase2Count,
        notInStoreCount,
        resetBatchLimitHit,
        idBasedRiskScoringEnabled: runContext.idBasedRiskScoringEnabled,
        pipelineVersion,
      });
    };

    const startBaseStage = () => {
      const stageStartedAtMs = Date.now();
      return {
        success: (input: {
          pagesProcessed: number;
          scoresWritten: number;
          deferToPhase2Count: number;
          notInStoreCount: number;
        }) =>
          reportStageSummary({
            stage: 'phase1_base_scoring',
            status: 'success',
            durationMs: Date.now() - stageStartedAtMs,
            pagesProcessed: input.pagesProcessed,
            scoresWritten: input.scoresWritten,
            deferToPhase2Count: input.deferToPhase2Count,
            notInStoreCount: input.notInStoreCount,
          }),
        error: (input: { errorKind: MaintainerErrorKind; errorMessage: string }) =>
          reportStageSummary({
            stage: 'phase1_base_scoring',
            status: 'error',
            durationMs: Date.now() - stageStartedAtMs,
            errorKind: input.errorKind,
            errorMessage: input.errorMessage,
          }),
      };
    };

    const startResetStage = () => {
      const stageStartedAtMs = Date.now();
      return {
        success: (input: { scoresWritten: number; resetBatchLimitHit: boolean }) =>
          reportStageSummary({
            stage: 'reset_to_zero',
            status: 'success',
            durationMs: Date.now() - stageStartedAtMs,
            scoresWritten: input.scoresWritten,
            resetBatchLimitHit: input.resetBatchLimitHit,
          }),
        error: (input: { errorKind: MaintainerErrorKind; errorMessage: string }) =>
          reportStageSummary({
            stage: 'reset_to_zero',
            status: 'error',
            durationMs: Date.now() - stageStartedAtMs,
            errorKind: input.errorKind,
            errorMessage: input.errorMessage,
          }),
        skipped: () =>
          reportStageSummary({
            stage: 'reset_to_zero',
            status: 'skipped',
            durationMs: 0,
            skipReason: 'reset_to_zero_disabled',
          }),
      };
    };

    return {
      startBaseStage,
      startResetStage,
      errorSummary: (input: { errorKind: MaintainerErrorKind; errorMessage: string }) => {
        reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
          namespace: runContext.namespace,
          entityType: runContext.entityType,
          status: 'error',
          errorKind: input.errorKind,
          durationMs: getRunDurationMs(),
          scoresWrittenTotal: 0,
          scoresWrittenBase: 0,
          scoresWrittenResetToZero: 0,
          pagesProcessed: 0,
          deferToPhase2Count: 0,
          notInStoreCount: 0,
          idBasedRiskScoringEnabled: runContext.idBasedRiskScoringEnabled,
          pipelineVersion,
        });
      },
      completionSummary: (input: {
        runStatus: 'success' | 'error';
        runErrorKind?: MaintainerErrorKind;
        runErrorMessage?: string;
        scoresWrittenBase: number;
        scoresWrittenResetToZero: number;
        pagesProcessed: number;
        deferToPhase2Count: number;
        notInStoreCount: number;
      }) => {
        reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
          namespace: runContext.namespace,
          entityType: runContext.entityType,
          status: input.runStatus,
          errorKind: input.runErrorKind,
          durationMs: getRunDurationMs(),
          scoresWrittenTotal: input.scoresWrittenBase + input.scoresWrittenResetToZero,
          scoresWrittenBase: input.scoresWrittenBase,
          scoresWrittenResetToZero: input.scoresWrittenResetToZero,
          pagesProcessed: input.pagesProcessed,
          deferToPhase2Count: input.deferToPhase2Count,
          notInStoreCount: input.notInStoreCount,
          idBasedRiskScoringEnabled: runContext.idBasedRiskScoringEnabled,
          pipelineVersion,
        });
      },
    };
  };

  return {
    reportGlobalSkipIfChanged: ({
      namespace,
      skipReason,
      idBasedRiskScoringEnabled,
      calculationRunId,
    }: GlobalSkipInput) => {
      if (lastGlobalSkipReason === skipReason) {
        return;
      }

      reportEvent(RISK_SCORE_MAINTAINER_RUN_SUMMARY_EVENT.eventType, {
        namespace,
        entityType: 'all',
        status: 'skipped',
        skipReason,
        durationMs: 0,
        scoresWrittenTotal: 0,
        scoresWrittenBase: 0,
        scoresWrittenResetToZero: 0,
        pagesProcessed: 0,
        deferToPhase2Count: 0,
        notInStoreCount: 0,
        idBasedRiskScoringEnabled,
        pipelineVersion,
      });
      lastGlobalSkipReason = skipReason;
    },
    clearGlobalSkipReason: () => {
      lastGlobalSkipReason = undefined;
    },
    getErrorMessage: (error: unknown): string => {
      return getErrorMessage(error);
    },
    forRun,
  };
};

const getErrorMessage = (error: unknown): string => {
  const fallback = 'unknown_error';
  if (!error || typeof error !== 'object') {
    return fallback;
  }

  const message = 'message' in error ? String(error.message) : fallback;
  return message.substring(0, ERROR_MESSAGE_MAX_LENGTH);
};
