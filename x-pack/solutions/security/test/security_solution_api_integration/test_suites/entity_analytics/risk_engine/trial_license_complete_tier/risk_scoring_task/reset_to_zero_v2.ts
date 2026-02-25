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
  deleteAllEntityStoreEntities,
  normalizeScores,
  readRiskScores,
  riskEngineRouteHelpersFactory,
  waitForRiskScoresToBePresent,
  enableEntityStoreV2,
  disableEntityStoreV2,
  entityStoreV2RouteHelpersFactory,
  getEntitiesById,
  getEntityRisk,
  waitForEntityStoreFieldValues,
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
  const entityStoreRoutes = entityStoreV2RouteHelpersFactory(supertest, es);
  const { indexListOfDocuments } = dataGeneratorFactory({
    es,
    index: 'ecs_compliant',
    log,
  });

  const deleteAlertsForHosts = async (hosts: string[]) => {
    await es.deleteByQuery({
      index: '.alerts-security.alerts-*',
      query: {
        bool: { filter: [{ terms: { 'host.name': hosts } }] },
      },
    });
  };

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
      await entityStoreRoutes.uninstall({ cleanIndices: true });
      await entityStoreRoutes.install();

      await Promise.all([
        riskEngineRoutes.cleanUp(),
        deleteAllRiskScores(log, es, undefined, true),
        deleteAllEntityStoreEntities(log, es),
        deleteAllAlerts(supertest, log, es),
        deleteAllRules(supertest, log),
      ]);

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
      await Promise.all([
        riskEngineRoutes.cleanUp(),
        deleteAllRiskScores(log, es, undefined, true),
        entityStoreRoutes.uninstall(),
        deleteAllEntityStoreEntities(log, es),
        deleteAllAlerts(supertest, log, es),
        deleteAllRules(supertest, log),
      ]);
      await disableEntityStoreV2(kibanaServer);
    });

    it('@skipInServerlessMKI resets risk scores to zero for entities whose alerts were deleted and propagates to entity store', async () => {
      const initialScores = normalizeScores(await readRiskScores(es));
      expect(initialScores.length).to.eql(10);
      expect(initialScores.every((score) => (score.calculated_score_norm ?? 0) > 0)).to.eql(true);

      await deleteAlertsForHosts(hostsWithDeletedAlerts);

      await riskEngineRoutes.scheduleNow();

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

      // Verify the zero scores propagated to the entity store
      await entityStoreRoutes.forceLogExtraction(['host']);

      const allEntityIds = Array(10)
        .fill(0)
        .map((_, index) => `host:host-${index}`);

      const expectedZeroValues = hostsWithDeletedAlerts.reduce<Record<string, number>>(
        (acc, host) => {
          acc[`host:${host}`] = 0;
          return acc;
        },
        {}
      );

      await waitForEntityStoreFieldValues({
        es,
        log,
        entityIds: allEntityIds,
        fieldName: 'entity.risk.calculated_score_norm',
        expectedValuesByEntityId: expectedZeroValues,
      });

      const entities = await getEntitiesById({ es, entityIds: allEntityIds });
      expect(entities.length).to.eql(10);

      const riskByEntityId = entities.reduce<Record<string, number | undefined>>((acc, entity) => {
        const entityId = entity['entity.id'];
        if (typeof entityId === 'string') {
          acc[entityId] = getEntityRisk(entity)?.calculated_score_norm;
        }
        return acc;
      }, {});

      hostsWithDeletedAlerts.forEach((host) => {
        expect(riskByEntityId[`host:${host}`]).to.eql(0);
      });

      expectedNonZeroIds.forEach((id) => {
        expect((riskByEntityId[id] ?? 0) > 0).to.eql(true);
      });
    });
  });
};
