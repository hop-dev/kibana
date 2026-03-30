/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Runtime gating for id-based risk scoring. This UI setting controls whether
 * the risk engine uses entity.id as the identifier field and dual-writes
 * scores to the entity store.
 *
 * This is independent of the maintainer registration gate
 * (experimentalFeatures.riskScoringMaintainerEnabled), which controls whether
 * the maintainer task is registered at plugin startup.
 */
export const isIdBasedRiskScoringEnabled = ({
  entityStoreV2Enabled,
  idBasedRiskScoringEnabled = true,
}: {
  entityStoreV2Enabled: boolean;
  idBasedRiskScoringEnabled?: boolean;
}): boolean => entityStoreV2Enabled && idBasedRiskScoringEnabled;
