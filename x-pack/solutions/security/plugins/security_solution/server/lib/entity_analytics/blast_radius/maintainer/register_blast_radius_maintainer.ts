/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { EntityStoreSetupContract } from '@kbn/entity-store/server';
import { BLAST_RADIUS_MAINTAINER_ID } from '../../../../../common/entity_analytics/blast_radius/constants';
import { createBlastRadiusMaintainer, type BlastRadiusConfig } from './blast_radius_maintainer';

/** Registers the blast radius daily job with the Entity Store, in every space it's installed in. */
export const registerBlastRadiusMaintainer = ({
  entityStore,
  config,
  logger,
}: {
  entityStore: EntityStoreSetupContract | undefined;
  config: BlastRadiusConfig;
  logger: Logger;
}): void => {
  if (!entityStore) {
    logger.info('Entity Store is unavailable; skipping blast radius maintainer registration.');
    return;
  }
  entityStore.registerEntityMaintainer({
    id: BLAST_RADIUS_MAINTAINER_ID,
    description: 'Entity Analytics Blast Radius Maintainer',
    interval: '1d',
    // Past the performance tests' one hour limit, so a run that passes it still ends with a record.
    timeout: '90m',
    minLicense: 'enterprise',
    initialState: {},
    run: createBlastRadiusMaintainer(config),
  });
};
