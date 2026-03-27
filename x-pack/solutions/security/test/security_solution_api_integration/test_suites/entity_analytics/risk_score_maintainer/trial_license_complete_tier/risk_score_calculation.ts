/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { v4 as uuidv4 } from 'uuid';
import { deleteAllAlerts, deleteAllRules } from '@kbn/detections-response-ftr-services';
import { dataGeneratorFactory } from '../../../detections_response/utils';
import {
  buildDocument,
  createAndSyncRuleAndAlertsFactory,
  readRiskScores,
  normalizeScores,
  waitForRiskScoresToBePresent,
  EntityStoreUtils,
  entityMaintainerRouteHelpersFactory,
  waitForMaintainerRun,
  cleanUpRiskScoreMaintainer,
  sanitizeScores,
  assetCriticalityRouteHelpersFactory,
  cleanAssetCriticality,
  waitForAssetCriticalityToBePresent,
  watchlistRouteHelpersFactory,
} from '../../utils';
import type { FtrProviderContext } from '../../../../ftr_provider_context';

export default ({ getService }: FtrProviderContext): void => {
  const supertest = getService('supertest');
  const esArchiver = getService('esArchiver');
  const es = getService('es');
  const log = getService('log');
  const retry = getService('retry');
  const createAndSyncRuleAndAlerts = createAndSyncRuleAndAlertsFactory({ supertest, log });
  const entityStoreUtils = EntityStoreUtils(getService);
  const maintainerRoutes = entityMaintainerRouteHelpersFactory(supertest);

  describe('@ess @serverless @serverlessQA Risk Score Maintainer Entity Calculation', function () {
    this.tags(['esGate']);

    context('with auditbeat data', () => {
      const { indexListOfDocuments } = dataGeneratorFactory({
        es,
        index: 'ecs_compliant',
        log,
      });

      before(async () => {
        await esArchiver.load(
          'x-pack/solutions/security/test/fixtures/es_archives/security_solution/ecs_compliant'
        );
      });

      after(async () => {
        await esArchiver.unload(
          'x-pack/solutions/security/test/fixtures/es_archives/security_solution/ecs_compliant'
        );
      });

      beforeEach(async () => {
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

      it('calculates and persists risk score for a single host entity', async () => {
        const documentId = uuidv4();
        await indexListOfDocuments([buildDocument({ host: { name: 'host-1' } }, documentId)]);
        await createAndSyncRuleAndAlerts({
          query: `id: ${documentId}`,
          alerts: 1,
          riskScore: 21,
        });

        await entityStoreUtils.installEntityStoreV2();
        await waitForMaintainerRun({ retry, routes: maintainerRoutes });
        await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

        const scores = await readRiskScores(es);
        const [score] = sanitizeScores(normalizeScores(scores));

        expect(score.calculated_level).to.eql('Unknown');
        expect(score.calculated_score).to.eql(21);
        expect(score.calculated_score_norm).to.be.within(8.1006017, 8.100602);
        expect(score.category_1_score).to.be.within(8.1006017, 8.100602);
        expect(score.category_1_count).to.eql(1);
        // In the maintainer pipeline, id_value is the EUID
        expect(score.id_value).to.eql('host:host-1');
      });

      it('calculates risk scores for hosts and users together', async () => {
        const hostDocId = uuidv4();
        const userDocId = uuidv4();
        await indexListOfDocuments([
          buildDocument({ host: { name: 'host-1' } }, hostDocId),
          buildDocument({ user: { name: 'user-1' } }, userDocId),
        ]);
        await createAndSyncRuleAndAlerts({
          query: `id: ${hostDocId} or id: ${userDocId}`,
          alerts: 2,
          riskScore: 21,
        });

        await entityStoreUtils.installEntityStoreV2();
        await waitForMaintainerRun({ retry, routes: maintainerRoutes });
        await waitForRiskScoresToBePresent({ es, log, scoreCount: 2 });

        const scores = await readRiskScores(es);
        const normalized = normalizeScores(scores);
        const idValues = normalized.map(({ id_value: idValue }) => idValue).sort();

        expect(idValues).to.contain('host:host-1');
        expect(idValues).to.contain('user:user-1');
      });

      describe('@skipInServerless with asset criticality data', () => {
        const assetCriticalityRoutes = assetCriticalityRouteHelpersFactory(supertest);

        afterEach(async () => {
          await cleanAssetCriticality({ log, es });
        });

        it('calculates risk scores with criticality modifiers', async () => {
          const documentId = uuidv4();
          await indexListOfDocuments([buildDocument({ host: { name: 'host-1' } }, documentId)]);

          await assetCriticalityRoutes.upsert({
            id_field: 'host.name',
            id_value: 'host-1',
            criticality_level: 'high_impact',
          });

          await waitForAssetCriticalityToBePresent({ es, log });
          await createAndSyncRuleAndAlerts({
            query: `id: ${documentId}`,
            alerts: 1,
            riskScore: 21,
          });

          await entityStoreUtils.installEntityStoreV2();
          await waitForMaintainerRun({ retry, routes: maintainerRoutes });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

          const scores = await readRiskScores(es);
          const [score] = sanitizeScores(normalizeScores(scores));

          expect(score.criticality_level).to.eql('high_impact');
          expect(score.criticality_modifier).to.eql(1.5);
          expect(score.calculated_level).to.eql('Unknown');
          expect(score.calculated_score).to.eql(21);
          expect(score.calculated_score_norm).to.be.within(11.677912, 11.6779121);
          expect(score.category_1_score).to.be.within(8.1006017, 8.100602);
          expect(score.category_1_count).to.eql(1);
          expect(score.id_value).to.eql('host:host-1');
        });

        it('ignores deleted asset criticality when calculating scores', async () => {
          const documentId = uuidv4();
          await indexListOfDocuments([buildDocument({ host: { name: 'host-1' } }, documentId)]);

          await assetCriticalityRoutes.upsert({
            id_field: 'host.name',
            id_value: 'host-1',
            criticality_level: 'high_impact',
          });
          await assetCriticalityRoutes.delete('host.name', 'host-1');
          await waitForAssetCriticalityToBePresent({ es, log });

          await createAndSyncRuleAndAlerts({
            query: `id: ${documentId}`,
            alerts: 1,
            riskScore: 21,
          });

          await entityStoreUtils.installEntityStoreV2();
          await waitForMaintainerRun({ retry, routes: maintainerRoutes });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

          const scores = await readRiskScores(es);
          const [score] = sanitizeScores(normalizeScores(scores));

          expect(score.criticality_level).to.be(undefined);
          expect(score.criticality_modifier).to.be(undefined);
          expect(score.calculated_score_norm).to.be.within(8.1006017, 8.100602);
          expect(score.id_value).to.eql('host:host-1');
        });
      });

      describe('@skipInServerless with watchlist modifier data', () => {
        const watchlistRoutes = watchlistRouteHelpersFactory(supertest);

        afterEach(async () => {
          const listResponse = await watchlistRoutes.list();
          for (const watchlist of listResponse.body) {
            if (watchlist.id) {
              await watchlistRoutes.delete(watchlist.id);
            }
          }
        });

        it('calculates risk scores with watchlist modifiers', async () => {
          const documentId = uuidv4();
          await indexListOfDocuments([buildDocument({ user: { name: 'user-1' } }, documentId)]);

          await createAndSyncRuleAndAlerts({
            query: `id: ${documentId}`,
            alerts: 1,
            riskScore: 21,
          });

          // Create a watchlist with a custom riskModifier
          const createResponse = await watchlistRoutes.create({
            name: 'high-risk-vendors',
            riskModifier: 1.8,
          });
          const watchlistId = createResponse.body.id!;

          await entityStoreUtils.installEntityStoreV2();
          await waitForMaintainerRun({ retry, routes: maintainerRoutes });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

          // Get base risk score (no watchlist modifier yet)
          const baseScores = await readRiskScores(es);
          const [baseScore] = sanitizeScores(normalizeScores(baseScores));
          const baseNormScore = baseScore.calculated_score_norm!;

          // Update the entity in the entity store to add watchlist membership
          await es.updateByQuery({
            index: '.entities.v2.latest.security_default',
            query: { term: { 'entity.id': 'user:user-1' } },
            script: {
              source: `
                if (!ctx._source.entity.containsKey('attributes')) {
                  ctx._source.entity.attributes = new HashMap();
                }
                ctx._source.entity.attributes.watchlists = params.watchlistIds;
              `,
              lang: 'painless',
              params: { watchlistIds: [watchlistId] },
            },
            refresh: true,
          });

          // Delete existing risk scores and re-run maintainer
          await cleanUpRiskScoreMaintainer({ log, es });
          await maintainerRoutes.runMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 2 });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 1 });

          const scores = await readRiskScores(es);
          const [score] = sanitizeScores(normalizeScores(scores));

          expect(score.modifiers).to.have.length(1);
          expect(score.modifiers![0].type).to.eql('watchlist');
          expect(score.modifiers![0].subtype).to.eql('high-risk-vendors');
          expect(score.modifiers![0].modifier_value).to.eql(1.8);
          expect(score.calculated_score_norm).to.be.greaterThan(baseNormScore);
          expect(score.id_value).to.eql('user:user-1');
        });
      });
    });
  });
};
