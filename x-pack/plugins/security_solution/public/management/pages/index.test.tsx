/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';

import { ManagementContainer } from '.';
import '../../common/mock/match_media';
import type { AppContextTestRender } from '../../common/mock/endpoint';
import { createAppRootMockRenderer } from '../../common/mock/endpoint';
import { useUserPrivileges } from '../../common/components/user_privileges';
import { endpointPageHttpMock } from './endpoint_hosts/mocks';

jest.mock('../../common/components/user_privileges');

// FLAKY: https://github.com/elastic/kibana/issues/135166
describe.skip('when in the Administration tab', () => {
  let render: () => ReturnType<AppContextTestRender['render']>;

  beforeEach(() => {
    const mockedContext = createAppRootMockRenderer();
    endpointPageHttpMock(mockedContext.coreStart.http);
    render = () => mockedContext.render(<ManagementContainer />);
    mockedContext.history.push('/administration/endpoints');
  });

  it('should display the No Permissions if no sufficient privileges', async () => {
    (useUserPrivileges as jest.Mock).mockReturnValue({
      endpointPrivileges: { loading: false, canAccessEndpointManagement: false },
    });

    expect(await render().findByTestId('noIngestPermissions')).not.toBeNull();
  });

  it('should display the Management view if user has privileges', async () => {
    (useUserPrivileges as jest.Mock).mockReturnValue({
      endpointPrivileges: { loading: false, canAccessEndpointManagement: true },
    });

    expect(await render().findByTestId('endpointPage')).not.toBeNull();
  });
});
