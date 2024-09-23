/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, ElasticsearchClient, SavedObjectsClientContract } from '@kbn/core/server';
import type { EntityClient } from '@kbn/entityManager-plugin/server/lib/entity_client';

import type { SortOrder } from '@elastic/elasticsearch/lib/api/types';
import type { Entity } from '../../../../common/api/entity_analytics/entity_store/entities/common.gen';
import { createQueryFilterClauses } from '../../../utils/build_query';
import type {
  InitEntityStoreRequestBody,
  InitEntityStoreResponse,
} from '../../../../common/api/entity_analytics/entity_store/engine/init.gen';
import type {
  EngineDescriptor,
  EntityType,
  InspectQuery,
} from '../../../../common/api/entity_analytics/entity_store/common.gen';
import { entityEngineDescriptorTypeName } from './saved_object';
import { EngineDescriptorClient } from './saved_object/engine_descriptor';
import { getDefinitionForEntityType } from './definition';
import {
  createFieldRetentionEnrichPolicy,
  executeFieldRetentionEnrichPolicy,
  getFieldRetentionPipelineSteps,
} from './field_retention';
import { getEntitiesIndexName } from './utils/utils';
import { ENGINE_STATUS, MAX_SEARCH_RESPONSE_SIZE } from './constants';
import { getEntityIndexMapping } from './index_mappings';

interface EntityStoreClientOpts {
  logger: Logger;
  esClient: ElasticsearchClient;
  entityClient: EntityClient;
  namespace: string;
  soClient: SavedObjectsClientContract;
}

interface SearchEntitiesParams {
  entityTypes: EntityType[];
  filterQuery?: string;
  page: number;
  perPage: number;
  sortField: string;
  sortOrder: SortOrder;
}

export class EntityStoreDataClient {
  private engineClient: EngineDescriptorClient;
  constructor(private readonly options: EntityStoreClientOpts) {
    this.engineClient = new EngineDescriptorClient(options.soClient);
  }

  public async init(
    entityType: EntityType,
    { indexPattern = '', filter = '' }: InitEntityStoreRequestBody
  ): Promise<InitEntityStoreResponse> {
    const definition = getDefinitionForEntityType(entityType);
    const { logger, entityClient } = this.options;

    logger.info(`Initializing entity store for ${entityType}`);

    const descriptor = await this.engineClient.init(entityType, definition, filter);
    logger.debug(`Initialized engine for ${entityType}`);
    // TODO: spaces
    const spaceId = 'default';
    await entityClient.createEntityDefinition({
      definition: {
        ...definition,
        filter,
        indexPatterns: indexPattern
          ? [...definition.indexPatterns, ...indexPattern.split(',')]
          : definition.indexPatterns,
      },
      installOnly: true,
    });
    logger.debug(`Created entity definition for ${entityType}`);
    await this.createEntityIndexComponentTemplate({ entityType, spaceId });
    logger.debug(`Created entity index component template for ${entityType}`);
    await this.createEntityIndex({ spaceId, entityType });
    logger.debug(`Created entity index for ${entityType}`);
    await this.createFieldRetentionEnrichPolicy({ spaceId, entityType });
    logger.debug(`Created field retention enrich policy for ${entityType}`);
    await this.executeFieldRetentionEnrichPolicy({ spaceId, entityType });
    logger.debug(`Executed field retention enrich policy for ${entityType}`);
    await this.createPlatformPipeline({ spaceId, entityType });
    logger.debug(`Created @platform pipeline for ${entityType}`);

    await this.start(entityType, { force: true });
    logger.debug(`Started entity definition for ${entityType}`);
    const updated = await this.engineClient.update(definition.id, ENGINE_STATUS.STARTED);
    logger.debug(`Updated engine status to 'started' for ${entityType}, initialisation complete`);
    return { ...descriptor, ...updated };
  }

  public executeFieldRetentionEnrichPolicy({
    spaceId,
    entityType,
  }: {
    spaceId: string;
    entityType: EntityType;
  }) {
    return executeFieldRetentionEnrichPolicy({
      spaceId,
      esClient: this.options.esClient,
      entityType,
    });
  }

  public async createFieldRetentionEnrichPolicy({
    spaceId,
    entityType,
  }: {
    spaceId: string;
    entityType: EntityType;
  }) {
    return createFieldRetentionEnrichPolicy({
      spaceId,
      esClient: this.options.esClient,
      entityType,
    });
  }

  private async createPlatformPipeline({
    spaceId,
    entityType,
  }: {
    entityType: EntityType;
    spaceId: string;
  }) {
    const definition = getDefinitionForEntityType(entityType);

    await this.options.esClient.ingest.putPipeline({
      id: `${definition.id}@platform`,
      body: {
        _meta: {
          managed_by: 'entity_store',
          managed: true,
        },
        description: `Ingest pipeline for entity defiinition ${definition.id}`,
        processors: getFieldRetentionPipelineSteps({ spaceId, entityType }),
      },
    });
  }

  private async createEntityIndex({
    spaceId,
    entityType,
  }: {
    entityType: EntityType;
    spaceId: string;
  }) {
    // TODO: spaces
    await this.options.esClient.indices.create({
      index: getEntitiesIndexName(entityType),
      body: {},
    });
  }

  private async createEntityIndexComponentTemplate({
    entityType,
    spaceId,
  }: {
    entityType: EntityType;
    spaceId: string;
  }) {
    // TODO: spaces
    const definition = getDefinitionForEntityType(entityType);

    await this.options.esClient.cluster.putComponentTemplate({
      name: `${definition.id}-latest@platform`,
      body: {
        template: {
          mappings: getEntityIndexMapping(entityType),
        },
      },
    });
  }

  public async start(entityType: EntityType, options?: { force: boolean }) {
    const definition = getDefinitionForEntityType(entityType);

    const descriptor = await this.engineClient.get(entityType);

    if (!options?.force && descriptor.status !== ENGINE_STATUS.STOPPED) {
      throw new Error(
        `Cannot start Entity engine for ${entityType} when current status is: ${descriptor.status}`
      );
    }

    this.options.logger.info(`Starting entity store for ${entityType}`);
    await this.options.entityClient.startEntityDefinition(definition);

    return this.engineClient.update(definition.id, ENGINE_STATUS.STARTED);
  }

  public async stop(entityType: EntityType) {
    const definition = getDefinitionForEntityType(entityType);

    const descriptor = await this.engineClient.get(entityType);

    if (descriptor.status !== ENGINE_STATUS.STARTED) {
      throw new Error(
        `Cannot stop Entity engine for ${entityType} when current status is: ${descriptor.status}`
      );
    }

    this.options.logger.info(`Stopping entity store for ${entityType}`);
    await this.options.entityClient.stopEntityDefinition(definition);

    return this.engineClient.update(definition.id, ENGINE_STATUS.STOPPED);
  }

  public async get(entityType: EntityType) {
    return this.engineClient.get(entityType);
  }

  public async list() {
    return this.options.soClient
      .find<EngineDescriptor>({
        type: entityEngineDescriptorTypeName,
      })
      .then(({ saved_objects: engines }) => ({
        engines: engines.map((engine) => engine.attributes),
        count: engines.length,
      }));
  }

  public async delete(entityType: EntityType, deleteData: boolean) {
    const { id } = getDefinitionForEntityType(entityType);

    this.options.logger.info(`Deleting entity store for ${entityType}`);

    await this.options.entityClient.deleteEntityDefinition({ id, deleteData });
    await this.engineClient.delete(id);

    return { deleted: true };
  }

  public async searchEntities(params: SearchEntitiesParams): Promise<{
    records: Entity[];
    total: number;
    inspect: InspectQuery;
  }> {
    const { page, perPage, sortField, sortOrder, filterQuery, entityTypes } = params;

    const index = entityTypes.map(getEntitiesIndexName);
    const from = (page - 1) * perPage;
    const sort = sortField ? [{ [sortField]: sortOrder }] : undefined;

    const filter = [...createQueryFilterClauses(filterQuery)];
    const query = {
      bool: {
        filter,
      },
    };

    const response = await this.options.esClient.search<Entity>({
      index,
      query,
      size: Math.min(perPage, MAX_SEARCH_RESPONSE_SIZE),
      from,
      sort,
      ignore_unavailable: true,
    });
    const { hits } = response;

    const total = typeof hits.total === 'number' ? hits.total : hits.total?.value ?? 0;

    const records = hits.hits.map((hit) => hit._source as Entity);

    const inspect: InspectQuery = {
      dsl: [JSON.stringify({ index, body: query }, null, 2)],
      response: [JSON.stringify(response, null, 2)],
    };

    return { records, total, inspect };
  }
}
