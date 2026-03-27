/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import { buildDocument } from './risk_engine';
import { waitForMaintainerRun } from './entity_maintainers';

type IndexListOfDocuments = (docs: Array<Record<string, unknown>>) => Promise<void>;

type CreateAndSyncRuleAndAlerts = (params: {
  alerts?: number;
  riskScore?: number;
  maxSignals?: number;
  query: string;
  riskScoreOverride?: string;
}) => Promise<void>;

interface RetryServiceLike {
  waitForWithTimeout: (
    label: string,
    timeout: number,
    predicate: () => Promise<boolean> | boolean
  ) => Promise<void>;
}

type MaintainerRoutesLike = {
  getMaintainers: () => Promise<{
    body: { maintainers: Array<{ id: string; runs: number }> };
  }>;
  runMaintainer: (id: string) => Promise<unknown>;
};

type EntityStoreUtilsLike = {
  installEntityStoreV2: (body?: { entityTypes: string[]; dataViewPattern?: string }) => Promise<unknown>;
};

export type MaintainerEntitySeed =
  | {
      kind: 'host';
      hostName: string;
      documentId?: string;
      extraFields?: Record<string, unknown>;
    }
  | {
      kind: 'idp_user';
      userName: string;
      userId?: string;
      userEmail?: string;
      namespaceSource?: string;
      namespaceDataset?: string;
      documentId?: string;
      extraFields?: Record<string, unknown>;
    }
  | {
      kind: 'local_user';
      userName: string;
      hostId: string;
      hostName?: string;
      documentId?: string;
      extraFields?: Record<string, unknown>;
    };

export interface SeededMaintainerEntity {
  seed: MaintainerEntitySeed;
  documentId: string;
  document: Record<string, unknown>;
  expectedEuid: string;
}

const buildSeededEntity = (seed: MaintainerEntitySeed): SeededMaintainerEntity => {
  const documentId = seed.documentId ?? uuidv4();

  if (seed.kind === 'host') {
    return {
      seed,
      documentId,
      document: buildDocument(
        {
          host: { name: seed.hostName },
          ...(seed.extraFields ?? {}),
        },
        documentId
      ),
      expectedEuid: `host:${seed.hostName}`,
    };
  }

  if (seed.kind === 'idp_user') {
    const namespaceSource = seed.namespaceSource ?? 'okta';
    const expectedNamespace = namespaceSource;
    return {
      seed,
      documentId,
      document: buildDocument(
        {
          user: {
            name: seed.userName,
            ...(seed.userId ? { id: seed.userId } : {}),
            ...(seed.userEmail ? { email: seed.userEmail } : {}),
          },
          event: { kind: ['asset'], category: ['iam'], type: ['user'] },
          'event.module': namespaceSource,
          ...(seed.namespaceDataset ? { 'data_stream.dataset': seed.namespaceDataset } : {}),
          ...(seed.extraFields ?? {}),
        },
        documentId
      ),
      expectedEuid: `user:${seed.userName}@${expectedNamespace}`,
    };
  }

  return {
    seed,
    documentId,
    document: buildDocument(
      {
        user: { name: seed.userName },
        host: { id: seed.hostId, ...(seed.hostName ? { name: seed.hostName } : {}) },
        // Local-user path should mirror non-IDP logs extraction contract.
        // Include module=local so risk-score EUID evaluation can resolve local namespace.
        event: { kind: 'event', category: 'network', outcome: 'success', module: 'local' },
        ...(seed.extraFields ?? {}),
      },
      documentId
    ),
    expectedEuid: `user:${seed.userName}@${seed.hostId}@local`,
  };
};

const buildAlertQueryForDocumentIds = (documentIds: string[]): string =>
  documentIds.map((id) => `id: ${id}`).join(' or ');

export const riskScoreMaintainerScenarioFactory = ({
  indexListOfDocuments,
  createAndSyncRuleAndAlerts,
  entityStoreUtils,
  retry,
  routes,
}: {
  indexListOfDocuments: IndexListOfDocuments;
  createAndSyncRuleAndAlerts: CreateAndSyncRuleAndAlerts;
  entityStoreUtils: EntityStoreUtilsLike;
  retry: RetryServiceLike;
  routes: MaintainerRoutesLike;
}) => {
  const seedDocuments = async (documents: Array<Record<string, unknown>>) => {
    await indexListOfDocuments(documents);
  };

  const seedEntities = async (entities: MaintainerEntitySeed[]) => {
    const seededEntities = entities.map(buildSeededEntity);
    await seedDocuments(seededEntities.map(({ document }) => document));
    return {
      documentIds: seededEntities.map(({ documentId }) => documentId),
      documents: seededEntities.map(({ document }) => document),
      seededEntities,
    };
  };

  const createAlertsForDocumentIds = async ({
    documentIds,
    alerts,
    riskScore,
    maxSignals,
    riskScoreOverride,
  }: {
    documentIds: string[];
    alerts?: number;
    riskScore?: number;
    maxSignals?: number;
    riskScoreOverride?: string;
  }) => {
    await createAndSyncRuleAndAlerts({
      query: buildAlertQueryForDocumentIds(documentIds),
      alerts: alerts ?? documentIds.length,
      riskScore,
      maxSignals,
      riskScoreOverride,
    });
  };

  const installAndRunMaintainer = async ({
    entityTypes = ['user', 'host'],
    dataViewPattern,
    minRuns = 1,
    timeoutMs = 120_000,
  }: {
    entityTypes?: string[];
    dataViewPattern?: string;
    minRuns?: number;
    timeoutMs?: number;
  } = {}) => {
    await entityStoreUtils.installEntityStoreV2({ entityTypes, dataViewPattern });
    await waitForMaintainerRun({ retry, routes, minRuns, timeoutMs });
  };

  const seedEntitiesCreateAlertsInstallAndRun = async ({
    entities,
    alerts,
    riskScore,
    maxSignals,
    riskScoreOverride,
    entityTypes = ['user', 'host'],
    dataViewPattern,
    minRuns = 1,
    timeoutMs = 120_000,
  }: {
    entities: MaintainerEntitySeed[];
    alerts?: number;
    riskScore?: number;
    maxSignals?: number;
    riskScoreOverride?: string;
    entityTypes?: string[];
    dataViewPattern?: string;
    minRuns?: number;
    timeoutMs?: number;
  }) => {
    const { documentIds, seededEntities } = await seedEntities(entities);
    await createAlertsForDocumentIds({
      documentIds,
      alerts,
      riskScore,
      maxSignals,
      riskScoreOverride,
    });
    await installAndRunMaintainer({ entityTypes, dataViewPattern, minRuns, timeoutMs });
    return { documentIds, seededEntities };
  };

  return {
    seedDocuments,
    seedEntities,
    createAlertsForDocumentIds,
    installAndRunMaintainer,
    seedEntitiesCreateAlertsInstallAndRun,
  };
};

export const riskScoreMaintainerEntityBuilders = {
  host: (params: Omit<Extract<MaintainerEntitySeed, { kind: 'host' }>, 'kind'>): MaintainerEntitySeed => ({
    kind: 'host',
    ...params,
  }),
  idpUser: (
    params: Omit<Extract<MaintainerEntitySeed, { kind: 'idp_user' }>, 'kind'>
  ): MaintainerEntitySeed => ({
    kind: 'idp_user',
    ...params,
  }),
  localUser: (
    params: Omit<Extract<MaintainerEntitySeed, { kind: 'local_user' }>, 'kind'>
  ): MaintainerEntitySeed => ({
    kind: 'local_user',
    ...params,
  }),
};

