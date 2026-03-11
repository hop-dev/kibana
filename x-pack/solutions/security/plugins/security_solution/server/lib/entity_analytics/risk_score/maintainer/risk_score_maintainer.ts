/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { EntityStoreSetupContract } from '@kbn/entity-store/server';
import type { EntityAnalyticsRoutesDeps } from '../../types';
import { RiskScoreDataClient } from '../risk_score_data_client';
import {
  initSavedObjects,
  updateSavedObjectAttribute,
} from '../../risk_engine/utils/saved_object_configuration';
import { buildScopedInternalSavedObjectsClientUnsafe } from '../tasks/helpers';
import { INTERVAL } from '../tasks/constants';

export const registerRiskScoreMaintainer = ({
  entityStore,
  getStartServices,
  kibanaVersion,
  logger,
  auditLogger,
}: {
  entityStore: EntityStoreSetupContract | undefined;
  getStartServices: EntityAnalyticsRoutesDeps['getStartServices'];
  kibanaVersion: string;
  logger: Logger;
  auditLogger: AuditLogger | undefined;
}): void => {
  if (!entityStore) {
    logger.info('Entity Store is unavailable; skipping risk score maintainer registration.');
    return;
  }

  entityStore.registerEntityMaintainer({
    id: 'risk-score',
    description: 'Entity Analytics Risk Score Maintainer',
    interval: INTERVAL,
    initialState: {},
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

      await riskScoreDataClient.init();
      await initSavedObjects({ savedObjectsClient: soClient, namespace });
      await updateSavedObjectAttribute({
        savedObjectsClient: soClient,
        attributes: { enabled: true },
      });

      return status.state;
    },
    run: async ({ status, crudClient }) => {
      const namespace = status.metadata.namespace;

      const errors = await crudClient.upsertEntitiesBulk({
        objects: [],
      });

      logger.info(
        `Risk score maintainer heartbeat for namespace "${namespace}": entity store CRUD bulk call succeeded with ${errors.length} errors`
      );

      return status.state;
    },
  });
};
