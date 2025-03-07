/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { Subject, Observable, firstValueFrom } from 'rxjs';
import { filter, take, switchMap } from 'rxjs/operators';
import type { Logger } from '@kbn/logging';
import type { CoreContext, CoreService } from '@kbn/core-base-server-internal';
import type { DocLinksServiceStart } from '@kbn/core-doc-links-server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { InternalHttpServiceSetup } from '@kbn/core-http-server-internal';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import type {
  InternalElasticsearchServiceSetup,
  InternalElasticsearchServiceStart,
} from '@kbn/core-elasticsearch-server-internal';
import type {
  SavedObjectsServiceSetup,
  SavedObjectsServiceStart,
  SavedObjectsRepositoryFactory,
  SavedObjectStatusMeta,
  SavedObjectsClientFactoryProvider,
  SavedObjectsClientWrapperFactory,
  ISavedObjectTypeRegistry,
} from '@kbn/core-saved-objects-server';
import { SavedObjectsClient, SavedObjectsClientProvider } from './service';
import { KibanaMigrator, IKibanaMigrator } from './migrations';
import { InternalCoreUsageDataSetup } from '../core_usage_data';
import { InternalDeprecationsServiceSetup } from '../deprecations';
import {
  SavedObjectsConfigType,
  SavedObjectsMigrationConfigType,
  SavedObjectConfig,
} from './saved_objects_config';
import { SavedObjectsRepository } from './service/lib/repository';
import { SavedObjectTypeRegistry } from './saved_objects_type_registry';
import { SavedObjectsSerializer } from './serialization';
import { SavedObjectsExporter } from './export';
import { SavedObjectsImporter } from './import';
import { registerRoutes } from './routes';
import { ServiceStatus } from '../status';
import { calculateStatus$ } from './status';
import { registerCoreObjectTypes } from './object_types';
import { getSavedObjectsDeprecationsProvider } from './deprecations';

const kibanaIndex = '.kibana';

/**
 * @internal
 */
export interface InternalSavedObjectsServiceSetup extends SavedObjectsServiceSetup {
  status$: Observable<ServiceStatus<SavedObjectStatusMeta>>;
  /** Note: this must be called after server.setup to get all plugin SO types */
  getTypeRegistry: () => ISavedObjectTypeRegistry;
}

export type InternalSavedObjectsServiceStart = SavedObjectsServiceStart;

/** @internal */
export interface SavedObjectsSetupDeps {
  http: InternalHttpServiceSetup;
  elasticsearch: InternalElasticsearchServiceSetup;
  coreUsageData: InternalCoreUsageDataSetup;
  deprecations: InternalDeprecationsServiceSetup;
}

interface WrappedClientFactoryWrapper {
  priority: number;
  id: string;
  factory: SavedObjectsClientWrapperFactory;
}

/** @internal */
export interface SavedObjectsStartDeps {
  elasticsearch: InternalElasticsearchServiceStart;
  pluginsInitialized?: boolean;
  docLinks: DocLinksServiceStart;
}

export class SavedObjectsService
  implements CoreService<InternalSavedObjectsServiceSetup, InternalSavedObjectsServiceStart>
{
  private logger: Logger;
  private readonly kibanaVersion: string;

  private setupDeps?: SavedObjectsSetupDeps;
  private config?: SavedObjectConfig;
  private clientFactoryProvider?: SavedObjectsClientFactoryProvider;
  private clientFactoryWrappers: WrappedClientFactoryWrapper[] = [];

  private migrator$ = new Subject<IKibanaMigrator>();
  private typeRegistry = new SavedObjectTypeRegistry();
  private started = false;

  constructor(private readonly coreContext: CoreContext) {
    this.logger = coreContext.logger.get('savedobjects-service');
    this.kibanaVersion = SavedObjectsService.stripVersionQualifier(
      this.coreContext.env.packageInfo.version
    );
  }

  public async setup(setupDeps: SavedObjectsSetupDeps): Promise<InternalSavedObjectsServiceSetup> {
    this.logger.debug('Setting up SavedObjects service');

    this.setupDeps = setupDeps;
    const { http, elasticsearch, coreUsageData, deprecations } = setupDeps;

    const savedObjectsConfig = await firstValueFrom(
      this.coreContext.configService.atPath<SavedObjectsConfigType>('savedObjects')
    );
    const savedObjectsMigrationConfig = await firstValueFrom(
      this.coreContext.configService.atPath<SavedObjectsMigrationConfigType>('migrations')
    );
    this.config = new SavedObjectConfig(savedObjectsConfig, savedObjectsMigrationConfig);

    deprecations.getRegistry('savedObjects').registerDeprecations(
      getSavedObjectsDeprecationsProvider({
        kibanaIndex,
        savedObjectsConfig: this.config,
        kibanaVersion: this.kibanaVersion,
        typeRegistry: this.typeRegistry,
      })
    );

    coreUsageData.registerType(this.typeRegistry);

    registerRoutes({
      http,
      coreUsageData,
      logger: this.logger,
      config: this.config,
      migratorPromise: firstValueFrom(this.migrator$),
      kibanaIndex,
      kibanaVersion: this.kibanaVersion,
    });

    registerCoreObjectTypes(this.typeRegistry);

    return {
      status$: calculateStatus$(
        this.migrator$.pipe(switchMap((migrator) => migrator.getStatus$())),
        elasticsearch.status$
      ),
      setClientFactoryProvider: (provider) => {
        if (this.started) {
          throw new Error('cannot call `setClientFactoryProvider` after service startup.');
        }
        if (this.clientFactoryProvider) {
          throw new Error('custom client factory is already set, and can only be set once');
        }
        this.clientFactoryProvider = provider;
      },
      addClientWrapper: (priority, id, factory) => {
        if (this.started) {
          throw new Error('cannot call `addClientWrapper` after service startup.');
        }
        this.clientFactoryWrappers.push({
          priority,
          id,
          factory,
        });
      },
      registerType: (type) => {
        if (this.started) {
          throw new Error('cannot call `registerType` after service startup.');
        }
        this.typeRegistry.registerType(type);
      },
      getTypeRegistry: () => this.typeRegistry,
      getKibanaIndex: () => kibanaIndex,
    };
  }

  public async start({
    elasticsearch,
    pluginsInitialized = true,
    docLinks,
  }: SavedObjectsStartDeps): Promise<InternalSavedObjectsServiceStart> {
    if (!this.setupDeps || !this.config) {
      throw new Error('#setup() needs to be run first');
    }

    this.logger.debug('Starting SavedObjects service');

    const client = elasticsearch.client;

    const migrator = this.createMigrator(
      this.config.migration,
      elasticsearch.client.asInternalUser,
      docLinks
    );

    this.migrator$.next(migrator);

    /**
     * Note: We want to ensure that migrations have completed before
     * continuing with further Core start steps that might use SavedObjects
     * such as running the legacy server, legacy plugins and allowing incoming
     * HTTP requests.
     *
     * However, our build system optimize step and some tests depend on the
     * HTTP server running without an Elasticsearch server being available.
     * So, when the `migrations.skip` is true, we skip migrations altogether.
     *
     * We also cannot safely run migrations if plugins are not initialized since
     * not plugin migrations won't be registered.
     */
    const skipMigrations = this.config.migration.skip || !pluginsInitialized;

    /**
     * Note: Prepares all migrations maps. If a saved object type was registered with property `migrations`
     * of type function; this function will be called to get the type's SavedObjectMigrationMap.
     */
    migrator.prepareMigrations();

    if (skipMigrations) {
      this.logger.warn(
        'Skipping Saved Object migrations on startup. Note: Individual documents will still be migrated when read or written.'
      );
    } else {
      this.logger.info(
        'Waiting until all Elasticsearch nodes are compatible with Kibana before starting saved objects migrations...'
      );

      // The Elasticsearch service should already ensure that, but let's double check just in case.
      // Should it be replaced with elasticsearch.status$ API instead?
      const compatibleNodes = await this.setupDeps!.elasticsearch.esNodesCompatibility$.pipe(
        filter((nodes) => nodes.isCompatible),
        take(1)
      ).toPromise();

      // Running migrations only if we got compatible nodes.
      // It may happen that the observable completes due to Kibana shutting down
      // and the promise above fulfils as undefined. We shouldn't trigger migrations at that point.
      if (compatibleNodes) {
        this.logger.info('Starting saved objects migrations');
        await migrator.runMigrations();
      }
    }

    const createRepository = (
      esClient: ElasticsearchClient,
      includedHiddenTypes: string[] = []
    ) => {
      return SavedObjectsRepository.createRepository(
        migrator,
        this.typeRegistry,
        kibanaIndex,
        esClient,
        this.logger.get('repository'),
        includedHiddenTypes
      );
    };

    const repositoryFactory: SavedObjectsRepositoryFactory = {
      createInternalRepository: (includedHiddenTypes?: string[]) =>
        createRepository(client.asInternalUser, includedHiddenTypes),
      createScopedRepository: (req: KibanaRequest, includedHiddenTypes?: string[]) =>
        createRepository(client.asScoped(req).asCurrentUser, includedHiddenTypes),
    };

    const clientProvider = new SavedObjectsClientProvider({
      defaultClientFactory({ request, includedHiddenTypes }) {
        const repository = repositoryFactory.createScopedRepository(request, includedHiddenTypes);
        return new SavedObjectsClient(repository);
      },
      typeRegistry: this.typeRegistry,
    });
    if (this.clientFactoryProvider) {
      const clientFactory = this.clientFactoryProvider(repositoryFactory);
      clientProvider.setClientFactory(clientFactory);
    }
    this.clientFactoryWrappers.forEach(({ id, factory, priority }) => {
      clientProvider.addClientWrapperFactory(priority, id, factory);
    });

    this.started = true;

    return {
      getScopedClient: clientProvider.getClient.bind(clientProvider),
      createScopedRepository: repositoryFactory.createScopedRepository,
      createInternalRepository: repositoryFactory.createInternalRepository,
      createSerializer: () => new SavedObjectsSerializer(this.typeRegistry),
      createExporter: (savedObjectsClient) =>
        new SavedObjectsExporter({
          savedObjectsClient,
          typeRegistry: this.typeRegistry,
          exportSizeLimit: this.config!.maxImportExportSize,
          logger: this.logger.get('exporter'),
        }),
      createImporter: (savedObjectsClient) =>
        new SavedObjectsImporter({
          savedObjectsClient,
          typeRegistry: this.typeRegistry,
          importSizeLimit: this.config!.maxImportExportSize,
        }),
      getTypeRegistry: () => this.typeRegistry,
    };
  }

  public async stop() {}

  private createMigrator(
    soMigrationsConfig: SavedObjectsMigrationConfigType,
    client: ElasticsearchClient,
    docLinks: DocLinksServiceStart
  ): IKibanaMigrator {
    return new KibanaMigrator({
      typeRegistry: this.typeRegistry,
      logger: this.logger,
      kibanaVersion: this.kibanaVersion,
      soMigrationsConfig,
      kibanaIndex,
      client,
      docLinks,
    });
  }

  /**
   * Coerce a semver-like string (x.y.z-SNAPSHOT) or prerelease version (x.y.z-alpha)
   * to regular semver (x.y.z).
   */
  private static stripVersionQualifier(version: string) {
    return version.split('-')[0];
  }
}
