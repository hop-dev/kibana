/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { EntityStoreCRUDClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../../common/search_strategy';
import type { RiskEngineDataWriter } from '../risk_engine_data_writer';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import type { ScoredEntityPage } from './pipeline_types';

export interface PersistScoredPageParams {
  writer: RiskEngineDataWriter;
  crudClient: EntityStoreCRUDClient;
  logger: Logger;
  entityType: EntityType;
  idBasedRiskScoringEnabled: boolean;
  page: ScoredEntityPage;
}

export const persistScoredPage = async ({
  writer,
  crudClient,
  logger,
  entityType,
  idBasedRiskScoringEnabled,
  page,
}: PersistScoredPageParams): Promise<void> => {
  await writer.bulk({ [entityType]: page.scores });

  if (idBasedRiskScoringEnabled) {
    const entityStoreErrors = await persistRiskScoresToEntityStore({
      crudClient,
      logger,
      scores: { [entityType]: page.scores },
    });
    if (entityStoreErrors.length > 0) {
      logger.warn(
        `Entity store dual-write had ${entityStoreErrors.length} error(s): ${entityStoreErrors.join(
          '; '
        )}`
      );
    }
  }
};
