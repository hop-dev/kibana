/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core-http-server';
import type { CoreStart } from '@kbn/core-lifecycle-server';
import type { Logger } from '@kbn/logging';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { EncryptedSavedObjectsPluginStart } from '@kbn/encrypted-saved-objects-plugin/server';
import { getFakeKibanaRequest } from '@kbn/security-plugin/server/authentication/api_keys/fake_kibana_request';
import { SavedObjectsErrorHelpers } from '@kbn/core-saved-objects-server';

import {
  LeadGenApiKeyType,
  getLeadGenEncryptedSavedObjectId,
  type LeadGenAPIKey,
} from './saved_object';

export const generateAndStoreApiKey = async ({
  core,
  security,
  encryptedSavedObjects,
  request,
  namespace,
  logger,
}: {
  core: CoreStart;
  security: SecurityPluginStart;
  encryptedSavedObjects: EncryptedSavedObjectsPluginStart | undefined;
  request: KibanaRequest;
  namespace: string;
  logger: Logger;
}): Promise<void> => {
  if (!encryptedSavedObjects) {
    throw new Error(
      'Unable to create API key. Ensure encrypted saved objects are enabled in this environment.'
    );
  }

  try {
    const rawKey = await security.authc.apiKeys.grantAsInternalUser(request, {
      name: 'Lead Generation API key',
      role_descriptors: {},
      metadata: {
        description: 'API key used by the lead generation scheduled task for inference access',
      },
    });

    if (!rawKey) {
      logger.warn(
        '[LeadGeneration] API key grant returned null; scheduled AI synthesis will be skipped'
      );
      return;
    }

    const apiKey: LeadGenAPIKey = { id: rawKey.id, name: rawKey.name, apiKey: rawKey.api_key };

    const soClient = core.savedObjects.getScopedClient(request, {
      includedHiddenTypes: [LeadGenApiKeyType.name],
    });

    await soClient.create(LeadGenApiKeyType.name, apiKey, {
      id: getLeadGenEncryptedSavedObjectId(namespace),
      overwrite: true,
      managed: true,
    });

    logger.debug('[LeadGeneration] API key stored for scheduled task inference access');
  } catch (error) {
    if (error.message?.includes('Unsupported scheme')) {
      logger.warn(
        '[LeadGeneration] API key creation not supported in this environment; scheduled AI synthesis will be skipped'
      );
      return;
    }
    throw error;
  }
};

export const getFakeRequestFromStoredApiKey = async ({
  encryptedSavedObjects,
  namespace,
  logger,
}: {
  encryptedSavedObjects: EncryptedSavedObjectsPluginStart | undefined;
  namespace: string;
  logger: Logger;
}): Promise<KibanaRequest | undefined> => {
  if (!encryptedSavedObjects) {
    return undefined;
  }

  try {
    const client = encryptedSavedObjects.getClient({
      includedHiddenTypes: [LeadGenApiKeyType.name],
    });

    const { attributes } = await client.getDecryptedAsInternalUser<LeadGenAPIKey>(
      LeadGenApiKeyType.name,
      getLeadGenEncryptedSavedObjectId(namespace),
      { namespace }
    );

    return getFakeKibanaRequest({ id: attributes.id, api_key: attributes.apiKey });
  } catch (err) {
    if (SavedObjectsErrorHelpers.isNotFoundError(err)) {
      logger.warn(
        '[LeadGeneration] No API key found for scheduled task; re-enable lead generation to restore AI synthesis'
      );
      return undefined;
    }
    throw err;
  }
};
