/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiAccordion,
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiButtonIcon,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingElastic,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiToolTip,
  EuiCallOut,
} from '@elastic/eui';
import React from 'react';
import type { EntityResolutionSuggestion } from '@kbn/elastic-assistant-common';
import { css } from '@emotion/css';
import { useExpandableFlyoutApi } from '@kbn/expandable-flyout';
import { noop } from 'lodash/fp';
import { JsonCodeEditor } from '@kbn/unified-doc-viewer-plugin/public';
import { RISK_SEVERITY_COLOUR } from '../../../../common';
import type { RiskSeverity } from '../../../../../../common/search_strategy';
import { useRiskScorePreviewMatchedUsers } from '../../../../api/hooks/use_preview_risk_scores_matched_users';
import { SourcererScopeName } from '../../../../../sourcerer/store/model';
import { useDataViewSpec } from '../../../../../data_view_manager/hooks/use_data_view_spec';
import { useIsExperimentalFeatureEnabled } from '../../../../../common/hooks/use_experimental_features';
import { useSourcererDataView } from '../../../../../sourcerer/containers';
import { USER_PREVIEW_BANNER } from '../../../../../flyout/document_details/right/components/user_entity_overview';
import { UserPreviewPanelKey } from '../../../../../flyout/entity_details/user_right';
import { useEntityResolutions } from '../../../../api/hooks/use_entity_resolutions';
import OktaLogo from './icons/okta.svg';
import EntraIdLogo from './icons/entra_id.svg';
import { RiskScoreLevel } from '../../../severity/common';

interface Props {
  username: string;
  scopeId: string;
}

const RiskScorePreviewSection: React.FC<{
  relatedEntitiesDocs: EntityResolutionSuggestion[];
  username: string;
}> = ({ relatedEntitiesDocs, username }) => {
  const { sourcererDataView: oldSourcererDataView } = useSourcererDataView(
    SourcererScopeName.detections
  );

  const newDataViewPickerEnabled = useIsExperimentalFeatureEnabled('newDataViewPickerEnabled');
  const { dataViewSpec } = useDataViewSpec(SourcererScopeName.detections);

  const sourcererDataView = newDataViewPickerEnabled ? dataViewSpec : oldSourcererDataView;

  const { data, isLoading, refetch, isError, error } = useRiskScorePreviewMatchedUsers({
    data_view_id: sourcererDataView.title,
    matched_entities: [...relatedEntitiesDocs.map((doc) => doc.user.name), username],
    range: {
      start: 'now-30d',
      end: 'now',
    },
    exclude_alert_statuses: ['closed'],
    skip: relatedEntitiesDocs.length === 0,
  });

  if (isError) {
    return (
      <EuiCallOut
        data-test-subj="risk-preview-error"
        title={'Error'}
        color="danger"
        iconType="error"
      >
        <p>{'An error occurred while fetching the risk score preview.'}</p>
        <p>{JSON.stringify(error)}</p>
        <EuiButton
          data-test-subj="risk-preview-error-button"
          color="danger"
          onClick={() => refetch()}
        >
          {'Retry'}
        </EuiButton>
      </EuiCallOut>
    );
  }

  if (isLoading) {
    return <EuiLoadingElastic size="xl" />;
  }
  const normalisedRiskScore = data?.scores?.user?.[0].calculated_score_norm as number;
  const riskLevel = data?.scores?.user?.[0].calculated_level as RiskSeverity;
  const badgeColor = RISK_SEVERITY_COLOUR[riskLevel];
  return (
    <>
      <EuiTitle size="s">
        <h3>{'Summary'}</h3>
      </EuiTitle>
      <EuiSpacer size="m" />
      <EuiPanel hasBorder paddingSize="m">
        <EuiFlexGroup direction="column" gutterSize="s">
          <EuiFlexItem>
            <EuiFlexGroup alignItems="center" justifyContent="spaceBetween">
              <EuiFlexItem grow={false}>
                <EuiText size="s">
                  <strong>{'Combined Risk Level:'}</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <RiskScoreLevel severity={riskLevel} />
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="s" />
            <EuiFlexGroup alignItems="center" justifyContent="spaceBetween">
              <EuiFlexItem grow={false}>
                <EuiText size="s">
                  <strong>{'Combined Risk Score:'}</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color={badgeColor}>
                  {normalisedRiskScore ? normalisedRiskScore.toFixed(2) : 'N/A'}
                </EuiBadge>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="s" />
            <EuiFlexGroup alignItems="center" justifyContent="spaceBetween">
              <EuiFlexItem grow={false}>
                <EuiText size="s">
                  <strong>{'Number of confirmed matches:'}</strong>
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color="primary">{relatedEntitiesDocs.length}</EuiBadge>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    </>
  );
};

export const EntityResolutionTab = ({ username, scopeId }: Props) => {
  const ER = useEntityResolutions({ name: username, type: 'user' });

  const [updating, setUpdating] = React.useState<Record<string, boolean>>({});
  const toggleUpdating = (id: string) => setUpdating((prev) => ({ ...prev, [id]: !prev[id] }));

  const resolve = (id: string, name: string, relation: 'is_same' | 'is_different') => {
    toggleUpdating(id);
    ER.markResolved({ id, type: 'user', name }, relation);
  };

  const { openPreviewPanel } = useExpandableFlyoutApi();

  const openPreview = (userName: string) =>
    openPreviewPanel({
      id: UserPreviewPanelKey,
      params: {
        userName,
        scopeId,
        banner: USER_PREVIEW_BANNER,
      },
    });

  if (ER.verifications.isLoading) {
    return <EuiLoadingElastic size="xl" />;
  }

  const relatedEntitiesDocs = ER.verifications.data?.relatedEntitiesDocs || [];

  const related = ER.verifications.data && relatedEntitiesDocs.length > 0 && (
    <>
      <EuiTitle size="s">
        <h3>{'Confirmed Matches'}</h3>
      </EuiTitle>
      <EuiSpacer size="m" />

      {relatedEntitiesDocs.map((doc) => (
        <RelatedEntity
          doc={doc}
          id={doc.entity.id}
          name={doc.user.name}
          key={doc.entity.id}
          openPreviewPanel={() => openPreview(doc?.user.name)}
        />
      ))}
    </>
  );
  return (
    <EuiPanel color="transparent" hasBorder={false}>
      {relatedEntitiesDocs.length > 0 && (
        <>
          <RiskScorePreviewSection relatedEntitiesDocs={relatedEntitiesDocs} username={username} />
          <EuiSpacer size="m" />
        </>
      )}
      <EuiSpacer size="m" />

      {related}
      <EuiSpacer size="m" />

      <CandidatesSection
        setScanning={ER.setScanning}
        state={
          ER.scanning
            ? 'scanning'
            : !ER.candidateData
            ? 'init'
            : ER.resolutions.candidates?.length === 0
            ? 'no_candidates'
            : 'data'
        }
        relatedEntitiesDocs={relatedEntitiesDocs}
      >
        {ER.resolutions.candidates?.map((candidate) => (
          <Candidate
            key={candidate.id}
            {...candidate}
            resolve={resolve}
            updating={updating}
            openPreviewPanel={() => openPreview(candidate.entity?.name)}
          />
        ))}
      </CandidatesSection>
      <EuiSpacer size="m" />
    </EuiPanel>
  );
};

interface CandidatesSectionProps {
  state: 'init' | 'scanning' | 'no_candidates' | 'data';
  setScanning: (value: boolean) => void;
  children: React.ReactNode;
  relatedEntitiesDocs: EntityResolutionSuggestion[];
}

const CandidatesSection: React.FC<CandidatesSectionProps> = ({
  state,
  children,
  setScanning,
  relatedEntitiesDocs,
}) => {
  return (
    <>
      <EuiTitle size="s">
        <h3>{'Potential Matches'}</h3>
      </EuiTitle>
      <EuiSpacer size="l" />
      {state === 'init' || state === 'scanning' ? (
        <EuiFlexGroup justifyContent="spaceAround" alignItems="center">
          <EuiFlexItem grow={false}>
            <EuiButton
              iconType="indexMapping"
              css={{ minWidth: 220 }}
              isLoading={state === 'scanning'}
              onClick={() => setScanning(true)}
            >
              {state === 'scanning'
                ? 'Finding matching entities'
                : relatedEntitiesDocs.length > 0
                ? 'Rescan for matching entities'
                : 'Find matching entities'}
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : state === 'no_candidates' ? (
        <EuiText>{'No candidates found'}</EuiText>
      ) : (
        children
      )}

      <EuiSpacer size="m" />
    </>
  );
};

type CandidateProps = EntityResolutionSuggestion & {
  resolve: (id: string, name: string, relation: 'is_same' | 'is_different') => void;
  updating: Record<string, boolean>;
  openPreviewPanel: (id: string) => void;
  confidence: string;
  reason: string;
  document: {
    data_source: string;
  };
  id?: string;
  entity: {
    name: string;
    type: string;
  };
};

const EntityLogo: React.FC<{
  document?: {
    data_source: string;
  };
}> = ({ document }) => {
  if (document?.entity.source.includes('okta')) {
    return <EuiIcon size="l" type={OktaLogo} />;
  }

  if (document?.entity.source.includes('entra')) {
    return <EuiIcon type={EntraIdLogo} size="l" />;
  }

  return <EuiIcon type="logoSecurity" size="l" />;
};

const ConfidenceBadge: React.FC<{ confidence: string }> = ({ confidence }) => {
  const color = confidence === 'high' ? 'success' : confidence === 'medium' ? 'warning' : 'danger';
  return <EuiBadge color={color}>{`${confidence} confidence`}</EuiBadge>;
};

const Candidate: React.FC<CandidateProps> = ({
  entity,
  confidence,
  document,
  id = '',
  reason,
  resolve = noop,
  updating,
  openPreviewPanel = noop,
}) => {
  if (!entity) return null;

  const entityDataContent = (
    <EuiFlexGroup justifyContent="flexStart" alignItems="center">
      <EntityLogo document={document} />
      <EuiFlexItem
        css={css`
          max-width: 150px;
        `}
      >
        <EuiText size="m">{entity.name}</EuiText>
      </EuiFlexItem>

      <EuiFlexItem>
        <EuiFlexGroup justifyContent="flexStart" alignItems="center">
          <EuiToolTip position="bottom" title="Reason" content={reason}>
            <ConfidenceBadge confidence={confidence} />
          </EuiToolTip>
        </EuiFlexGroup>
      </EuiFlexItem>
    </EuiFlexGroup>
  );

  const entityActions = (
    <EuiFlexGroup justifyContent="flexEnd" alignItems="center">
      {updating[id] ? (
        <EuiLoadingSpinner size="m" />
      ) : (
        <>
          <EuiButtonEmpty size="s" onClick={() => resolve(id, entity.name, 'is_different')}>
            {'Not a match'}
          </EuiButtonEmpty>
          <EuiButton size="s" iconType="check" onClick={() => resolve(id, entity.name, 'is_same')}>
            {'Confirm match'}
          </EuiButton>
        </>
      )}
      <EuiButtonIcon onClick={() => openPreviewPanel(id)} iconType="expand" aria-label="Preview" />
    </EuiFlexGroup>
  );
  return (
    <>
      <EuiPanel hasBorder>
        <EuiAccordion id={id} buttonContent={entityDataContent} extraAction={entityActions}>
          <EuiSpacer size="m" />
          <JsonCodeEditor json={document as unknown as Record<string, unknown>} height={300} />
        </EuiAccordion>
      </EuiPanel>
      <EuiSpacer size="xs" />
    </>
  );
};

interface RelatedEntityProps {
  doc: {};
  id: string;
  name: string;
  openPreviewPanel: (id: string) => void;
}

const RelatedEntity: React.FC<RelatedEntityProps> = ({
  id,
  name,
  openPreviewPanel = noop,
  doc,
}) => {
  console.log('doc', doc);
  const entityDataContent = (
    <EuiFlexGroup justifyContent="flexStart" alignItems="center">
      <EntityLogo document={doc} />
      <EuiFlexItem
        css={css`
          max-width: 150px;
        `}
      >
        <EuiText size="m">{name}</EuiText>
      </EuiFlexItem>
    </EuiFlexGroup>
  );

  const entityActions = (
    <EuiFlexGroup justifyContent="flexEnd" alignItems="center">
      <EuiButtonIcon onClick={() => openPreviewPanel(id)} iconType="expand" aria-label="Preview" />
    </EuiFlexGroup>
  );
  return (
    <>
      <EuiPanel hasBorder>
        <EuiAccordion id={id} buttonContent={entityDataContent} extraAction={entityActions}>
          <EuiSpacer size="m" />
          <JsonCodeEditor
            json={{ ...doc, id, name } as unknown as Record<string, unknown>}
            height={300}
          />
        </EuiAccordion>
      </EuiPanel>
      <EuiSpacer size="xs" />
    </>
  );
};
