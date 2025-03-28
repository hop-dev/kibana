/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export const ruleDetailsRoute = '/rule/:ruleId' as const;
export const triggersActionsRoute = '/app/management/insightsAndAlerting/triggersActions' as const;
export const createRuleRoute = '/rules/create/:ruleTypeId' as const;
export const editRuleRoute = '/rules/edit/:id' as const;

export const getRuleDetailsRoute = (ruleId: string) => ruleDetailsRoute.replace(':ruleId', ruleId);
export const getCreateRuleRoute = (ruleTypeId: string) =>
  createRuleRoute.replace(':ruleTypeId', ruleTypeId);
export const getEditRuleRoute = (ruleId: string) => editRuleRoute.replace(':id', ruleId);
