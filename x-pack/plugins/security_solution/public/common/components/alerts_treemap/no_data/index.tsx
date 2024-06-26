/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiFlexGroup, EuiFlexItem, EuiText } from '@elastic/eui';
import React from 'react';
import styled from 'styled-components';

import * as i18n from '../translations';

const NoDataLabel = styled(EuiText)`
  text-align: center;
`;

const NoDataComponent: React.FC = () => (
  <EuiFlexGroup alignItems="center" gutterSize="none">
    <EuiFlexItem grow={true}>
      <NoDataLabel color="subdued" data-test-subj="noDataLabel" size="xs">
        {i18n.NO_DATA_LABEL}
      </NoDataLabel>
    </EuiFlexItem>
  </EuiFlexGroup>
);

NoDataComponent.displayName = 'NoDataComponent';

export const NoData = React.memo(NoDataComponent);
