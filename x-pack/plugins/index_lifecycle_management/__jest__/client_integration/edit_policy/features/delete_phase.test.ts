/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { act } from 'react-dom/test-utils';
import { API_BASE_PATH } from '../../../../common/constants';
import { setupEnvironment } from '../../helpers';
import {
  DELETE_PHASE_POLICY,
  getDefaultHotPhasePolicy,
  NEW_SNAPSHOT_POLICY_NAME,
  SNAPSHOT_POLICY_NAME,
} from '../constants';
import { DeleteTestBed, setupDeleteTestBed } from './delete_phase.helpers';

describe('<EditPolicy /> delete phase', () => {
  let testBed: DeleteTestBed;
  const { httpSetup, httpRequestsMockHelpers } = setupEnvironment();

  beforeEach(async () => {
    httpRequestsMockHelpers.setLoadPolicies([DELETE_PHASE_POLICY]);
    httpRequestsMockHelpers.setLoadSnapshotPolicies([
      SNAPSHOT_POLICY_NAME,
      NEW_SNAPSHOT_POLICY_NAME,
    ]);

    await act(async () => {
      testBed = await setupDeleteTestBed(httpSetup);
    });

    const { component } = testBed;
    component.update();
  });

  test('is hidden when disabled', async () => {
    httpRequestsMockHelpers.setLoadPolicies([getDefaultHotPhasePolicy()]);

    await act(async () => {
      testBed = await setupDeleteTestBed(httpSetup);
    });

    const { component, actions } = testBed;
    component.update();

    expect(actions.delete.isShown()).toBeFalsy();
    await actions.togglePhase('delete');
    expect(actions.delete.isShown()).toBeTruthy();
    await actions.togglePhase('delete');
    expect(actions.delete.isShown()).toBeFalsy();
  });

  describe('wait for snapshot', () => {
    test('shows snapshot policy name', () => {
      expect(testBed.find('snapshotPolicyCombobox').prop('data-currentvalue')).toEqual([
        {
          label: DELETE_PHASE_POLICY.policy.phases.delete?.actions.wait_for_snapshot?.policy,
        },
      ]);
    });

    test('updates snapshot policy name', async () => {
      const { actions } = testBed;

      await actions.delete.setSnapshotPolicy(NEW_SNAPSHOT_POLICY_NAME);
      await actions.savePolicy();

      const expected = {
        phases: {
          ...DELETE_PHASE_POLICY.policy.phases,
          delete: {
            ...DELETE_PHASE_POLICY.policy.phases.delete,
            actions: {
              ...DELETE_PHASE_POLICY.policy.phases.delete?.actions,
              wait_for_snapshot: {
                policy: NEW_SNAPSHOT_POLICY_NAME,
              },
            },
          },
        },
        name: DELETE_PHASE_POLICY.name,
      };

      expect(httpSetup.post).toHaveBeenLastCalledWith(
        `${API_BASE_PATH}/policies`,
        expect.objectContaining({ body: JSON.stringify(expected) })
      );
    });

    test('shows a callout when the input is not an existing policy', async () => {
      const { actions } = testBed;

      await actions.delete.setSnapshotPolicy('my_custom_policy');
      expect(actions.delete.hasNoPoliciesCallout()).toBeFalsy();
      expect(actions.delete.hasPolicyErrorCallout()).toBeFalsy();
      expect(actions.delete.hasCustomPolicyCallout()).toBeTruthy();
    });

    test('removes the action if field is empty', async () => {
      const { actions } = testBed;

      await actions.delete.setSnapshotPolicy('');
      await actions.savePolicy();

      const expected = {
        phases: {
          ...DELETE_PHASE_POLICY.policy.phases,
          delete: {
            ...DELETE_PHASE_POLICY.policy.phases.delete,
            actions: {
              ...DELETE_PHASE_POLICY.policy.phases.delete?.actions,
            },
          },
        },
        name: DELETE_PHASE_POLICY.name,
      };

      delete expected.phases.delete.actions.wait_for_snapshot;

      expect(httpSetup.post).toHaveBeenLastCalledWith(
        `${API_BASE_PATH}/policies`,
        expect.objectContaining({ body: JSON.stringify(expected) })
      );
    });

    test('shows a callout when there are no snapshot policies', async () => {
      // need to call setup on testBed again for it to use a newly defined snapshot policies response
      httpRequestsMockHelpers.setLoadSnapshotPolicies([]);
      await act(async () => {
        testBed = await setupDeleteTestBed(httpSetup);
      });

      const { component, actions } = testBed;
      component.update();

      expect(actions.delete.hasCustomPolicyCallout()).toBeFalsy();
      expect(actions.delete.hasPolicyErrorCallout()).toBeFalsy();
      expect(actions.delete.hasNoPoliciesCallout()).toBeTruthy();
    });

    test('shows a callout when there is an error loading snapshot policies', async () => {
      // need to call setup on testBed again for it to use a newly defined snapshot policies response
      httpRequestsMockHelpers.setLoadSnapshotPolicies([], { statusCode: 500, message: 'error' });

      await act(async () => {
        testBed = await setupDeleteTestBed(httpSetup);
      });

      const { component, actions } = testBed;
      component.update();

      expect(actions.delete.hasCustomPolicyCallout()).toBeFalsy();
      expect(actions.delete.hasNoPoliciesCallout()).toBeFalsy();
      expect(actions.delete.hasPolicyErrorCallout()).toBeTruthy();
    });
  });
});
