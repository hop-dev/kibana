/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Temporary writer for the v2 entity store updates data stream.
 * This class will be removed when the entity_store plugin implements the proper
 * writer; we will then switch over to their implementation.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { BulkOperationContainer } from '@elastic/elasticsearch/lib/api/types';
import type { EntityType } from '../../../../common/entity_analytics/types';

/**
 * Must stay in sync with entity_store's getUpdatesEntitiesDataStreamName until we use their writer.
 * @see x-pack/solutions/security/plugins/entity_store/server/domain/assets/updates_data_stream.ts
 */
export const getEntityStoreV2UpdatesDataStreamName = (namespace: string): string =>
  `.entities.v2.updates.security_${namespace}`;

export interface BulkObject {
  type: EntityType;
  document: object;
}

export interface UpsertEntitiesBulkOptions {
  refresh?: boolean | 'wait_for';
}

export interface UpsertEntitiesBulkResult {
  errors: string[];
  docs_written: number;
}

export class TempEntityStoreV2Writer {
  constructor(private readonly esClient: ElasticsearchClient, private readonly namespace: string) {}

  public async upsertEntitiesBulk(
    objects: BulkObject[],
    options?: UpsertEntitiesBulkOptions
  ): Promise<UpsertEntitiesBulkResult> {
    if (objects.length === 0) {
      return { errors: [], docs_written: 0 };
    }

    const index = getEntityStoreV2UpdatesDataStreamName(this.namespace);
    const operations: BulkOperationContainer[] = objects.flatMap((obj) => [
      { index: { _index: index } },
      obj.document,
    ]);

    try {
      const response = await this.esClient.bulk({
        operations,
        refresh: options?.refresh ?? false,
      });

      const errors = response.errors
        ? (response.items ?? [])
            .map((item) => item.index?.error?.reason)
            .filter((reason): reason is string => typeof reason === 'string')
        : [];
      const docsWritten = (response.items ?? []).filter(
        (item) => item.index?.status === 200 || item.index?.status === 201
      ).length;

      return { errors, docs_written: docsWritten };
    } catch (e) {
      return {
        errors: [(e as Error).message],
        docs_written: 0,
      };
    }
  }
}
