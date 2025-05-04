/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiAccordion,
  EuiHorizontalRule,
  EuiSpacer,
  EuiText,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';

import React from 'react';
import { noop } from 'lodash';
import { css } from '@emotion/css';
import type { UserItem } from '../../../../common/search_strategy';
import { useIsExperimentalFeatureEnabled } from '../../../common/hooks/use_experimental_features';
import { AssetCriticalityAccordion } from '../../../entity_analytics/components/asset_criticality/asset_criticality_selector';

import { OBSERVED_USER_QUERY_ID } from '../../../explore/users/containers/users/observed_details';
import { FlyoutRiskSummary } from '../../../entity_analytics/components/risk_summary_flyout/risk_summary';
import type { RiskScoreState } from '../../../entity_analytics/api/hooks/use_risk_score';
import { ManagedUser } from './components/managed_user';
import type { ManagedUserData } from './types';
import { EntityIdentifierFields, EntityType } from '../../../../common/entity_analytics/types';
import { USER_PANEL_RISK_SCORE_QUERY_ID } from '.';
import { FlyoutBody } from '../../shared/components/flyout_body';
import { ObservedEntity } from '../shared/components/observed_entity';
import type { ObservedEntityData } from '../shared/components/observed_entity/types';
import { useObservedUserItems } from './hooks/use_observed_user_items';
import type { EntityDetailsPath } from '../shared/components/left_panel/left_panel_header';
import { EntityInsight } from '../../../cloud_security_posture/components/entity_insight';
import { RelatedEntitiesSummary } from '../../../entity_analytics/components/related_entities/related_entities_summary';
import { useEntityResolutions } from '../../../entity_analytics/api/hooks/use_entity_resolutions';

interface UserPanelContentProps {
  userName: string;
  observedUser: ObservedEntityData<UserItem>;
  managedUser: ManagedUserData;
  riskScoreState: RiskScoreState<EntityType.user>;
  recalculatingScore: boolean;
  contextID: string;
  scopeId: string;
  onAssetCriticalityChange: () => void;
  openDetailsPanel: (path: EntityDetailsPath) => void;
  isPreviewMode?: boolean;
  isLinkEnabled: boolean;
}

export const UserPanelContent = ({
  userName,
  observedUser,
  managedUser,
  riskScoreState,
  recalculatingScore,
  contextID,
  scopeId,
  openDetailsPanel,
  onAssetCriticalityChange,
  isPreviewMode,
  isLinkEnabled,
}: UserPanelContentProps) => {
  const isManagedUserEnable = useIsExperimentalFeatureEnabled('newUserDetailsFlyoutManagedUser');

  return (
    <FlyoutBody>
      {riskScoreState.hasEngineBeenInstalled && riskScoreState.data?.length !== 0 && (
        <>
          <FlyoutRiskSummary
            riskScoreData={riskScoreState}
            recalculatingScore={recalculatingScore}
            queryId={USER_PANEL_RISK_SCORE_QUERY_ID}
            openDetailsPanel={openDetailsPanel}
            isPreviewMode={isPreviewMode}
            isLinkEnabled={isLinkEnabled}
            entityType={EntityType.user}
          />
          <EuiHorizontalRule />
        </>
      )}
      <AssetCriticalityAccordion
        entity={{ name: userName, type: EntityType.user }}
        onChange={onAssetCriticalityChange}
      />
      <EntityInsight
        value={userName}
        field={EntityIdentifierFields.userName}
        isPreviewMode={isPreviewMode}
        isLinkEnabled={isLinkEnabled}
        openDetailsPanel={openDetailsPanel}
      />
      <EntityDetailsSection
        observedUser={observedUser}
        userName={userName}
        contextID={contextID}
        scopeId={scopeId}
        openDetailsPanel={openDetailsPanel}
      />
      <EuiHorizontalRule margin="m" />
      {isManagedUserEnable && (
        <ManagedUser
          managedUser={managedUser}
          contextID={contextID}
          openDetailsPanel={openDetailsPanel}
          isPreviewMode={isPreviewMode}
          isLinkEnabled={isLinkEnabled}
        />
      )}
    </FlyoutBody>
  );
};

type Props = Pick<
  UserPanelContentProps,
  'userName' | 'observedUser' | 'contextID' | 'scopeId' | 'openDetailsPanel'
>;

const EntityDetailsSection: React.FC<Props> = ({
  observedUser,
  userName,
  contextID,
  scopeId,
  openDetailsPanel,
}) => {
  const { euiTheme } = useEuiTheme();
  const observedFields = useObservedUserItems(observedUser);
  const resolution = useEntityResolutions({
    name: userName,
    type: 'user',
  });

  return (
    <>
      <EuiAccordion
        initialIsOpen
        id="entity-details-accordion"
        buttonContent={
          <EuiTitle size="m">
            <h3>
              <EuiText>{'Entity details'}</EuiText>
            </h3>
          </EuiTitle>
        }
        buttonProps={{
          css: css`
            color: ${euiTheme.colors.primary};
          `,
        }}
        data-test-subj="entity-details-accordion"
      >
        <EuiSpacer size="m" />
        <RelatedEntitiesSummary resolution={resolution} onOpen={openDetailsPanel || noop} />
        <EuiSpacer size="m" />
        <ObservedEntity
          observedData={observedUser}
          contextID={contextID}
          scopeId={scopeId}
          observedFields={observedFields}
          queryId={OBSERVED_USER_QUERY_ID}
        />
      </EuiAccordion>
      <EuiSpacer size="m" />
    </>
  );
};
