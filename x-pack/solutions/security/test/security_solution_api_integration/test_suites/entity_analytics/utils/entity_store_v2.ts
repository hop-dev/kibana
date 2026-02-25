/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { X_ELASTIC_INTERNAL_ORIGIN_REQUEST } from '@kbn/core-http-common';
import type { Client } from '@elastic/elasticsearch';
import type { ToolingLog } from '@kbn/tooling-log';
import type SuperTest from 'supertest';
import { waitFor } from '@kbn/detections-response-ftr-services';

const ENTITY_STORE_V2_LATEST_INDEX_PREFIX = '.entities.v2.latest.security_';
const ENTITY_STORE_V2_UPDATES_INDEX_PREFIX = '.entities.v2.updates.security_';

export const getEntityStoreV2LatestIndex = (namespace = 'default') =>
  `${ENTITY_STORE_V2_LATEST_INDEX_PREFIX}${namespace}`;

export const getEntityStoreV2UpdatesIndex = (namespace = 'default') =>
  `${ENTITY_STORE_V2_UPDATES_INDEX_PREFIX}${namespace}`;

/**
 * Documents in the LATEST index use flat dot-notation keys in _source
 * because they're ingested from ES|QL columnar format via ingestEntities.
 * E.g. `'entity.id': 'host:host-0'` rather than `{ entity: { id: 'host:host-0' } }`.
 */
export interface EntityStoreEntity {
  '@timestamp'?: string;
  'entity.id'?: string;
  'entity.name'?: string;
  'entity.type'?: string;
  'entity.EngineMetadata.Type'?: string;
  'entity.risk.calculated_score'?: number;
  'entity.risk.calculated_score_norm'?: number;
  'entity.risk.calculated_level'?: string;
  'host.name'?: string;
  'host.entity.id'?: string;
  'user.name'?: string;
  'user.entity.id'?: string;
  [key: string]: unknown;
}

export const getEntityId = (entity: EntityStoreEntity): string | undefined => entity['entity.id'];

export const getEntityRisk = (
  entity: EntityStoreEntity
): { calculated_score_norm?: number; calculated_level?: string } | undefined => {
  const scoreNorm = entity['entity.risk.calculated_score_norm'] as number | undefined;
  const level = entity['entity.risk.calculated_level'] as string | undefined;
  if (scoreNorm == null && level == null) return undefined;
  return { calculated_score_norm: scoreNorm, calculated_level: level };
};

export const readEntityStoreEntities = async (
  es: Client,
  namespace = 'default',
  size = 1000
): Promise<EntityStoreEntity[]> => {
  try {
    const results = await es.search({
      index: getEntityStoreV2LatestIndex(namespace),
      size,
    });
    return results.hits.hits.map((hit) => hit._source as EntityStoreEntity);
  } catch (e) {
    if (e.meta?.statusCode === 404) {
      return [];
    }
    throw e;
  }
};

export const getEntitiesById = async ({
  es,
  entityIds,
  namespace = 'default',
}: {
  es: Client;
  entityIds: string[];
  namespace?: string;
}): Promise<EntityStoreEntity[]> => {
  try {
    const results = await es.search({
      index: getEntityStoreV2LatestIndex(namespace),
      size: entityIds.length,
      query: {
        bool: {
          should: [
            { terms: { 'entity.id': entityIds } },
            { terms: { 'host.entity.id': entityIds } },
            { terms: { 'user.entity.id': entityIds } },
          ],
          minimum_should_match: 1,
        },
      },
    });
    return results.hits.hits.map((hit) => hit._source as EntityStoreEntity);
  } catch (e) {
    if (e.meta?.statusCode === 404) {
      return [];
    }
    throw e;
  }
};

export const waitForEntityStoreEntitiesToBePresent = async ({
  es,
  log,
  entityCount = 1,
  namespace = 'default',
}: {
  es: Client;
  log: ToolingLog;
  entityCount?: number;
  namespace?: string;
}): Promise<void> => {
  let lastSnapshot = '';
  await waitFor(
    async () => {
      const entities = await readEntityStoreEntities(es, namespace, entityCount + 10);
      const snapshot = JSON.stringify(entities);
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        log.debug(
          `waitForEntityStoreEntitiesToBePresent: found ${entities.length}/${entityCount} entities`
        );
      }
      return entities.length >= entityCount;
    },
    'waitForEntityStoreEntitiesToBePresent',
    log
  );
};

export const deleteAllEntityStoreEntities = async (
  log: ToolingLog,
  es: Client,
  namespace = 'default'
): Promise<void> => {
  const indices = [getEntityStoreV2LatestIndex(namespace), getEntityStoreV2UpdatesIndex(namespace)];
  for (const index of indices) {
    try {
      await es.deleteByQuery({
        index,
        query: { match_all: {} },
        ignore_unavailable: true,
        refresh: true,
      });
    } catch (e) {
      if (e.meta?.statusCode !== 404) {
        throw e;
      }
    }
  }
};

const cleanupEntityStoreV2Indices = async (es: Client, namespace = 'default'): Promise<void> => {
  const indices = [getEntityStoreV2LatestIndex(namespace), getEntityStoreV2UpdatesIndex(namespace)];
  for (const index of indices) {
    try {
      await es.indices.deleteDataStream({ name: index });
    } catch (e) {
      // not a data stream or doesn't exist
    }
    try {
      await es.indices.delete({ index, allow_no_indices: true });
    } catch (e) {
      // doesn't exist
    }
  }
};

const ENTITY_STORE_V2_INSTALL_URL = '/internal/security/entity-store/install';
const ENTITY_STORE_V2_UNINSTALL_URL = '/internal/security/entity-store/uninstall';

const forceLogExtractionUrl = (entityType: string) =>
  `/internal/security/entity-store/${entityType}/force-log-extraction`;

export const entityStoreV2RouteHelpersFactory = (
  supertest: SuperTest.Agent,
  es: Client,
  namespace = 'default'
) => ({
  install: async (expectStatusCode: number = 201) => {
    const response = await supertest
      .post(ENTITY_STORE_V2_INSTALL_URL)
      .set('kbn-xsrf', 'true')
      .set('elastic-api-version', '2')
      .set(X_ELASTIC_INTERNAL_ORIGIN_REQUEST, 'kibana')
      .send({});
    if (response.status !== expectStatusCode && response.status !== 200) {
      throw new Error(
        `Expected entity store install status ${expectStatusCode}, got ${response.status}: ${response.text}`
      );
    }
    return response;
  },

  /**
   * Uninstalls the entity store via the API. When `cleanIndices` is true, also
   * forcefully removes any orphaned ES indices/data streams that may linger
   * after a crashed test run where the API-level uninstall can't reach them.
   */
  uninstall: async ({ cleanIndices = false }: { cleanIndices?: boolean } = {}) => {
    const response = await supertest
      .post(ENTITY_STORE_V2_UNINSTALL_URL)
      .set('kbn-xsrf', 'true')
      .set('elastic-api-version', '2')
      .set(X_ELASTIC_INTERNAL_ORIGIN_REQUEST, 'kibana')
      .send({});
    if (cleanIndices) {
      await cleanupEntityStoreV2Indices(es, namespace);
    }
    return response;
  },

  forceLogExtraction: async (entityTypes: string[] = ['host', 'user']) => {
    const responses = [];
    for (const entityType of entityTypes) {
      const response = await supertest
        .post(forceLogExtractionUrl(entityType))
        .set('kbn-xsrf', 'true')
        .set('elastic-api-version', '2')
        .set(X_ELASTIC_INTERNAL_ORIGIN_REQUEST, 'kibana')
        .send({
          fromDateISO: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          toDateISO: new Date().toISOString(),
        });
      responses.push(response);
    }
    return responses;
  },
});
