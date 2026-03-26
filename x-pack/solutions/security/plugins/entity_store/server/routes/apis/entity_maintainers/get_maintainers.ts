/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IKibanaResponse } from '@kbn/core-http-server';
import type { GetEntityMaintainersResponse, EntityMaintainerResponseItem } from '../../../../common';
import { API_VERSIONS, ENTITY_STORE_ROUTES } from '../../../../common';
import { DEFAULT_ENTITY_STORE_PERMISSIONS } from '../../constants';
import type { EntityStorePluginRouter } from '../../../types';
import { wrapMiddlewares } from '../../middleware';
import type { EntityMaintainerListEntry } from '../../../domain/entity_maintainers';

function toGetMaintainersResponseItem(
  entry: EntityMaintainerListEntry
): EntityMaintainerResponseItem {
  const snapshot = entry.taskSnapshot;
  return {
    id: entry.id,
    taskStatus: entry.taskStatus,
    interval: entry.interval,
    description: entry.description ?? null,
    nextRunAt: entry.nextRunAt,
    customState: snapshot?.state ?? null,
    runs: snapshot?.runs ?? 0,
    lastSuccessTimestamp: snapshot?.lastSuccessTimestamp ?? null,
    lastErrorTimestamp: snapshot?.lastErrorTimestamp ?? null,
  };
}

export function registerGetMaintainers(router: EntityStorePluginRouter) {
  router.versioned
    .get({
      path: ENTITY_STORE_ROUTES.ENTITY_MAINTAINERS_GET,
      access: 'internal',
      security: {
        authz: DEFAULT_ENTITY_STORE_PERMISSIONS,
      },
      enableQueryVersion: true,
    })
    .addVersion(
      {
        version: API_VERSIONS.internal.v2,
        validate: false,
      },
      wrapMiddlewares(
        async (
          ctx,
          req,
          res
        ): Promise<IKibanaResponse<GetEntityMaintainersResponse>> => {
          const entityStoreCtx = await ctx.entityStore;
          const { entityMaintainersClient } = entityStoreCtx;
          const clientMaintainers = await entityMaintainersClient.getMaintainers();
          const formattedMaintainers: EntityMaintainerResponseItem[] = clientMaintainers.map(
            toGetMaintainersResponseItem
          );

          return res.ok({ body: { maintainers: formattedMaintainers } });
        }
      )
    );
}
