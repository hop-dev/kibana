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
  waitForRiskScoresToBePresent,
  waitForRiskScoreForId,
  EntityStoreUtils,
  entityMaintainerRouteHelpersFactory,
  waitForMaintainerRun,
  cleanUpRiskScoreMaintainer,
  assetCriticalityRouteHelpersFactory,
  cleanAssetCriticality,
  getAssetCriticalityEsDocument,
  watchlistRouteHelpersFactory,
  riskScoreMaintainerScenarioFactory,
  riskScoreMaintainerEntityBuilders,
  waitForEntityStoreEntities,
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

  describe('@ess @serverless @serverlessQA Risk Score Maintainer Entity Calculation', function () {
    this.tags(['esGate']);

    context('with auditbeat data', () => {
      const indexListOfDocuments = async (documents: Array<Record<string, unknown>>) => {
        const operations = documents.flatMap((document) => {
          const { _id, ...source } = document as Record<string, unknown> & { _id?: string };
          const existingDataStream =
            typeof source.data_stream === 'object' && source.data_stream !== null
              ? (source.data_stream as Record<string, unknown>)
              : {};

          const enrichedSource = {
            ...source,
            data_stream: {
              type: (existingDataStream.type as string) ?? 'logs',
              dataset: (existingDataStream.dataset as string) ?? 'testlogs.default',
              namespace: (existingDataStream.namespace as string) ?? 'default',
            },
          };

          return [{ create: { _index: testLogsIndex, _id: _id ?? uuidv4() } }, enrichedSource];
        });

        const response = await es.bulk({ refresh: true, operations });
        const firstError = response.items.find((item) => item.create?.error)?.create?.error;
        if (firstError) {
          log.error(`Failed to index maintainer test document: "${firstError.reason}"`);
          throw new Error(firstError.reason ?? firstError.type ?? 'bulk_create_error');
        }

        return { documents, response };
      };
      const maintainerScenario = riskScoreMaintainerScenarioFactory({
        indexListOfDocuments,
        createAndSyncRuleAndAlerts,
        entityStoreUtils,
        retry,
        routes: maintainerRoutes,
      });
      const waitForEntityStoreDoc = async ({
        entityId,
        timeoutMs = 60_000,
        requireCriticality,
        requiredWatchlistId,
      }: {
        entityId: string;
        timeoutMs?: number;
        requireCriticality?: 'high_impact' | 'absent';
        requiredWatchlistId?: string;
      }) => {
        await retry.waitForWithTimeout(
          `entity store doc present for ${entityId}`,
          timeoutMs,
          async () => {
            const response = await es.search({
              index: '.entities.v2.latest.security_default',
              size: 1,
              query: { term: { 'entity.id': entityId } },
            });
            const hit = response.hits.hits[0]?._source as
              | {
                  asset?: { criticality?: string };
                  entity?: { attributes?: { watchlists?: string[] } };
                }
              | undefined;
            if (!hit) {
              return false;
            }

            if (requireCriticality === 'high_impact') {
              return hit.asset?.criticality === 'high_impact';
            }
            if (requireCriticality === 'absent') {
              return hit.asset?.criticality == null;
            }
            if (requiredWatchlistId) {
              return hit.entity?.attributes?.watchlists?.includes(requiredWatchlistId) ?? false;
            }
            return true;
          }
        );
      };

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
                host: {
                  properties: {
                    id: { type: 'keyword' },
                    name: { type: 'keyword' },
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

      it('calculates and persists risk score for a single host entity', async () => {
        const documentId = uuidv4();
        const { documentIds, testEntities } = await maintainerScenario.seedEntities([
          riskScoreMaintainerEntityBuilders.host({ hostName: 'host-1', documentId }),
        ]);
        const [host] = testEntities;
        await maintainerScenario.createAlertsForDocumentIds({
          documentIds,
          alerts: 1,
          riskScore: 21,
        });
        await maintainerScenario.installAndRunMaintainer({ dataViewPattern: testLogsIndex });
        const score = await waitForRiskScoreForId({
          es,
          log,
          idValue: host.expectedEuid,
          expectedCalculatedScore: 21,
        });

        expect(score.calculated_level).to.eql('Unknown');
        expect(score.calculated_score).to.eql(21);
        expect(score.calculated_score_norm).to.be.within(8.1006017, 8.100602);
        expect(score.category_1_score).to.be.within(8.1006017, 8.100602);
        expect(score.category_1_count).to.eql(1);
        expect(score.id_value).to.eql(host.expectedEuid);
      });

      it('calculates risk scores for hosts and users together', async () => {
        const { documentIds, testEntities } = await maintainerScenario.seedEntities([
          riskScoreMaintainerEntityBuilders.host({ hostName: 'host-1' }),
          riskScoreMaintainerEntityBuilders.idpUser({ userName: 'user-1' }),
        ]);
        const [host, idpUser] = testEntities;
        await maintainerScenario.createAlertsForDocumentIds({
          documentIds,
          alerts: 2,
          riskScore: 21,
        });
        await maintainerScenario.installAndRunMaintainer({ dataViewPattern: testLogsIndex });
        await waitForRiskScoresToBePresent({ es, log, scoreCount: 2 });

        const scores = await readRiskScores(es);
        const normalized = normalizeScores(scores);
        const idValues = normalized.map(({ id_value: idValue }) => idValue).sort();

        expect(idValues).to.contain(host.expectedEuid);
        expect(idValues).to.contain(idpUser.expectedEuid);
      });

      it('calculates risk score for a local user EUID', async () => {
        const localHostId = `host-local-${uuidv4()}`;
        const localUserName = `local-user-${uuidv4()}`;
        const { documentIds, testEntities } = await maintainerScenario.seedEntities([
          riskScoreMaintainerEntityBuilders.localUser({
            userName: localUserName,
            hostId: localHostId,
            hostName: `host-local-name-${uuidv4()}`,
          }),
        ]);
        const [localUser] = testEntities;
        await maintainerScenario.createAlertsForDocumentIds({
          documentIds,
          alerts: 1,
          riskScore: 21,
        });
        await entityStoreUtils.installEntityStoreV2({
          entityTypes: ['user', 'host'],
          dataViewPattern: testLogsIndex,
        });
        await waitForEntityStoreDoc({ entityId: localUser.expectedEuid });
        await maintainerRoutes.runMaintainer('risk-score');
        await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
        const score = await waitForRiskScoreForId({
          es,
          log,
          idValue: localUser.expectedEuid,
          expectedCalculatedScore: 21,
        });

        expect(score.id_value).to.eql(localUser.expectedEuid);
      });

      describe('@skipInServerless with asset criticality data', () => {
        const assetCriticalityRoutes = assetCriticalityRouteHelpersFactory(supertest);

        afterEach(async () => {
          await cleanAssetCriticality({ log, es });
        });

        it('calculates risk scores with criticality modifiers', async () => {
          const documentId = uuidv4();
          const hostName = `host-${uuidv4()}`;
          const { documentIds, testEntities } = await maintainerScenario.seedEntities([
            riskScoreMaintainerEntityBuilders.host({ hostName, documentId }),
          ]);
          const [testHost] = testEntities;

          await assetCriticalityRoutes.upsert({
            id_field: 'host.name',
            id_value: hostName,
            criticality_level: 'high_impact',
          });

          await retry.waitForWithTimeout(
            `asset criticality present for ${hostName}`,
            30_000,
            async () => {
              const doc = await getAssetCriticalityEsDocument({
                es,
                idField: 'host.name',
                idValue: hostName,
              });
              return doc?.criticality_level === 'high_impact';
            }
          );
          await maintainerScenario.createAlertsForDocumentIds({
            documentIds,
            alerts: 1,
            riskScore: 21,
          });

          await entityStoreUtils.installEntityStoreV2({
            entityTypes: ['user', 'host'],
            dataViewPattern: testLogsIndex,
          });
          await waitForEntityStoreDoc({ entityId: testHost.expectedEuid });
          await maintainerScenario.setEntityCriticality({
            testEntity: testHost,
            criticalityLevel: 'high_impact',
          });
          await waitForEntityStoreDoc({
            entityId: testHost.expectedEuid,
            requireCriticality: 'high_impact',
          });
          await maintainerRoutes.runMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
          const score = await waitForRiskScoreForId({
            es,
            log,
            idValue: testHost.expectedEuid,
            expectedCalculatedScore: 21,
          });

          expect(score.criticality_level).to.eql('high_impact');
          expect(score.criticality_modifier).to.eql(1.5);
          expect(score.calculated_level).to.eql('Unknown');
          expect(score.calculated_score).to.eql(21);
          expect(score.calculated_score_norm).to.be.within(11.677912, 11.6779121);
          expect(score.category_1_score).to.be.within(8.1006017, 8.100602);
          expect(score.category_1_count).to.eql(1);
          expect(score.id_value).to.eql(testHost.expectedEuid);
        });
      });

      describe('@skipInServerless with watchlist modifier data', () => {
        const watchlistRoutes = watchlistRouteHelpersFactory(supertest);

        afterEach(async () => {
          const listResponse = await watchlistRoutes.list().catch(() => undefined);
          if (!listResponse) {
            return;
          }
          for (const watchlist of listResponse.body) {
            if (watchlist.id) {
              await watchlistRoutes.delete(watchlist.id).catch(() => undefined);
            }
          }
        });

        it('calculates risk scores with watchlist modifiers', async () => {
          const documentId = uuidv4();
          const userName = `watchlist-user-${uuidv4()}`;
          const { documentIds, testEntities } = await maintainerScenario.seedEntities([
            riskScoreMaintainerEntityBuilders.idpUser({ userName, documentId }),
          ]);
          const [idpUser] = testEntities;
          await maintainerScenario.createAlertsForDocumentIds({
            documentIds,
            alerts: 1,
            riskScore: 21,
          });

          // Create a watchlist with a custom riskModifier
          const createResponse = await watchlistRoutes.create({
            name: 'high-risk-vendors',
            riskModifier: 1.8,
          });
          if (createResponse.status !== 200) {
            throw new Error(
              `Failed to create watchlist; expected 200 but got ${
                createResponse.status
              }: ${JSON.stringify(createResponse.body)}`
            );
          }
          const watchlistId = createResponse.body.id!;
          const watchlists = await watchlistRoutes.list();
          expect(watchlists.body.map((watchlist) => watchlist.id)).to.contain(watchlistId);

          await maintainerScenario.installAndRunMaintainer({ dataViewPattern: testLogsIndex });
          const baseScore = await waitForRiskScoreForId({
            es,
            log,
            idValue: idpUser.expectedEuid,
            expectedCalculatedScore: 21,
          });
          const baseNormScore = baseScore.calculated_score_norm!;

          // Update the entity in the entity store to add watchlist membership
          await maintainerScenario.setEntityWatchlists({
            testEntity: idpUser,
            watchlistIds: [watchlistId],
          });
          await waitForEntityStoreDoc({
            entityId: idpUser.expectedEuid,
            requiredWatchlistId: watchlistId,
          });
          const entityResponse = await es.search({
            index: '.entities.v2.latest.security_default',
            size: 1,
            query: { term: { 'entity.id': idpUser.expectedEuid } },
          });
          const entityDoc = entityResponse.hits.hits[0]?._source as
            | { entity?: { attributes?: { watchlists?: string[] } } }
            | undefined;
          expect(entityDoc?.entity?.attributes?.watchlists ?? []).to.contain(watchlistId);

          // Re-run maintainer after watchlist membership has propagated to the entity doc
          await maintainerRoutes.runMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
          await retry.waitForWithTimeout(
            `risk score with watchlist modifier for ${idpUser.expectedEuid}`,
            60_000,
            async () => {
              const scores = await readRiskScores(es);
              const normalized = normalizeScores(scores).filter(
                ({ id_value: idValue }) => idValue === idpUser.expectedEuid
              );
              const scoresAfterMembershipUpdate = normalized.filter(
                (score) => score.calculation_run_id !== baseScore.calculation_run_id
              );
              const scoredWithWatchlistModifier = scoresAfterMembershipUpdate.find((score) =>
                score.modifiers?.some(
                  (modifier) =>
                    modifier.type === 'watchlist' &&
                    modifier.subtype === 'high-risk-vendors' &&
                    modifier.modifier_value === 1.8
                )
              );

              // We expect the second run to produce a new score doc after entity update.
              if (scoresAfterMembershipUpdate.length === 0 || !scoredWithWatchlistModifier) {
                return false;
              }

              expect(scoredWithWatchlistModifier.calculated_score_norm).to.be.greaterThan(
                baseNormScore
              );
              expect(scoredWithWatchlistModifier.id_value).to.eql(idpUser.expectedEuid);
              return true;
            }
          );
        });
      });

      describe('reset-to-zero behavior', () => {
        it('resets stale entity scores to zero after maintainer run', async () => {
          const activeHostName = `host-active-${uuidv4().slice(0, 8)}`;
          const staleHostName = `host-stale-${uuidv4().slice(0, 8)}`;

          const { documentIds: activeDocIds, testEntities: activeEntities } =
            await maintainerScenario.seedEntities([
              riskScoreMaintainerEntityBuilders.host({ hostName: activeHostName }),
            ]);
          const [activeHost] = activeEntities;

          const { documentIds: staleDocIds, testEntities: staleEntities } =
            await maintainerScenario.seedEntities([
              riskScoreMaintainerEntityBuilders.host({ hostName: staleHostName }),
            ]);
          const [staleHost] = staleEntities;

          await maintainerScenario.createAlertsForDocumentIds({
            documentIds: [...activeDocIds, ...staleDocIds],
            alerts: 2,
            riskScore: 40,
          });

          // Install entity store first, then wait for BOTH entities to appear
          // before running the maintainer. installAndRunMaintainer only waits
          // for 1 entity, and the maintainer drops not_in_store entities.
          await entityStoreUtils.installEntityStoreV2({
            entityTypes: ['user', 'host'],
            dataViewPattern: testLogsIndex,
          });
          await waitForEntityStoreEntities({ es, log, count: 2 });
          await maintainerRoutes.runMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: 2 });

          const firstRunScores = normalizeScores(await readRiskScores(es));
          const staleFirstScore = firstRunScores.find((s) => s.id_value === staleHost.expectedEuid);
          expect(staleFirstScore).to.not.be(undefined);
          expect(staleFirstScore!.calculated_score_norm).to.be.greaterThan(0);

          // Stop the maintainer to prevent scheduled runs during the alert transition
          await maintainerRoutes.stopMaintainer('risk-score');

          // Remove all rules/alerts, then recreate only for the active host
          await deleteAllRules(supertest, log);
          await deleteAllAlerts(supertest, log, es);
          await maintainerScenario.createAlertsForDocumentIds({
            documentIds: activeDocIds,
            alerts: 1,
            riskScore: 40,
          });

          // Resume the maintainer and trigger a new run.
          // Active host will be scored (new run_id), stale host will not be scored
          // (no alerts) and its previous positive score will be reset to zero.
          await maintainerRoutes.startMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });

          await retry.waitForWithTimeout(
            `stale entity ${staleHost.expectedEuid} reset to zero`,
            60_000,
            async () => {
              const scores = normalizeScores(await readRiskScores(es));
              const staleScores = scores.filter((s) => s.id_value === staleHost.expectedEuid);
              return staleScores.some((s) => s.calculated_score_norm === 0);
            }
          );

          // Active host should still have a positive score from the new run
          const finalScores = normalizeScores(await readRiskScores(es));
          const activeScores = finalScores.filter((s) => s.id_value === activeHost.expectedEuid);
          expect(activeScores.some((s) => (s.calculated_score_norm ?? 0) > 0)).to.be(true);
        });
      });

      describe('@skipInServerless multi-entity scoring at scale with mixed modifiers', () => {
        const watchlistRoutesScale = watchlistRouteHelpersFactory(supertest);

        afterEach(async () => {
          await cleanAssetCriticality({ log, es });
          const listResponse = await watchlistRoutesScale.list().catch(() => undefined);
          if (listResponse) {
            for (const watchlist of listResponse.body) {
              if (watchlist.id) {
                await watchlistRoutesScale.delete(watchlist.id).catch(() => undefined);
              }
            }
          }
        });

        it('scores many entities with asset criticality and watchlist modifiers', async () => {
          const shortId = uuidv4().slice(0, 8);
          const hostSeeds = Array.from({ length: 8 }, (_, i) =>
            riskScoreMaintainerEntityBuilders.host({ hostName: `scale-host-${i}-${shortId}` })
          );
          const userSeeds = Array.from({ length: 4 }, (_, i) =>
            riskScoreMaintainerEntityBuilders.idpUser({ userName: `scale-user-${i}-${shortId}` })
          );

          const { documentIds, testEntities } = await maintainerScenario.seedEntities([
            ...hostSeeds,
            ...userSeeds,
          ]);

          await maintainerScenario.createAlertsForDocumentIds({
            documentIds,
            alerts: documentIds.length,
            riskScore: 30,
            maxSignals: 200,
          });

          await entityStoreUtils.installEntityStoreV2({
            entityTypes: ['user', 'host'],
            dataViewPattern: testLogsIndex,
          });
          await waitForEntityStoreEntities({ es, log, count: testEntities.length });

          // Assign criticality to first 4 entities (2 hosts + 2 users)
          const criticalEntities = testEntities.slice(0, 4);
          for (const entity of criticalEntities) {
            await maintainerScenario.setEntityCriticality({
              testEntity: entity,
              criticalityLevel: 'high_impact',
            });
          }

          // Create a watchlist and assign membership to entities 2-4 (overlap with criticality)
          const wlCreateResponse = await watchlistRoutesScale.create({
            name: 'scale-test-watchlist',
            riskModifier: 1.5,
          });
          if (wlCreateResponse.status !== 200) {
            throw new Error(`Failed to create watchlist: ${JSON.stringify(wlCreateResponse.body)}`);
          }
          const watchlistId = wlCreateResponse.body.id!;

          const watchlistEntities = testEntities.slice(2, 5);
          for (const entity of watchlistEntities) {
            await maintainerScenario.setEntityWatchlists({
              testEntity: entity,
              watchlistIds: [watchlistId],
            });
          }

          // Wait for entity store to reflect at least one criticality and one watchlist assignment
          await waitForEntityStoreDoc({
            entityId: criticalEntities[0].expectedEuid,
            requireCriticality: 'high_impact',
          });
          await waitForEntityStoreDoc({
            entityId: watchlistEntities[0].expectedEuid,
            requiredWatchlistId: watchlistId,
          });

          await maintainerRoutes.runMaintainer('risk-score');
          await waitForMaintainerRun({ retry, routes: maintainerRoutes, minRuns: 1 });
          await waitForRiskScoresToBePresent({ es, log, scoreCount: testEntities.length });

          const scores = normalizeScores(await readRiskScores(es));

          // All entities should have been scored
          for (const entity of testEntities) {
            const entityScores = scores.filter((s) => s.id_value === entity.expectedEuid);
            expect(entityScores.length).to.be.greaterThan(0);
          }

          // Entities with criticality should have the modifier applied
          for (const entity of criticalEntities) {
            const entityScore = scores.find((s) => s.id_value === entity.expectedEuid);
            expect(entityScore?.criticality_level).to.eql('high_impact');
            expect(entityScore?.criticality_modifier).to.eql(1.5);
          }

          // Entities with watchlist membership should have a watchlist modifier
          for (const entity of watchlistEntities) {
            const entityScore = scores.find((s) => s.id_value === entity.expectedEuid);
            const hasWatchlistMod = entityScore?.modifiers?.some(
              (m) =>
                m.type === 'watchlist' &&
                m.subtype === 'scale-test-watchlist' &&
                m.modifier_value === 1.5
            );
            expect(hasWatchlistMod).to.be(true);
          }

          // Entities without any modifiers should have no criticality metadata
          const plainEntities = testEntities.filter(
            (e) => !criticalEntities.includes(e) && !watchlistEntities.includes(e)
          );
          for (const entity of plainEntities) {
            const entityScore = scores.find((s) => s.id_value === entity.expectedEuid);
            expect(entityScore?.criticality_level).to.be(undefined);
          }
        });
      });
    });
  });
};
