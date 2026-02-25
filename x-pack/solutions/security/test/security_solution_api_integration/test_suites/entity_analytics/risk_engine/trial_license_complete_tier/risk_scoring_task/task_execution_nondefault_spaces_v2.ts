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
  readRiskScores,
  waitForRiskScoresToBePresent,
  normalizeScores,
  riskEngineRouteHelpersFactory,
  enableEntityStoreV2,
  disableEntityStoreV2,
  entityStoreV2RouteHelpersFactory,
  getEntitiesById,
  getEntityId,
  getEntityRisk,
  waitForEntityStoreFieldValues,
} from '../../../utils';
import type { FtrProviderContextWithSpaces } from '../../../../../ftr_provider_context_with_spaces';

export default ({ getService }: FtrProviderContextWithSpaces): void => {
  const supertest = getService('supertest');
  const esArchiver = getService('esArchiver');
  const es = getService('es');
  const log = getService('log');
  const kibanaServer = getService('kibanaServer');

  describe('@ess Risk Scoring Task in non-default space - V2 (id-based)', () => {
    describe('with alerts in a non-default space', () => {
      const { indexListOfDocuments } = dataGeneratorFactory({
        es,
        index: 'ecs_compliant',
        log,
      });
      const namespace = uuidv4();
      const documentId = uuidv4();
      const index = [
        `risk-score.risk-score-${namespace}`,
        `risk-score.risk-score-latest-${namespace}`,
      ];
      const createAndSyncRuleAndAlertsForOtherSpace = createAndSyncRuleAndAlertsFactory({
        supertest,
        log,
        namespace,
      });
      const riskEngineRoutesForNamespace = riskEngineRouteHelpersFactory(supertest, namespace);
      const entityStoreRoutesForNamespace = entityStoreV2RouteHelpersFactory(
        supertest,
        es,
        namespace
      );

      before(async () => {
        await riskEngineRoutesForNamespace.cleanUp();
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

        const spaces = getService('spaces');
        await spaces.create({
          id: namespace,
          name: namespace,
          disabledFeatures: [],
        });

        await enableEntityStoreV2(kibanaServer, namespace);
        await entityStoreRoutesForNamespace.uninstall({ cleanIndices: true });
        await entityStoreRoutesForNamespace.install();

        await indexListOfDocuments(
          Array(10)
            .fill(0)
            .map((_, _index) => buildDocument({ host: { name: `host-${_index}` } }, documentId))
        );

        await createAndSyncRuleAndAlertsForOtherSpace({
          query: `id: ${documentId}`,
          alerts: 10,
          riskScore: 40,
        });

        await riskEngineRoutesForNamespace.init();
      });

      afterEach(async () => {
        await entityStoreRoutesForNamespace.uninstall();
        await deleteAllEntityStoreEntities(log, es, namespace);
        await disableEntityStoreV2(kibanaServer, namespace);
        await riskEngineRoutesForNamespace.cleanUp();
        await deleteAllRiskScores(log, es, index, true);
        await deleteAllAlerts(supertest, log, es);
        await deleteAllRules(supertest, log);
        await getService('spaces').delete(namespace);
      });

      it('calculates and persists risk scores for alert documents and propagates to entity store', async () => {
        await waitForRiskScoresToBePresent({
          es,
          log,
          scoreCount: 10,
          index,
        });

        const scores = await readRiskScores(es, index);
        const expectedIds = Array(10)
          .fill(0)
          .map((_, _index) => `host:host-${_index}`)
          .sort();

        expect(
          normalizeScores(scores)
            .map(({ id_value: idValue }) => idValue)
            .sort()
        ).to.eql(expectedIds);

        // Verify scores propagated to the entity store in this namespace
        await entityStoreRoutesForNamespace.forceLogExtraction();
        await waitForEntityStoreFieldValues({
          es,
          log,
          entityIds: expectedIds,
          namespace,
          fieldName: 'entity.risk.calculated_score_norm',
          expectedValuesByEntityId: normalizeScores(scores).reduce<Record<string, number>>(
            (acc, s) => {
              if (typeof s.id_value === 'string' && s.calculated_score_norm != null) {
                acc[s.id_value] = s.calculated_score_norm;
              }
              return acc;
            },
            {}
          ),
        });

        const entities = await getEntitiesById({ es, entityIds: expectedIds, namespace });
        expect(entities.length).to.eql(10);
        expect(entities.map((entity) => getEntityId(entity)).sort()).to.eql(expectedIds);

        entities.forEach((entity) => {
          const risk = getEntityRisk(entity);
          expect(risk).to.be.ok();
          expect(risk!.calculated_score_norm).to.be.greaterThan(0);
          expect(risk!.calculated_level).to.be.ok();
        });
      });
    });
  });
};
