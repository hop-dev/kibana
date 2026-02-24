/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { v4 as uuidv4 } from 'uuid';
import { deleteAllRules, deleteAllAlerts } from '@kbn/detections-response-ftr-services';
import { dataGeneratorFactory } from '../../../../detections_response/utils';
import {
  buildDocument,
  createAndSyncRuleAndAlertsFactory,
  deleteAllRiskScores,
  normalizeScores,
  readRiskScores,
  riskEngineRouteHelpersFactory,
  waitForRiskScoresToBePresent,
  enableEntityStoreV2,
  disableEntityStoreV2,
} from '../../../utils';
import type { FtrProviderContext } from '../../../../../ftr_provider_context';

export default ({ getService }: FtrProviderContext): void => {
  const supertest = getService('supertest');
  const esArchiver = getService('esArchiver');
  const es = getService('es');
  const log = getService('log');
  const kibanaServer = getService('kibanaServer');

  const createAndSyncRuleAndAlerts = createAndSyncRuleAndAlertsFactory({ supertest, log });
  const riskEngineRoutes = riskEngineRouteHelpersFactory(supertest);
  const { indexListOfDocuments } = dataGeneratorFactory({
    es,
    index: 'ecs_compliant',
    log,
  });

  describe('@ess @serverless @serverlessQA Risk Scoring Task Reset To Zero - V2 (id-based)', () => {
    const hostsWithDeletedAlerts = Array(5)
      .fill(0)
      .map((_, index) => `host-${index + 5}`);

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
      await enableEntityStoreV2(kibanaServer);
      await riskEngineRoutes.cleanUp();
      await deleteAllRiskScores(log, es, undefined, true);
      await deleteAllAlerts(supertest, log, es);
      await deleteAllRules(supertest, log);

      const documentId = uuidv4();
      await indexListOfDocuments(
        Array(10)
          .fill(0)
          .map((_, index) => buildDocument({ host: { name: `host-${index}` } }, documentId))
      );

      await createAndSyncRuleAndAlerts({
        query: `id: ${documentId}`,
        alerts: 10,
        riskScore: 40,
      });

      await riskEngineRoutes.init();
      await waitForRiskScoresToBePresent({ es, log, scoreCount: 10 });
    });

    afterEach(async () => {
      await riskEngineRoutes.cleanUp();
      await deleteAllRiskScores(log, es, undefined, true);
      await deleteAllAlerts(supertest, log, es);
      await deleteAllRules(supertest, log);
      await disableEntityStoreV2(kibanaServer);
    });

    it('@skipInServerlessMKI resets risk scores to zero for entities whose alerts were deleted', async () => {
      const initialScores = normalizeScores(await readRiskScores(es));
      expect(initialScores.length).to.eql(10);
      expect(initialScores.every((score) => (score.calculated_score_norm ?? 0) > 0)).to.eql(true);

      await es.deleteByQuery({
        index: '.alerts-security.alerts-*',
        query: {
          bool: {
            filter: [{ terms: { 'host.name': hostsWithDeletedAlerts } }],
          },
        },
        refresh: true,
      });

      await riskEngineRoutes.disable();
      await riskEngineRoutes.enable();
      await waitForRiskScoresToBePresent({ es, log, scoreCount: 20 });

      const allScores = normalizeScores(await readRiskScores(es));

      const zeroScoreIds = allScores
        .filter((score) => score.calculated_score_norm === 0)
        .map((score) => score.id_value)
        .sort();

      expect(zeroScoreIds).to.eql(hostsWithDeletedAlerts.map((host) => `host:${host}`).sort());

      const nonZeroCountByEntity = allScores
        .filter((score) => (score.calculated_score_norm ?? 0) > 0)
        .reduce<Record<string, number>>((acc, score) => {
          const id = score.id_value;
          if (typeof id === 'string') {
            acc[id] = (acc[id] ?? 0) + 1;
          }
          return acc;
        }, {});

      const expectedNonZeroIds = Array(5)
        .fill(0)
        .map((_, index) => `host:host-${index}`);

      expectedNonZeroIds.forEach((id) => {
        expect(nonZeroCountByEntity[id]).to.eql(2);
      });
    });
  });
};
