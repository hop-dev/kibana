/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { EuiLink } from '@elastic/eui';
import { useSelector } from 'react-redux';
import { selectSelectedLocationId } from '../../../../state';
import {
  ConfigKey,
  EncryptedSyntheticsSavedMonitor,
} from '../../../../../../../common/runtime_types';

export const MonitorDetailsLink = ({
  basePath,
  monitor,
}: {
  basePath: string;
  monitor: EncryptedSyntheticsSavedMonitor;
}) => {
  const lastSelectedLocationId = useSelector(selectSelectedLocationId);
  const monitorHasLocation = monitor[ConfigKey.LOCATIONS]?.find(
    (loc) => loc.id === lastSelectedLocationId
  );

  const firstMonitorLocationId = monitor[ConfigKey.LOCATIONS]?.[0]?.id;
  const locationId =
    lastSelectedLocationId && monitorHasLocation ? lastSelectedLocationId : firstMonitorLocationId;

  const locationUrlQueryParam = locationId ? `?locationId=${locationId}` : '';

  return (
    <>
      <EuiLink href={`${basePath}/app/synthetics/monitor/${monitor.id}${locationUrlQueryParam}`}>
        {monitor.name}
      </EuiLink>
    </>
  );
};
