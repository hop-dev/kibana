/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  Logger,
  CoreStart,
  ElasticsearchClient,
  SavedObjectsClientContract,
} from '@kbn/core/server';

import type {
  AgentClient,
  AgentPolicyServiceInterface,
  PackagePolicyServiceInterface,
} from '@kbn/fleet-plugin/server';
import { PACKAGE_POLICY_SAVED_OBJECT_TYPE } from '@kbn/fleet-plugin/common';
import { OSQUERY_INTEGRATION_NAME } from '../../../common';
import { packSavedObjectType, savedQuerySavedObjectType } from '../../../common/types';
import type { ESLicense, ESClusterInfo } from './types';
import type { OsqueryAppContextService } from '../osquery_app_context_services';

export class TelemetryReceiver {
  private readonly logger: Logger;
  private agentClient?: AgentClient;
  private agentPolicyService?: AgentPolicyServiceInterface;
  private packagePolicyService?: PackagePolicyServiceInterface;
  private esClient?: ElasticsearchClient;
  private soClient?: SavedObjectsClientContract;
  private clusterInfo?: ESClusterInfo;
  private readonly max_records = 100;

  constructor(logger: Logger) {
    this.logger = logger.get('telemetry_events');
  }

  public async start(core: CoreStart, osqueryContextService?: OsqueryAppContextService) {
    this.agentClient = osqueryContextService?.getAgentService()?.asInternalUser;
    this.agentPolicyService = osqueryContextService?.getAgentPolicyService();
    this.packagePolicyService = osqueryContextService?.getPackagePolicyService();
    this.esClient = core.elasticsearch.client.asInternalUser;
    this.soClient =
      core.savedObjects.createInternalRepository() as unknown as SavedObjectsClientContract;
    this.clusterInfo = await this.fetchClusterInfo();
  }

  public getClusterInfo(): ESClusterInfo | undefined {
    return this.clusterInfo;
  }

  public async fetchPacks() {
    return this.soClient?.find({
      type: packSavedObjectType,
      page: 1,
      perPage: this.max_records,
      sortField: 'updated_at',
      sortOrder: 'desc',
    });
  }

  public async fetchSavedQueries() {
    return this.soClient?.find({
      type: savedQuerySavedObjectType,
      page: 1,
      perPage: this.max_records,
      sortField: 'updated_at',
      sortOrder: 'desc',
    });
  }

  public async fetchConfigs() {
    if (this.soClient) {
      return this.packagePolicyService?.list(this.soClient, {
        kuery: `${PACKAGE_POLICY_SAVED_OBJECT_TYPE}.package.name:${OSQUERY_INTEGRATION_NAME}`,
        perPage: 1000,
        page: 1,
      });
    }

    throw Error('elasticsearch client is unavailable: cannot retrieve fleet policy responses');
  }

  public async fetchFleetAgents() {
    if (this.esClient === undefined || this.soClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve fleet policy responses');
    }

    return this.agentClient?.listAgents({
      perPage: this.max_records,
      showInactive: true,
      sortField: 'enrolled_at',
      sortOrder: 'desc',
    });
  }

  public async fetchPolicyConfigs(id: string) {
    if (this.soClient === undefined || this.soClient === null) {
      throw Error(
        'saved object client is unavailable: cannot retrieve endpoint policy configurations'
      );
    }

    return this.agentPolicyService?.get(this.soClient, id);
  }

  public async fetchClusterInfo(): Promise<ESClusterInfo> {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve cluster infomation');
    }

    return this.esClient.info();
  }

  public async fetchLicenseInfo(): Promise<ESLicense | undefined> {
    if (this.esClient === undefined || this.esClient === null) {
      throw Error('elasticsearch client is unavailable: cannot retrieve license information');
    }

    try {
      const ret = await this.esClient.transport.request<{ license: ESLicense }>({
        method: 'GET',
        path: '/_license',
        querystring: {
          local: true,
        },
      });

      return ret.license;
    } catch (err) {
      this.logger.debug(`failed retrieving license: ${err}`);

      return undefined;
    }
  }

  public copyLicenseFields(lic: ESLicense) {
    return {
      uid: lic.uid,
      status: lic.status,
      type: lic.type,
      ...(lic.issued_to ? { issued_to: lic.issued_to } : {}),
      ...(lic.issuer ? { issuer: lic.issuer } : {}),
    };
  }
}
