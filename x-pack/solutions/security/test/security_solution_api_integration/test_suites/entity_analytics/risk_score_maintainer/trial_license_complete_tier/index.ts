/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FtrProviderContext } from '../../../../ftr_provider_context';

export default function ({ loadTestFile }: FtrProviderContext) {
  describe('Entity Analytics - Risk Score Maintainer', function () {
    // setup_and_status needs data seeding before it can be re-enabled —
    // installEntityStoreV2() hangs on waitForEntityStoreEntities when no
    // source documents exist.
    // loadTestFile(require.resolve('./setup_and_status'));
    loadTestFile(require.resolve('./task_execution'));
    loadTestFile(require.resolve('./risk_score_calculation'));
  });
}
