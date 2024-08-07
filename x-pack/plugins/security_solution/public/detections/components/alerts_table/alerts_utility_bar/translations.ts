/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';

export const SHOWING_ALERTS = (totalAlertsFormatted: string, totalAlerts: number) =>
  i18n.translate('xpack.securitySolution.detectionEngine.alerts.utilityBar.showingAlertsTitle', {
    values: { totalAlertsFormatted, totalAlerts },
    defaultMessage:
      'Showing {totalAlertsFormatted} {totalAlerts, plural, =1 {alert} other {alerts}}',
  });

export const SELECTED_ALERTS = (selectedAlertsFormatted: string, selectedAlerts: number) =>
  i18n.translate('xpack.securitySolution.detectionEngine.alerts.utilityBar.selectedAlertsTitle', {
    values: { selectedAlertsFormatted, selectedAlerts },
    defaultMessage:
      'Selected {selectedAlertsFormatted} {selectedAlerts, plural, =1 {alert} other {alerts}}',
  });

export const SELECT_ALL_ALERTS = (totalAlertsFormatted: string, totalAlerts: number) =>
  i18n.translate('xpack.securitySolution.detectionEngine.alerts.utilityBar.selectAllAlertsTitle', {
    values: { totalAlertsFormatted, totalAlerts },
    defaultMessage:
      'Select all {totalAlertsFormatted} {totalAlerts, plural, =1 {alert} other {alerts}}',
  });

export const ADDITIONAL_FILTERS_ACTIONS = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.additionalFiltersTitle',
  {
    defaultMessage: 'Additional filters',
  }
);

export const ADDITIONAL_FILTERS_ACTIONS_SHOW_BUILDING_BLOCK = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.additionalFiltersActions.showBuildingBlockTitle',
  {
    defaultMessage: 'Include building block alerts',
  }
);

export const ADDITIONAL_FILTERS_ACTIONS_SHOW_ONLY_THREAT_INDICATOR_ALERTS = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.additionalFiltersActions.showOnlyThreatIndicatorAlerts',
  {
    defaultMessage: 'Show only threat indicator alerts',
  }
);

export const CLEAR_SELECTION = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.clearSelectionTitle',
  {
    defaultMessage: 'Clear selection',
  }
);

export const TAKE_ACTION = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.takeActionTitle',
  {
    defaultMessage: 'Take action',
  }
);

export const BATCH_ACTION_OPEN_SELECTED = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.batchActions.openSelectedTitle',
  {
    defaultMessage: 'Open selected',
  }
);

export const BATCH_ACTION_CLOSE_SELECTED = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.batchActions.closeSelectedTitle',
  {
    defaultMessage: 'Close selected',
  }
);

export const BATCH_ACTION_ACKNOWLEDGED_SELECTED = i18n.translate(
  'xpack.securitySolution.detectionEngine.alerts.utilityBar.batchActions.acknowledgedSelectedTitle',
  {
    defaultMessage: 'Mark as acknowledged',
  }
);
