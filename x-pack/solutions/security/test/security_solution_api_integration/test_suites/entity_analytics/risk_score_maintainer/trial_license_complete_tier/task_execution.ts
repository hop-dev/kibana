/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { v4 as uuidv4 } from 'uuid';
import { deleteAllRules, deleteAllAlerts } from '@kbn/detections-response-ftr-services';
import { dataGeneratorFactory } from '../../../detections_response/utils';
import {
  buildDocument,
  createAndSyncRuleAndAlertsFactory,
  readRiskScores,
  waitForRiskScoresToBePresent,
  normalizeScores,
  EntityStoreUtils,
  entityMaintainerRouteHelpersFactory,
  waitForMaintainerRun,
  cleanUpRiskScoreMaintainer,
  assetCriticalityRouteHelpersFactory,
  cleanAssetCriticality,
  waitForAssetCriticalityToBePresent,
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

  describe('@ess @serverless @serverlessQA Risk Score Maintainer Task Execution', () => {
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

      describe('with some alerts containing hosts', () => {
        let documentId: string;

        beforeEach(async () => {
          documentId = uuidv4();
          const baseEvent = buildDocument({ host: { name: 'host-1' } }, documentId);
          await indexListOfDocuments(
            Array(10)
              .fill(baseEvent)
              .map((_baseEvent, index) => ({
                ..._baseEvent,
                'host.name': `host-${index}`,
              }))
          );

          await createAndSyncRuleAndAlerts({
            query: `id: ${documentId}`,
            alerts: 10,
            riskScore: 40,
          });
        });

        describe('installing entity store v2 with maintainer', () => {
          beforeEach(async () => {
            await entityStoreUtils.installEntityStoreV2();
            await waitForMaintainerRun({ retry, routes: maintainerRoutes });
          });

          it('@skipInServerlessMKI calculates and persists risk scores for alert documents', async () => {
            await waitForRiskScoresToBePresent({ es, log, scoreCount: 10 });

            const scores = await readRiskScores(es);
            const normalized = normalizeScores(scores);
            expect(normalized.length).to.eql(10);

            const idValues = normalized.map(({ id_value: idValue }) => idValue).sort();
            // In the maintainer pipeline, id_value is the EUID (e.g., 'host:host-0')
            const expectedEuids = Array(10)
              .fill(0)
              .map((_, index) => `host:host-${index}`)
              .sort();
            expect(idValues).to.eql(expectedEuids);
          });

          describe('@skipInServerlessMKI stopping and re-starting the maintainer', () => {
            beforeEach(async () => {
              await waitForRiskScoresToBePresent({ es, log, scoreCount: 10 });
              await maintainerRoutes.stopMaintainer('risk-score');
              await maintainerRoutes.startMaintainer('risk-score');
            });

            it('calculates another round of scores after restart', async () => {
              await waitForRiskScoresToBePresent({ es, log, scoreCount: 20 });

              const scores = await readRiskScores(es);
              expect(scores.length).to.be.greaterThan(10);

              const expectedEuids = Array(10)
                .fill(0)
                .map((_, index) => `host:host-${index}`);
              const actualIds = normalizeScores(scores).map(({ id_value: idValue }) => idValue);

              expect(actualIds.sort()).to.eql([...expectedEuids, ...expectedEuids].sort());
            });
          });

          describe('@skipInServerlessMKI triggering a manual run', () => {
            it('produces additional risk scores', async () => {
              await waitForRiskScoresToBePresent({ es, log, scoreCount: 10 });
              await maintainerRoutes.runMaintainer('risk-score');
              await waitForRiskScoresToBePresent({ es, log, scoreCount: 20 });

              const scores = await readRiskScores(es);
              expect(scores.length).to.be.greaterThan(10);
            });
          });
        });
      });

      describe('with some alerts containing hosts and others containing users', () => {
        let hostId: string;
        let userId: string;

        beforeEach(async () => {
          hostId = uuidv4();
          const hostEvent = buildDocument({ host: { name: 'host-1' } }, hostId);
          await indexListOfDocuments(
            Array(10)
              .fill(hostEvent)
              .map((event, index) => ({
                ...event,
                'host.name': `host-${index}`,
              }))
          );

          userId = uuidv4();
          const userEvent = buildDocument(
            {
              user: { name: 'user-1' },
              event: { kind: ['asset'], category: ['iam'], type: ['user'] },
            },
            userId
          );
          await indexListOfDocuments(
            Array(10)
              .fill(userEvent)
              .map((event, index) => ({
                ...event,
                'user.name': `user-${index}`,
              }))
          );

          await createAndSyncRuleAndAlerts({
            query: `id: ${userId} or id: ${hostId}`,
            alerts: 20,
            riskScore: 40,
          });
        });

        it('@skipInServerlessMKI calculates and persists risk scores for both types of entities', async () => {
          await entityStoreUtils.installEntityStoreV2();
          await waitForMaintainerRun({ retry, routes: maintainerRoutes });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 20 });

          const riskScores = await readRiskScores(es);
          expect(riskScores.length).to.be.greaterThan(0);

          const scoredIds = normalizeScores(riskScores).map(({ id_value: idValue }) => idValue);
          // Both host: and user: prefixed EUIDs should be present
          expect(scoredIds.some((id) => id?.startsWith('host:'))).to.be(true);
          expect(scoredIds.some((id) => id?.startsWith('user:'))).to.be(true);
        });

        context('@skipInServerless with asset criticality data', () => {
          const assetCriticalityRoutes = assetCriticalityRouteHelpersFactory(supertest);

          beforeEach(async () => {
            await assetCriticalityRoutes.upsert({
              id_field: 'host.name',
              id_value: 'host-1',
              criticality_level: 'extreme_impact',
            });
          });

          afterEach(async () => {
            await cleanAssetCriticality({ log, es });
          });

          it('calculates risk scores with asset criticality data', async () => {
            await waitForAssetCriticalityToBePresent({ es, log });
            await entityStoreUtils.installEntityStoreV2();
            await waitForMaintainerRun({ retry, routes: maintainerRoutes });
            await waitForRiskScoresToBePresent({ es, log, scoreCount: 20 });

            const riskScores = await readRiskScores(es);
            expect(riskScores.length).to.be.greaterThan(0);

            // At least one score should have criticality applied
            const assetCriticalityLevels = riskScores.map(
              (riskScore) => riskScore.host?.risk.criticality_level
            );
            const assetCriticalityModifiers = riskScores.map(
              (riskScore) => riskScore.host?.risk.criticality_modifier
            );

            expect(assetCriticalityLevels).to.contain('extreme_impact');
            expect(assetCriticalityModifiers).to.contain(2);
          });
        });
      });
    });
  });
};
