/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsType } from '@kbn/core/server';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import { v5 as uuidv5 } from 'uuid';

const LEAD_GEN_API_KEY_SO_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

export const getLeadGenEncryptedSavedObjectId = (space: string) =>
  uuidv5(space, LEAD_GEN_API_KEY_SO_ID);

export const SO_LEAD_GEN_API_KEY_TYPE = 'lead-gen-api-key';

export const LeadGenApiKeyType: SavedObjectsType = {
  name: SO_LEAD_GEN_API_KEY_TYPE,
  hidden: true,
  namespaceType: 'multiple-isolated',
  mappings: {
    dynamic: false,
    properties: {},
  },
  management: {
    importableAndExportable: false,
    displayName: 'Lead Generation API key',
  },
};

export const LeadGenApiKeyEncryptionParams: EncryptedSavedObjectTypeRegistration = {
  type: SO_LEAD_GEN_API_KEY_TYPE,
  attributesToEncrypt: new Set(['apiKey']),
  attributesToIncludeInAAD: new Set(['id', 'name']),
};

export interface LeadGenAPIKey {
  id: string;
  name: string;
  apiKey: string;
}
