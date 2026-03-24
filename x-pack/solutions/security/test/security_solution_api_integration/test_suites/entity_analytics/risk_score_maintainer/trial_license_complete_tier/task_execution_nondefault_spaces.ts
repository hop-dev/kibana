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
  deleteAllRiskScores,
} from '../../utils';
import type { FtrProviderContext } from '../../../../ftr_provider_context';

export default ({ getService }: FtrProviderContext): void => {
  const supertest = getService('supertest');
  const esArchiver = getService('esArchiver');
  const es = getService('es');
  const log = getService('log');
  const retry = getService('retry');
  const spaces = getService('spaces');

  const waitForMaintainerRun = async (
    routes: ReturnType<typeof entityMaintainerRouteHelpersFactory>,
    minRuns: number = 1,
    maintainerId: string = 'risk-score'
  ) => {
    await retry.waitForWithTimeout(
      `Entity maintainer "${maintainerId}" to complete at least ${minRuns} run(s)`,
      120_000,
      async () => {
        const response = await routes.getMaintainers();
        const maintainer = response.body.maintainers.find(
          (m: { id: string; runs: number }) => m.id === maintainerId
        );
        return maintainer !== undefined && maintainer.runs >= minRuns;
      }
    );
  };

  describe('@ess Risk Score Maintainer in non-default space', () => {
    describe('with alerts in a non-default space', () => {
      const { indexListOfDocuments } = dataGeneratorFactory({
        es,
        index: 'ecs_compliant',
        log,
      });
      const namespace = uuidv4();
      const documentId = uuidv4();
      const index = [`risk-score.risk-score-${namespace}`];
      const createAndSyncRuleAndAlertsForOtherSpace = createAndSyncRuleAndAlertsFactory({
        supertest,
        log,
        namespace,
      });

      const entityStoreUtilsCustomSpace = EntityStoreUtils(getService, namespace);
      const maintainerRoutesCustomSpace = entityMaintainerRouteHelpersFactory(supertest, namespace);

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
        await deleteAllAlerts(supertest, log, es);
        await deleteAllRules(supertest, log);

        await spaces.create({
          id: namespace,
          name: namespace,
          disabledFeatures: [],
        });

        const baseEvent = buildDocument({ host: { name: 'host-1' } }, documentId);
        await indexListOfDocuments(
          Array(10)
            .fill(baseEvent)
            .map((_baseEvent, _index) => ({
              ..._baseEvent,
              'host.name': `host-${_index}`,
            }))
        );

        await createAndSyncRuleAndAlertsForOtherSpace({
          query: `id: ${documentId}`,
          alerts: 10,
          riskScore: 40,
        });

        await entityStoreUtilsCustomSpace.installEntityStoreV2();
        await waitForMaintainerRun(maintainerRoutesCustomSpace);
      });

      afterEach(async () => {
        await entityStoreUtilsCustomSpace.cleanEngines();
        await deleteAllRiskScores(log, es, index);
        await deleteAllAlerts(supertest, log, es);
        await deleteAllRules(supertest, log);
        await spaces.delete(namespace);
      });

      it('calculates and persists risk scores for alert documents', async () => {
        await waitForRiskScoresToBePresent({
          es,
          log,
          scoreCount: 10,
          index,
        });

        const scores = await readRiskScores(es, index);
        const normalized = normalizeScores(scores);
        expect(normalized.length).to.eql(10);

        const idValues = normalized.map(({ id_value: idValue }) => idValue).sort();
        const expectedEuids = Array(10)
          .fill(0)
          .map((_, _index) => `host:host-${_index}`)
          .sort();
        expect(idValues).to.eql(expectedEuids);
      });
    });
  });
};
