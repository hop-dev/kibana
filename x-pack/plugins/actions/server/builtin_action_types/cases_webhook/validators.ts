/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import * as i18n from './translations';
import { ActionsConfigurationUtilities } from '../../actions_config';
import {
  CasesWebhookPublicConfigurationType,
  CasesWebhookSecretConfigurationType,
  ExternalServiceValidation,
} from './types';

const validateConfig = (
  configurationUtilities: ActionsConfigurationUtilities,
  configObject: CasesWebhookPublicConfigurationType
) => {
  const {
    createCommentUrl,
    createIncidentUrl,
    incidentViewUrl,
    getIncidentUrl,
    updateIncidentUrl,
  } = configObject;

  const urls = [
    createIncidentUrl,
    createCommentUrl,
    incidentViewUrl,
    getIncidentUrl,
    updateIncidentUrl,
  ];

  for (const url of urls) {
    if (url) {
      try {
        new URL(url);
      } catch (err) {
        return i18n.INVALID_URL(err, url);
      }
      try {
        configurationUtilities.ensureUriAllowed(url);
      } catch (allowListError) {
        return i18n.CONFIG_ERR(allowListError.message);
      }
    }
  }
};

export const validateConnector = (
  configObject: CasesWebhookPublicConfigurationType,
  secrets: CasesWebhookSecretConfigurationType
): string | null => {
  // user and password must be set together (or not at all)
  if (!configObject.hasAuth) return null;
  if (secrets.password && secrets.user) return null;
  return i18n.INVALID_USER_PW;
};

export const validateSecrets = (secrets: CasesWebhookSecretConfigurationType) => {
  // user and password must be set together (or not at all)
  if (!secrets.password && !secrets.user) return;
  if (secrets.password && secrets.user) return;
  return i18n.INVALID_USER_PW;
};

export const validate: ExternalServiceValidation = {
  config: validateConfig,
  secrets: validateSecrets,
  connector: validateConnector,
};

const validProtocols: string[] = ['http:', 'https:'];
export const assertURL = (url: string) => {
  try {
    const parsedUrl = new URL(url);

    if (!parsedUrl.hostname) {
      throw new Error(`URL must contain hostname`);
    }

    if (!validProtocols.includes(parsedUrl.protocol)) {
      throw new Error(`Invalid protocol`);
    }
  } catch (error) {
    throw new Error(`${error.message}`);
  }
};
export const ensureUriAllowed = (
  url: string,
  configurationUtilities: ActionsConfigurationUtilities
) => {
  try {
    configurationUtilities.ensureUriAllowed(url);
  } catch (allowedListError) {
    throw Error(`${i18n.ALLOWED_HOSTS_ERROR(allowedListError.message)}`);
  }
};
export const normalizeURL = (url: string) => {
  const urlWithoutTrailingSlash = url.endsWith('/') ? url.slice(0, -1) : url;
  const replaceDoubleSlashesRegex = new RegExp('([^:]/)/+', 'g');
  return urlWithoutTrailingSlash.replace(replaceDoubleSlashesRegex, '$1');
};

export const validateAndNormalizeUrl = (
  url: string,
  configurationUtilities: ActionsConfigurationUtilities,
  urlDesc: string
) => {
  try {
    assertURL(url);
    ensureUriAllowed(url, configurationUtilities);
    return normalizeURL(url);
  } catch (e) {
    throw Error(`Invalid ${urlDesc}: ${e}`);
  }
};

export const validateJson = (jsonString: string, jsonDesc: string) => {
  try {
    JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`JSON Error: ${jsonDesc} must be valid JSON`);
  }
};
