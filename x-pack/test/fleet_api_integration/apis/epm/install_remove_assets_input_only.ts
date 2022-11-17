/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Client } from '@elastic/elasticsearch';
import expect from '@kbn/expect';
import { sortBy } from 'lodash';
import { AssetReference } from '@kbn/fleet-plugin/common/types';
import { FLEET_INSTALL_FORMAT_VERSION } from '@kbn/fleet-plugin/server/constants';
import { FtrProviderContext } from '../../../api_integration/ftr_provider_context';
import { skipIfNoDockerRegistry } from '../../helpers';
import { setupFleetAndAgents } from '../agents/services';

function checkErrorWithResponseDataOrThrow(err: any) {
  if (!err?.response?.data) {
    throw err;
  }
}

export default function (providerContext: FtrProviderContext) {
  const { getService } = providerContext;
  const kibanaServer = getService('kibanaServer');
  const supertest = getService('supertest');
  const dockerServers = getService('dockerServers');
  const server = dockerServers.get('registry');
  const es: Client = getService('es');
  const pkgName = 'input_only_all_assets';
  const pkgVersion = '1.0.0';

  const uninstallPackage = async (pkg: string, version: string) => {
    await supertest.delete(`/api/fleet/epm/packages/${pkg}/${version}`).set('kbn-xsrf', 'xxxx');
  };
  const installPackage = async (pkg: string, version: string) => {
    await supertest
      .post(`/api/fleet/epm/packages/${pkg}/${version}`)
      .set('kbn-xsrf', 'xxxx')
      .send({ force: true });
  };

  describe('installs and uninstalls all assets', async () => {
    skipIfNoDockerRegistry(providerContext);
    setupFleetAndAgents(providerContext);
    describe.only('installs all assets when installing an input only package for the first time', async () => {
      before(async () => {
        if (!server.enabled) return;
        await installPackage(pkgName, pkgVersion);
      });
      after(async () => {
        if (!server.enabled) return;
        await uninstallPackage(pkgName, pkgVersion);
      });
      expectAssetsInstalled({
        pkgVersion,
        pkgName,
        es,
        kibanaServer,
      });
    });

    describe('uninstalls all assets when uninstalling a package', async () => {
      // these tests ensure that uninstall works properly so make sure that the package gets installed and uninstalled
      // and then we'll test that not artifacts are left behind.
      before(() => {
        if (!server.enabled) return;
        return installPackage(pkgName, pkgVersion);
      });
      before(() => {
        if (!server.enabled) return;
        return uninstallPackage(pkgName, pkgVersion);
      });
      expectAssetsUninstalled({
        pkgVersion,
        pkgName,
        es,
        kibanaServer,
      });
    });

    describe('reinstalls all assets', async () => {
      before(async () => {
        if (!server.enabled) return;
        await installPackage(pkgName, pkgVersion);
        // reinstall
        await installPackage(pkgName, pkgVersion);
      });
      after(async () => {
        if (!server.enabled) return;
        await uninstallPackage(pkgName, pkgVersion);
      });
      expectAssetsInstalled({
        pkgVersion,
        pkgName,
        es,
        kibanaServer,
      });
    });
  });
}

const expectAssetsUninstalled = ({
  pkgVersion,
  pkgName,
  es,
  kibanaServer,
}: {
  pkgVersion: string;
  pkgName: string;
  es: Client;
  kibanaServer: any;
}) => {
  const logsTemplateName = `logs-${pkgName}.test_logs`;
  const metricsTemplateName = `metrics-${pkgName}.test_metrics`;

  it('should have uninstalled the component templates', async function () {
    const resPackage = await es.transport.request(
      {
        method: 'GET',
        path: `/_component_template/${logsTemplateName}@package`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(resPackage.statusCode).equal(404);

    const resUserSettings = await es.transport.request(
      {
        method: 'GET',
        path: `/_component_template/${logsTemplateName}@custom`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(resUserSettings.statusCode).equal(404);
  });
  it('should have uninstalled the pipelines', async function () {
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `/_ingest/pipeline/${logsTemplateName}-${pkgVersion}`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(res.statusCode).equal(404);
    const resPipeline1 = await es.transport.request(
      {
        method: 'GET',
        path: `/_ingest/pipeline/${logsTemplateName}-${pkgVersion}-pipeline1`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(resPipeline1.statusCode).equal(404);
    const resPipeline2 = await es.transport.request(
      {
        method: 'GET',
        path: `/_ingest/pipeline/${logsTemplateName}-${pkgVersion}-pipeline2`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(resPipeline2.statusCode).equal(404);
  });
  it('should have uninstalled the ml model', async function () {
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `/_ml/trained_models/default`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(res.statusCode).equal(404);
  });
  it('should have uninstalled the transforms', async function () {
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `/_transform/${pkgName}-test-default-${pkgVersion}`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(res.statusCode).equal(404);
  });
  it('should have deleted the index for the transform', async function () {
    // the  index is defined in the transform file
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `/logs-all_assets.test_log_current_default`,
      },
      {
        ignore: [404],
        meta: true,
      }
    );
    expect(res.statusCode).equal(404);
  });
  it('should have uninstalled the kibana assets', async function () {
    let resDashboard;
    try {
      resDashboard = await kibanaServer.savedObjects.get({
        type: 'dashboard',
        id: 'sample_dashboard',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resDashboard = err;
    }
    expect(resDashboard.response.data.statusCode).equal(404);
    let resDashboard2;
    try {
      resDashboard2 = await kibanaServer.savedObjects.get({
        type: 'dashboard',
        id: 'sample_dashboard2',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resDashboard2 = err;
    }
    expect(resDashboard2.response.data.statusCode).equal(404);
    let resVis;
    try {
      resVis = await kibanaServer.savedObjects.get({
        type: 'visualization',
        id: 'sample_visualization',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resVis = err;
    }
    expect(resVis.response.data.statusCode).equal(404);
    let resSearch;
    try {
      resVis = await kibanaServer.savedObjects.get({
        type: 'search',
        id: 'sample_search',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resSearch = err;
    }
    expect(resSearch.response.data.statusCode).equal(404);
    let resIndexPattern;
    try {
      resIndexPattern = await kibanaServer.savedObjects.get({
        type: 'index-pattern',
        id: 'test-*',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resIndexPattern = err;
    }
    expect(resIndexPattern.response.data.statusCode).equal(404);
    let resOsqueryPackAsset;
    try {
      resOsqueryPackAsset = await kibanaServer.savedObjects.get({
        type: 'osquery-pack-asset',
        id: 'sample_osquery_pack_asset',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resOsqueryPackAsset = err;
    }
    expect(resOsqueryPackAsset.response.data.statusCode).equal(404);
    let resOsquerySavedQuery;
    try {
      resOsquerySavedQuery = await kibanaServer.savedObjects.get({
        type: 'osquery-saved-query',
        id: 'sample_osquery_saved_query',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resOsquerySavedQuery = err;
    }
    expect(resOsquerySavedQuery.response.data.statusCode).equal(404);
  });
  it('should have removed the saved object', async function () {
    let res;
    try {
      res = await kibanaServer.savedObjects.get({
        type: 'epm-packages',
        id: 'all_assets',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      res = err;
    }
    expect(res.response.data.statusCode).equal(404);
  });
};

const expectAssetsInstalled = ({
  pkgVersion,
  pkgName,
  es,
  kibanaServer,
}: {
  pkgVersion: string;
  pkgName: string;
  es: Client;
  kibanaServer: any;
}) => {
  it('should have installed the component templates', async function () {
    const resPackage = await es.transport.request(
      {
        method: 'GET',
        path: `/_component_template/logs-${pkgName}.logs@custom`,
      },
      { meta: true }
    );
    expect(resPackage.statusCode).equal(200);
  });
  it('should have installed the ml model', async function () {
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `_ml/trained_models/default`,
      },
      { meta: true }
    );
    expect(res.statusCode).equal(200);
  });

  it('should have installed the pipelines', async function () {
    const res = await es.transport.request(
      {
        method: 'GET',
        path: `/_ingest/pipeline/logs-${pkgName}.logs-${pkgVersion}`,
      },
      { meta: true }
    );
    expect(res.statusCode).equal(200);
  });

  it('should have installed the kibana assets', async function () {
    // These are installed from Fleet along with every package
    const resIndexPatternLogs = await kibanaServer.savedObjects.get({
      type: 'index-pattern',
      id: 'logs-*',
    });
    expect(resIndexPatternLogs.id).equal('logs-*');
    const resIndexPatternMetrics = await kibanaServer.savedObjects.get({
      type: 'index-pattern',
      id: 'metrics-*',
    });
    expect(resIndexPatternMetrics.id).equal('metrics-*');

    // These are the assets from the package
    const resDashboard = await kibanaServer.savedObjects.get({
      type: 'dashboard',
      id: 'sample_dashboard',
    });
    expect(resDashboard.id).equal('sample_dashboard');
    expect(resDashboard.references.map((ref: any) => ref.id).includes('sample_tag')).equal(true);
    const resDashboard2 = await kibanaServer.savedObjects.get({
      type: 'dashboard',
      id: 'sample_dashboard2',
    });
    expect(resDashboard2.id).equal('sample_dashboard2');
    const resVis = await kibanaServer.savedObjects.get({
      type: 'visualization',
      id: 'sample_visualization',
    });
    expect(resVis.id).equal('sample_visualization');
    const resSearch = await kibanaServer.savedObjects.get({
      type: 'search',
      id: 'sample_search',
    });
    expect(resSearch.id).equal('sample_search');
    const resLens = await kibanaServer.savedObjects.get({
      type: 'lens',
      id: 'sample_lens',
    });
    expect(resLens.id).equal('sample_lens');
    const resMlModule = await kibanaServer.savedObjects.get({
      type: 'ml-module',
      id: 'sample_ml_module',
    });
    expect(resMlModule.id).equal('sample_ml_module');
    const resSecurityRule = await kibanaServer.savedObjects.get({
      type: 'security-rule',
      id: 'sample_security_rule',
    });
    expect(resSecurityRule.id).equal('sample_security_rule');
    const resOsqueryPackAsset = await kibanaServer.savedObjects.get({
      type: 'osquery-pack-asset',
      id: 'sample_osquery_pack_asset',
    });
    expect(resOsqueryPackAsset.id).equal('sample_osquery_pack_asset');
    const resOsquerySavedObject = await kibanaServer.savedObjects.get({
      type: 'osquery-saved-query',
      id: 'sample_osquery_saved_query',
    });
    expect(resOsquerySavedObject.id).equal('sample_osquery_saved_query');
    const resCloudSecurityPostureRuleTemplate = await kibanaServer.savedObjects.get({
      type: 'csp-rule-template',
      id: 'sample_csp_rule_template',
    });
    expect(resCloudSecurityPostureRuleTemplate.id).equal('sample_csp_rule_template');
    const resTag = await kibanaServer.savedObjects.get({
      type: 'tag',
      id: 'sample_tag',
    });
    expect(resTag.id).equal('sample_tag');
    const resIndexPattern = await kibanaServer.savedObjects.get({
      type: 'index-pattern',
      id: 'test-*',
    });
    expect(resIndexPattern.id).equal('test-*');

    let resInvalidTypeIndexPattern;
    try {
      resInvalidTypeIndexPattern = await kibanaServer.savedObjects.get({
        type: 'invalid-type',
        id: 'invalid',
      });
    } catch (err) {
      checkErrorWithResponseDataOrThrow(err);
      resInvalidTypeIndexPattern = err;
    }
    expect(resInvalidTypeIndexPattern.response.data.statusCode).equal(404);
  });
  it('should not add fields to the index patterns', async () => {
    const resIndexPatternLogs = await kibanaServer.savedObjects.get({
      type: 'index-pattern',
      id: 'logs-*',
    });
    const logsAttributes = resIndexPatternLogs.attributes;
    expect(logsAttributes.fields).to.be(undefined);
    const resIndexPatternMetrics = await kibanaServer.savedObjects.get({
      type: 'index-pattern',
      id: 'metrics-*',
    });
    const metricsAttributes = resIndexPatternMetrics.attributes;
    expect(metricsAttributes.fields).to.be(undefined);
  });
  it('should have created the correct saved object', async function () {
    const res = await kibanaServer.savedObjects.get({
      type: 'epm-packages',
      id: pkgName,
    });
    // during a reinstall the items can change
    const sortedRes = {
      ...res.attributes,
      // verification_key_id can be null or undefined for install or reinstall cases,
      // kbn/expect only does strict equality so undefined is normalised to null
      verification_key_id:
        res.attributes.verification_key_id === undefined
          ? null
          : res.attributes.verification_key_id,
      installed_kibana: sortBy(res.attributes.installed_kibana, (o: AssetReference) => o.type),
      installed_es: sortBy(res.attributes.installed_es, (o: AssetReference) => o.type),
      package_assets: sortBy(res.attributes.package_assets, (o: AssetReference) => o.type),
    };

    expect(sortedRes).eql({
      installed_kibana: [
        {
          id: 'sample_csp_rule_template',
          type: 'csp-rule-template',
        },
        {
          id: 'sample_dashboard',
          type: 'dashboard',
        },
        {
          id: 'sample_dashboard2',
          type: 'dashboard',
        },
        {
          id: 'test-*',
          type: 'index-pattern',
        },
        {
          id: 'sample_lens',
          type: 'lens',
        },
        {
          id: 'sample_ml_module',
          type: 'ml-module',
        },
        {
          id: 'sample_osquery_pack_asset',
          type: 'osquery-pack-asset',
        },
        {
          id: 'sample_osquery_saved_query',
          type: 'osquery-saved-query',
        },
        {
          id: 'sample_search',
          type: 'search',
        },
        {
          id: 'sample_security_rule',
          type: 'security-rule',
        },
        {
          id: 'sample_tag',
          type: 'tag',
        },
        {
          id: 'sample_visualization',
          type: 'visualization',
        },
      ],
      installed_kibana_space_id: 'default',
      installed_es: [
        { id: 'logs-input_only_all_assets.logs-1.0.0', type: 'ingest_pipeline' },
        { id: 'default', type: 'ml_model' },
      ],
      package_assets: [
        {
          id: '11fd4a5b-cded-5aad-9ec3-ece6fce81ae1',
          type: 'epm-packages-assets',
        },
        {
          id: '60e4f012-97de-5642-81ce-fdc545b67cd2',
          type: 'epm-packages-assets',
        },
        {
          id: '86ef2be0-09ff-55b0-8bc3-63c72762bb32',
          type: 'epm-packages-assets',
        },
        {
          id: 'f0997c0a-1518-5041-b269-d5012ee0cfab',
          type: 'epm-packages-assets',
        },
        {
          id: '2837efe1-a22a-598b-8e0b-0449ccf1ddf9',
          type: 'epm-packages-assets',
        },
        {
          id: 'e9d297a2-4d85-5ee6-8b30-249bd3155055',
          type: 'epm-packages-assets',
        },
        {
          id: 'c7b6ccd5-9656-5399-a437-775c0bc455fe',
          type: 'epm-packages-assets',
        },
        {
          id: 'a5668083-e9ad-5e91-9f84-dddbe9b6be11',
          type: 'epm-packages-assets',
        },
        {
          id: 'efb052ec-31e6-571f-8df4-bee462498bdf',
          type: 'epm-packages-assets',
        },
        {
          id: '03be9591-e050-5a23-9ad5-996e5754e819',
          type: 'epm-packages-assets',
        },
        {
          id: '2c638210-7f05-5997-bb2e-526be1b17d11',
          type: 'epm-packages-assets',
        },
        {
          id: 'c28defca-752f-5fb8-906d-e26d57e3ff9a',
          type: 'epm-packages-assets',
        },
        {
          id: '4b58df1e-038d-5121-aee6-fe8d8cfb7d29',
          type: 'epm-packages-assets',
        },
        {
          id: '9e45e05b-684d-5e5c-8bde-b06c45208d5f',
          type: 'epm-packages-assets',
        },
        {
          id: 'cfe3c3ed-4373-54a5-ad45-b37370b63e51',
          type: 'epm-packages-assets',
        },
        {
          id: '42641760-e59d-5c9a-be2e-db9a355d093d',
          type: 'epm-packages-assets',
        },
        {
          id: '51f2b160-2453-59b2-a2ce-ab248ab6cf93',
          type: 'epm-packages-assets',
        },
        {
          id: '259e9e76-7925-5344-95c6-2f6a3026d30f',
          type: 'epm-packages-assets',
        },
        {
          id: '6e5578af-d0d8-5734-bf20-5dfc26124e5e',
          type: 'epm-packages-assets',
        },
        {
          id: '6394a37b-6441-5567-8ec2-8adfecbb75c4',
          type: 'epm-packages-assets',
        },
        {
          id: 'dd6c8e81-5d8e-5975-8e12-d60f640d1245',
          type: 'epm-packages-assets',
        },
      ],
      es_index_patterns: {},
      name: pkgName,
      version: pkgVersion,
      install_version: pkgVersion,
      install_status: 'installed',
      install_started_at: res.attributes.install_started_at,
      install_source: 'registry',
      install_format_schema_version: FLEET_INSTALL_FORMAT_VERSION,
      verification_status: 'unknown',
      verification_key_id: null,
    });
  });
};
