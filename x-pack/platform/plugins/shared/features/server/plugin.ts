/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RecursiveReadonly } from '@kbn/utility-types';
import { deepFreeze } from '@kbn/std';
import {
  CoreSetup,
  CoreStart,
  SavedObjectsServiceStart,
  Logger,
  Plugin,
  PluginInitializerContext,
  Capabilities as UICapabilities,
} from '@kbn/core/server';
import { ConfigType } from './config';
import { FeatureRegistry, GetKibanaFeaturesParams } from './feature_registry';
import { uiCapabilitiesForFeatures } from './ui_capabilities_for_features';
import { buildOSSFeatures } from './oss_features';
import { defineRoutes } from './routes';
import {
  ElasticsearchFeatureConfig,
  ElasticsearchFeature,
  KibanaFeature,
  KibanaFeatureConfig,
} from '../common';
import type {
  FeaturePrivilegeIterator,
  SubFeaturePrivilegeIterator,
} from './feature_privilege_iterator';
import {
  featurePrivilegeIterator,
  subFeaturePrivilegeIterator,
} from './feature_privilege_iterator';

/**
 * Describes public Features plugin contract returned at the `setup` stage.
 */
export interface FeaturesPluginSetup {
  registerKibanaFeature(feature: KibanaFeatureConfig): void;

  registerElasticsearchFeature(feature: ElasticsearchFeatureConfig): void;

  /**
   * Calling this function during setup will crash Kibana.
   * Use start contract instead.
   * @deprecated
   * @removeBy 8.8.0
   */
  getKibanaFeatures(): KibanaFeature[];

  /**
   * Calling this function during setup will crash Kibana.
   * Use start contract instead.
   * @deprecated
   * @removeBy 8.8.0
   */
  getElasticsearchFeatures(): ElasticsearchFeature[];

  /**
   * In the future, OSS features should register their own subfeature
   * privileges. This can be done when parts of Reporting are moved to
   * src/plugins. For now, this method exists for `reporting` to tell
   * `features` to include Reporting when registering OSS features.
   */
  enableReportingUiCapabilities(): void;

  /**
   * Utility for iterating through all privileges belonging to a specific feature.
   * {@see FeaturePrivilegeIterator }
   */
  featurePrivilegeIterator: FeaturePrivilegeIterator;

  /**
   * Utility for iterating through all sub-feature privileges belonging to a specific feature.
   * {@see SubFeaturePrivilegeIterator }
   */
  subFeaturePrivilegeIterator: SubFeaturePrivilegeIterator;
}

export interface FeaturesPluginStart {
  getElasticsearchFeatures(): ElasticsearchFeature[];

  /**
   * Returns all registered Kibana features.
   * @param params Optional parameters to filter features.
   */
  getKibanaFeatures(params?: GetKibanaFeaturesParams): KibanaFeature[];
}

/**
 * Represents Features Plugin instance that will be managed by the Kibana plugin system.
 */
export class FeaturesPlugin
  implements Plugin<RecursiveReadonly<FeaturesPluginSetup>, RecursiveReadonly<FeaturesPluginStart>>
{
  private readonly logger: Logger;
  private readonly featureRegistry: FeatureRegistry = new FeatureRegistry();
  private isReportingEnabled: boolean = false;
  private capabilities?: UICapabilities;

  constructor(private readonly initializerContext: PluginInitializerContext) {
    this.logger = this.initializerContext.logger.get();
  }

  public setup(core: CoreSetup): RecursiveReadonly<FeaturesPluginSetup> {
    defineRoutes({
      router: core.http.createRouter(),
      featureRegistry: this.featureRegistry,
    });

    // capabilities provider wil never be called before plugin start
    core.capabilities.registerProvider(() => this.capabilities!);

    return deepFreeze({
      registerKibanaFeature: this.featureRegistry.registerKibanaFeature.bind(this.featureRegistry),
      registerElasticsearchFeature: this.featureRegistry.registerElasticsearchFeature.bind(
        this.featureRegistry
      ),
      getKibanaFeatures: this.featureRegistry.getAllKibanaFeatures.bind(this.featureRegistry),
      getElasticsearchFeatures: this.featureRegistry.getAllElasticsearchFeatures.bind(
        this.featureRegistry
      ),
      enableReportingUiCapabilities: this.enableReportingUiCapabilities.bind(this),
      featurePrivilegeIterator,
      subFeaturePrivilegeIterator,
    });
  }

  public start(core: CoreStart): RecursiveReadonly<FeaturesPluginStart> {
    this.registerOssFeatures(core.savedObjects);

    const { overrides } = this.initializerContext.config.get<ConfigType>();
    if (overrides) {
      this.featureRegistry.applyOverrides(overrides);
    }

    this.featureRegistry.lockRegistration();
    this.featureRegistry.validateFeatures();

    this.capabilities = uiCapabilitiesForFeatures(
      // Don't expose capabilities of the deprecated features.
      this.featureRegistry.getAllKibanaFeatures({ omitDeprecated: true }),
      this.featureRegistry.getAllElasticsearchFeatures()
    );

    return deepFreeze({
      getElasticsearchFeatures: this.featureRegistry.getAllElasticsearchFeatures.bind(
        this.featureRegistry
      ),
      getKibanaFeatures: (params) =>
        this.featureRegistry.getAllKibanaFeatures(
          params && { omitDeprecated: params.omitDeprecated }
        ),
    });
  }

  public stop() {}

  private registerOssFeatures(savedObjects: SavedObjectsServiceStart) {
    const registry = savedObjects.getTypeRegistry();
    const savedObjectVisibleTypes = registry.getVisibleTypes().map((t) => t.name);
    const savedObjectImportableAndExportableHiddenTypes = registry
      .getImportableAndExportableTypes()
      .filter((t) => registry.isHidden(t.name))
      .map((t) => t.name);

    const savedObjectTypes = Array.from(
      new Set([...savedObjectVisibleTypes, ...savedObjectImportableAndExportableHiddenTypes])
    );

    const features = buildOSSFeatures({
      savedObjectTypes,
      includeReporting: this.isReportingEnabled,
    });

    for (const feature of features) {
      this.featureRegistry.registerKibanaFeature(feature);
    }
  }

  private enableReportingUiCapabilities() {
    this.logger.debug(
      `Feature controls for Reporting plugin are enabled. Please assign access to Reporting use Kibana feature controls for applications.`
    );
    this.isReportingEnabled = true;
  }
}
