/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { i18n } from '@kbn/i18n';

export const errorMessageStrings = {
  page: {
    callout: {
      fatal: {
        title: () =>
          i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.title', {
            defaultMessage: 'Unable to load page',
          }),
        body: () =>
          i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.body', {
            defaultMessage: 'Try refreshing the page to resolve the issue.',
          }),
        showDetailsButton: () =>
          i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.detailButton', {
            defaultMessage: 'Show details',
          }),
        pageReloadButton: () =>
          i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.pageReloadButton', {
            defaultMessage: 'Refresh page',
          }),
      },
      recoverable: {
        title: () =>
          i18n.translate('sharedUXPackages.error_boundary.recoverable.prompt.title', {
            defaultMessage: 'Refresh the page',
          }),
        body: () =>
          i18n.translate('sharedUXPackages.error_boundary.recoverable.prompt.body', {
            defaultMessage: 'This should resolve any issues loading the page.',
          }),
        pageReloadButton: () =>
          i18n.translate('sharedUXPackages.error_boundary.recoverable.prompt.pageReloadButton', {
            defaultMessage: 'Refresh page',
          }),
      },
    },
  },
  section: {
    callout: {
      fatal: {
        title: (sectionName: string) =>
          i18n.translate('sharedUXPackages.section_error_boundary.fatal.prompt.title', {
            defaultMessage: 'Unable to render {sectionName}',
            values: { sectionName },
          }),
        body: (sectionName: string) =>
          i18n.translate('sharedUXPackages.section_error_boundary.fatal.prompt.body', {
            defaultMessage: 'An error happened while rendering {sectionName}.',
            values: { sectionName },
          }),
        showDetailsButton: () =>
          i18n.translate('sharedUXPackages.section_error_boundary.fatal.prompt.detailButton', {
            defaultMessage: 'Show details',
          }),
      },
      recoverable: {
        title: (sectionName: string) =>
          i18n.translate('sharedUXPackages.section_error_boundary.recoverable.prompt.title', {
            defaultMessage: 'Unable to render {sectionName}',
            values: { sectionName },
          }),
        body: (sectionName: string) =>
          i18n.translate('sharedUXPackages.section_error_boundary.recoverable.prompt.body', {
            defaultMessage: 'Refreshing should resolve any issues in {sectionName}.',
            values: { sectionName },
          }),
        pageReloadButton: () =>
          i18n.translate('sharedUXPackages.error_boundary.recoverable.prompt.pageReloadButton', {
            defaultMessage: 'Refresh page',
          }),
      },
    },
  },
  details: {
    title: () =>
      i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.details.title', {
        defaultMessage: 'Error details',
      }),
    componentName: (errorComponentName: string) =>
      i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.details', {
        defaultMessage: 'The above error occurred in {name}:',
        values: { name: errorComponentName },
      }),
    closeButton: () =>
      i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.details.close', {
        defaultMessage: 'Close',
      }),
    copyToClipboardButton: () =>
      i18n.translate('sharedUXPackages.error_boundary.fatal.prompt.details.copyToClipboard', {
        defaultMessage: 'Copy error to clipboard',
      }),
  },
};
