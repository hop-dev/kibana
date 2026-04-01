/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { v4 as uuidv4 } from 'uuid';
import { deleteAllAlerts, deleteAllRules } from '@kbn/detections-response-ftr-services';
import {
  createAndSyncRuleAndAlertsFactory,
  readRiskScores,
  normalizeScores,
  EntityStoreUtils,
  entityMaintainerRouteHelpersFactory,
  waitForMaintainerRun,
  cleanUpRiskScoreMaintainer,
  riskScoreMaintainerScenarioFactory,
  riskScoreMaintainerEntityBuilders,
  indexListOfDocumentsFactory,
  waitForEntityStoreEntities,
  waitForRiskScoresToBePresent,
} from '../../utils';
import type { FtrProviderContext } from '../../../../ftr_provider_context';

export default ({ getService }: FtrProviderContext): void => {
  const supertest = getService('supertest');
  const es = getService('es');
  const log = getService('log');
  const retry = getService('retry');
  const testLogsIndex = 'logs-testlogs-default';
  const testLogsTemplate = 'logs-testlogs-default-template';
  const createAndSyncRuleAndAlerts = createAndSyncRuleAndAlertsFactory({
    supertest,
    log,
    indices: [testLogsIndex],
  });
  const entityStoreUtils = EntityStoreUtils(getService);
  const maintainerRoutes = entityMaintainerRouteHelpersFactory(supertest);

  describe('@ess @serverless @serverlessQA Risk Score Maintainer Resolution Scoring', function () {
    this.tags(['esGate']);

    context('with test log data', () => {
      const indexListOfDocuments = indexListOfDocumentsFactory({ es, log, index: testLogsIndex });
      const maintainerScenario = riskScoreMaintainerScenarioFactory({
        indexListOfDocuments,
        createAndSyncRuleAndAlerts,
        entityStoreUtils,
        retry,
        routes: maintainerRoutes,
      });

      before(async () => {
        await es.indices.deleteIndexTemplate({ name: testLogsTemplate }, { ignore: [404] });
        await es.indices.putIndexTemplate({
          name: testLogsTemplate,
          index_patterns: [testLogsIndex],
          data_stream: {},
          template: {
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                data_stream: {
                  properties: {
                    type: { type: 'keyword' },
                    dataset: { type: 'keyword' },
                    namespace: { type: 'keyword' },
                  },
                },
                event: {
                  properties: {
                    kind: { type: 'keyword' },
                    category: { type: 'keyword' },
                    type: { type: 'keyword' },
                    outcome: { type: 'keyword' },
                    module: { type: 'keyword' },
                  },
                },
                user: {
                  properties: {
                    id: { type: 'keyword' },
                    name: { type: 'keyword' },
                    email: { type: 'keyword' },
                    domain: { type: 'keyword' },
                  },
                },
              },
            },
          },
        });
        await es.indices.deleteDataStream({ name: testLogsIndex }, { ignore: [404] });
        await es.indices.createDataStream({ name: testLogsIndex });
      });

      after(async () => {
        await es.indices.deleteDataStream({ name: testLogsIndex }, { ignore: [404] });
        await es.indices.deleteIndexTemplate({ name: testLogsTemplate }, { ignore: [404] });
      });

      beforeEach(async () => {
        await es.deleteByQuery({
          index: testLogsIndex,
          query: { match_all: {} },
          refresh: true,
          ignore_unavailable: true,
        });
        await entityStoreUtils.cleanEngines();
        await cleanUpRiskScoreMaintainer({ log, es });
        await deleteAllAlerts(supertest, log, es);
        await deleteAllRules(supertest, log);
      });

      afterEach(async () => {
        await entityStoreUtils.cleanEngines();
        await cleanUpRiskScoreMaintainer({ log, es });
        await deleteAllAlerts(supertest, log, es);
        await deleteAllRules(supertest, log);
      });

      it('writes base and resolution scores for a resolved user pair', async () => {
        const targetUserName = `resolved-target-${uuidv4().slice(0, 8)}`;
        const aliasUserName = `resolved-alias-${uuidv4().slice(0, 8)}`;
        const { documentIds, testEntities } = await maintainerScenario.seedEntities([
          riskScoreMaintainerEntityBuilders.idpUser({ userName: targetUserName }),
          riskScoreMaintainerEntityBuilders.idpUser({ userName: aliasUserName }),
        ]);
        const [targetUser, aliasUser] = testEntities;

        await maintainerScenario.createAlertsForDocumentIds({
          documentIds,
          alerts: 2,
          riskScore: 40,
        });

        await entityStoreUtils.installEntityStoreV2({
          entityTypes: ['user', 'host'],
          dataViewPattern: testLogsIndex,
        });
        await waitForEntityStoreEntities({ es, log, count: 2 });

        await maintainerScenario.setEntityResolutionTarget({
          testEntity: aliasUser,
          resolvedToEntityId: targetUser.expectedEuid,
        });

        await retry.waitForWithTimeout(
          `resolution relationship materialized for ${aliasUser.expectedEuid}`,
          30_000,
          async () => {
            const entityResponse = await es.search({
              index: '.entities.v2.latest.security_default',
              size: 1,
              query: { term: { 'entity.id': aliasUser.expectedEuid } },
            });
            const entityDoc = entityResponse.hits.hits[0]?._source as
              | {
                  entity?: { relationships?: { resolution?: { resolved_to?: string } } };
                }
              | undefined;
            return (
              entityDoc?.entity?.relationships?.resolution?.resolved_to === targetUser.expectedEuid
            );
          }
        );

        await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
        await waitForRiskScoresToBePresent({ es, log, scoreCount: 2 });

        const scores = normalizeScores(await readRiskScores(es));
        const targetResolutionScore = scores.find(
          (score) => score.id_value === targetUser.expectedEuid && score.score_type === 'resolution'
        );
        const aliasBaseScore = scores.find(
          (score) => score.id_value === aliasUser.expectedEuid && score.score_type === 'base'
        );

        expect(aliasBaseScore).to.not.be(undefined);
        expect(targetResolutionScore).to.not.be(undefined);
        expect(targetResolutionScore!.calculated_score_norm).to.be.greaterThan(0);
        expect(targetResolutionScore!.related_entities).to.be.an('array');
        expect(
          targetResolutionScore!.related_entities?.some(
            (related) =>
              related.entity_id === aliasUser.expectedEuid &&
              related.relationship_type === 'entity.relationships.resolution.resolved_to'
          )
        ).to.be(true);

        await retry.waitForWithTimeout(
          `entity store resolution risk present for ${targetUser.expectedEuid}`,
          30_000,
          async () => {
            const entityResponse = await es.search({
              index: '.entities.v2.latest.security_default',
              size: 1,
              query: { term: { 'entity.id': targetUser.expectedEuid } },
            });
            const entityDoc = entityResponse.hits.hits[0]?._source as
              | {
                  entity?: {
                    relationships?: {
                      resolution?: {
                        risk?: { calculated_score_norm?: number };
                      };
                    };
                  };
                }
              | undefined;
            return (
              (entityDoc?.entity?.relationships?.resolution?.risk?.calculated_score_norm ?? 0) > 0
            );
          }
        );

        const lookupResponse = await es.search({
          index: '.entity_analytics.risk_score.lookup-default',
          size: 20,
          query: {
            terms: {
              entity_id: [aliasUser.expectedEuid, targetUser.expectedEuid],
            },
          },
        });
        const lookupDocs = lookupResponse.hits.hits.map(
          (hit) => hit._source as Record<string, string>
        );
        expect(
          lookupDocs.some(
            (doc) =>
              doc.entity_id === aliasUser.expectedEuid &&
              doc.resolution_target_id === targetUser.expectedEuid &&
              doc.relationship_type === 'entity.relationships.resolution.resolved_to'
          )
        ).to.be(true);
        expect(
          lookupDocs.some(
            (doc) =>
              doc.entity_id === targetUser.expectedEuid &&
              doc.resolution_target_id === targetUser.expectedEuid &&
              doc.relationship_type === 'self'
          )
        ).to.be(true);
      });

      it('does not write resolution scores when no resolution relationships exist', async () => {
        const userName = `no-resolution-${uuidv4().slice(0, 8)}`;
        const { documentIds, testEntities } = await maintainerScenario.seedEntities([
          riskScoreMaintainerEntityBuilders.idpUser({ userName }),
        ]);
        const [user] = testEntities;

        await maintainerScenario.createAlertsForDocumentIds({
          documentIds,
          alerts: 1,
          riskScore: 35,
        });
        await maintainerScenario.installAndRunMaintainer({ dataViewPattern: testLogsIndex });
        await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

        const scores = normalizeScores(await readRiskScores(es)).filter(
          (score) => score.id_value === user.expectedEuid
        );
        expect(scores.some((score) => score.score_type === 'resolution')).to.be(false);
      });
    });
  });
};
