/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { EuiBasicTableColumn } from '@elastic/eui';
import {
  EuiButtonGroup,
  EuiButtonIcon,
  EuiCallOut,
  EuiInMemoryTable,
  EuiSpacer,
  EuiTitle,
} from '@elastic/eui';
import { useExpandableFlyoutApi } from '@kbn/expandable-flyout';
import type { ReactNode } from 'react';
import React, { useCallback, useMemo, useState } from 'react';
import { FormattedMessage } from '@kbn/i18n-react';
import { ALERT_RULE_NAME } from '@kbn/rule-data-utils';
import { get } from 'lodash/fp';
import type { CriticalityLevel } from '../../../../../../common/entity_analytics/asset_criticality/types';
import { getWatchlistName } from '../../../../../../common/entity_analytics/watchlists/constants';
import { ALERT_PREVIEW_BANNER } from '../../../../../flyout/document_details/preview/constants';
import { DocumentDetailsPreviewPanelKey } from '../../../../../flyout/document_details/shared/constants/panel_keys';
import { useGlobalTime } from '../../../../../common/containers/use_global_time';
import { useQueryInspector } from '../../../../../common/components/page/manage_query';
import { formatRiskScore } from '../../../../common';
import type {
  InputAlert,
  UseRiskContributingAlertsResult,
} from '../../../../hooks/use_risk_contributing_alerts';
import { useRiskContributingAlerts } from '../../../../hooks/use_risk_contributing_alerts';
import { PreferenceFormattedDate } from '../../../../../common/components/formatted_date';

import { useRiskScore } from '../../../../api/hooks/use_risk_score';
import { useGetWatchlists } from '../../../../api/hooks/use_get_watchlists';
import type { EntityRiskScore, EntityType } from '../../../../../../common/search_strategy';
import { buildEntityNameFilter } from '../../../../../../common/search_strategy';
import { AssetCriticalityBadge } from '../../../asset_criticality';
import { RiskInputsUtilityBar } from '../../components/utility_bar';
import { ActionColumn } from '../../components/action_column';
import { AskAiAssistant } from './ask_ai_assistant';
import { useResolutionGroup } from '../../../entity_resolution/hooks/use_resolution_group';
import {
  getEntityId,
  getEntityName,
  getEntityRiskScore,
  getEntitySource,
} from '../../../entity_resolution/helpers';
import {
  ENTITY_ID_COLUMN,
  ENTITY_NAME_COLUMN,
  RISK_SCORE_COLUMN,
  SOURCE_COLUMN,
} from '../../../entity_resolution/translations';

export interface RiskInputsTabProps<T extends EntityType> {
  entityType: T;
  entityName: string;
  scopeId: string;
  entityId?: string;
}

const FIRST_RECORD_PAGINATION = {
  cursorStart: 0,
  querySize: 1,
};

export const EXPAND_ALERT_TEST_ID = 'risk-input-alert-preview-button';
export const RISK_INPUTS_TAB_QUERY_ID = 'RiskInputsTabQuery';

export const RiskInputsTab = <T extends EntityType>({
  entityType,
  entityName,
  scopeId,
  entityId,
}: RiskInputsTabProps<T>) => {
  const { setQuery, deleteQuery } = useGlobalTime();
  const [selectedItems, setSelectedItems] = useState<InputAlert[]>([]);
  const [selectedView, setSelectedView] = useState<'entity' | 'resolution'>('entity');
  const { openPreviewPanel } = useExpandableFlyoutApi();
  const { data: watchlists } = useGetWatchlists();

  const openAlertPreview = useCallback(
    (id: string, indexName: string) =>
      openPreviewPanel({
        id: DocumentDetailsPreviewPanelKey,
        params: {
          id,
          indexName,
          scopeId,
          isPreviewMode: true,
          banner: ALERT_PREVIEW_BANNER,
        },
      }),
    [openPreviewPanel, scopeId]
  );

  const nameFilterQuery = useMemo(() => {
    return buildEntityNameFilter(entityType, [entityName]);
  }, [entityName, entityType]);

  const {
    data: riskScoreData,
    error: riskScoreError,
    loading: loadingRiskScore,
    inspect: inspectRiskScore,
    refetch,
  } = useRiskScore<T>({
    riskEntity: entityType,
    filterQuery: nameFilterQuery,
    onlyLatest: false,
    pagination: FIRST_RECORD_PAGINATION,
    skip: nameFilterQuery === undefined,
  });

  const { data: resolutionGroup } = useResolutionGroup(entityId ?? '', {
    enabled: Boolean(entityId),
  });
  const resolutionTargetEntityId = useMemo(
    () => (resolutionGroup?.target ? getEntityId(resolutionGroup.target) : undefined),
    [resolutionGroup?.target]
  );
  const resolutionFilterQuery = useMemo(
    () =>
      resolutionTargetEntityId
        ? {
            bool: {
              filter: [
                buildEntityNameFilter(entityType, [resolutionTargetEntityId]),
                { term: { [`${entityType}.risk.score_type`]: 'resolution' } },
              ],
            },
          }
        : undefined,
    [entityType, resolutionTargetEntityId]
  );
  const {
    data: resolutionRiskScoreData,
    loading: loadingResolutionRiskScore,
    inspect: inspectResolutionRiskScore,
    refetch: refetchResolutionRiskScore,
  } = useRiskScore<T>({
    riskEntity: entityType,
    filterQuery: resolutionFilterQuery,
    onlyLatest: false,
    pagination: FIRST_RECORD_PAGINATION,
    skip: !resolutionTargetEntityId,
  });

  const entityRiskScore = riskScoreData && riskScoreData.length > 0 ? riskScoreData[0] : undefined;
  const resolutionRiskScore =
    resolutionRiskScoreData && resolutionRiskScoreData.length > 0
      ? resolutionRiskScoreData[0]
      : undefined;
  const hasResolutionScore = Boolean(resolutionRiskScore);
  const isResolutionView = selectedView === 'resolution' && hasResolutionScore;
  const activeRiskScore = isResolutionView ? resolutionRiskScore : entityRiskScore;
  const activeInspectRiskScore = isResolutionView ? inspectResolutionRiskScore : inspectRiskScore;
  const activeRiskScoreLoading = isResolutionView ? loadingResolutionRiskScore : loadingRiskScore;
  const activeRiskScoreRefetch = isResolutionView ? refetchResolutionRiskScore : refetch;
  const relatedEntityIds = useMemo(
    () =>
      activeRiskScore?.[entityType].risk.related_entities
        ?.map((relatedEntity) => relatedEntity.entity_id)
        .filter((relatedEntityId): relatedEntityId is string => Boolean(relatedEntityId)) ?? [],
    [activeRiskScore, entityType]
  );
  const watchlistNamesById = useMemo(() => {
    const map = new Map<string, string>();
    (watchlists ?? []).forEach((watchlist) => {
      if (watchlist.id) {
        map.set(watchlist.id, watchlist.name);
      }
    });
    return map;
  }, [watchlists]);

  useQueryInspector({
    deleteQuery,
    inspect: activeInspectRiskScore,
    loading: activeRiskScoreLoading,
    queryId: RISK_INPUTS_TAB_QUERY_ID,
    refetch: activeRiskScoreRefetch,
    setQuery,
  });

  const alerts = useRiskContributingAlerts<T>({ riskScore: activeRiskScore, entityType });

  const euiTableSelectionProps = useMemo(
    () => ({
      initialSelected: [],
      selectable: () => true,
      onSelectionChange: setSelectedItems,
    }),
    []
  );

  const inputColumns: Array<EuiBasicTableColumn<InputAlert>> = useMemo(
    () => [
      {
        render: (data: InputAlert) => (
          <EuiButtonIcon
            iconType="expand"
            data-test-subj={EXPAND_ALERT_TEST_ID}
            onClick={() => openAlertPreview(data._id, data.input.index)}
            aria-label={i18n.translate(
              'xpack.securitySolution.flyout.right.alertPreview.ariaLabel',
              {
                defaultMessage: 'Preview alert with id {id}',
                values: { id: data._id },
              }
            )}
          />
        ),
        width: '5%',
      },
      {
        name: (
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.actionsColumn"
            defaultMessage="Actions"
          />
        ),
        width: '80px',
        render: (data: InputAlert) => <ActionColumn input={data} />,
      },
      {
        field: 'input.timestamp',
        name: (
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.dateColumn"
            defaultMessage="Date"
          />
        ),
        truncateText: false,
        mobileOptions: { show: true },
        sortable: true,
        width: '30%',
        render: (timestamp: string) => <PreferenceFormattedDate value={new Date(timestamp)} />,
      },
      {
        field: 'alert',
        'data-test-subj': 'risk-input-table-description-cell',
        name: (
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.riskInputColumn"
            defaultMessage="Rule name"
          />
        ),
        truncateText: true,
        mobileOptions: { show: true },
        sortable: true,
        render: (alert: InputAlert['alert']) => get(ALERT_RULE_NAME, alert),
      },
      {
        field: 'input.contribution_score',
        'data-test-subj': 'risk-input-table-contribution-cell',
        name: (
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.contributionColumn"
            defaultMessage="Contribution"
          />
        ),
        truncateText: false,
        mobileOptions: { show: true },
        sortable: true,
        align: 'right',
        render: formatContribution,
      },
    ],
    [openAlertPreview]
  );
  const contributingEntitiesRows = useMemo<ResolutionContributingEntityRow[]>(() => {
    if (!isResolutionView || relatedEntityIds.length === 0) {
      return [];
    }

    const relatedEntityIdSet = new Set(relatedEntityIds);
    const resolutionEntities = resolutionGroup
      ? [resolutionGroup.target, ...resolutionGroup.aliases]
      : [];
    const matchingResolutionEntities = resolutionEntities.filter((entity) =>
      relatedEntityIdSet.has(getEntityId(entity))
    );

    if (matchingResolutionEntities.length > 0) {
      return matchingResolutionEntities.map((entity) => ({
        entityName: getEntityName(entity),
        entityId: getEntityId(entity),
        source: getEntitySource(entity),
        riskScore: getEntityRiskScore(entity),
      }));
    }

    return relatedEntityIds.map((entityIdentifier) => ({
      entityName: entityIdentifier,
      entityId: entityIdentifier,
      source: '-',
      riskScore: undefined,
    }));
  }, [isResolutionView, relatedEntityIds, resolutionGroup]);
  const contributingEntitiesColumns: Array<EuiBasicTableColumn<ResolutionContributingEntityRow>> =
    useMemo(
      () => [
        {
          field: 'entityName',
          name: ENTITY_NAME_COLUMN,
        },
        {
          field: 'entityId',
          name: ENTITY_ID_COLUMN,
        },
        {
          field: 'source',
          name: SOURCE_COLUMN,
        },
        {
          field: 'riskScore',
          name: RISK_SCORE_COLUMN,
          align: 'right',
          render: (riskScore: ResolutionContributingEntityRow['riskScore']) =>
            riskScore != null ? Math.round(riskScore) : '-',
        },
      ],
      []
    );

  if (riskScoreError) {
    return (
      <EuiCallOut
        announceOnMount
        title={
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.errorTitle"
            defaultMessage="Something went wrong"
          />
        }
        color="danger"
        iconType="error"
      >
        <p>
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.errorBody"
            defaultMessage="Error while fetching risk inputs. Please try again later."
          />
        </p>
      </EuiCallOut>
    );
  }

  const contributingEntitiesSection =
    isResolutionView && contributingEntitiesRows.length > 0 ? (
      <>
        <EuiTitle size="xs" data-test-subj="risk-input-related-entities-title">
          <h3>
            <FormattedMessage
              id="xpack.securitySolution.flyout.entityDetails.riskInputs.relatedEntitiesTitle"
              defaultMessage="Contributing entities"
            />
          </h3>
        </EuiTitle>
        <EuiSpacer size="xs" />
        <EuiInMemoryTable
          compressed
          data-test-subj="risk-input-related-entities-table"
          items={contributingEntitiesRows}
          columns={contributingEntitiesColumns}
          sorting={true}
          tableCaption={i18n.translate(
            'xpack.securitySolution.flyout.entityDetails.riskInputs.relatedEntitiesTableCaption',
            {
              defaultMessage: 'Entities contributing to the resolution risk score',
            }
          )}
        />
      </>
    ) : null;

  const riskInputsAlertSection = (
    <>
      <EuiTitle size="xs" data-test-subj="risk-input-alert-title">
        <h3>
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.alertsTitle"
            defaultMessage="Alerts"
          />
        </h3>
      </EuiTitle>
      <EuiSpacer size="xs" />
      <RiskInputsUtilityBar riskInputs={selectedItems} />
      <EuiInMemoryTable
        compressed
        loading={activeRiskScoreLoading || alerts.loading}
        items={alerts.data || []}
        columns={inputColumns}
        sorting
        selection={euiTableSelectionProps}
        itemId="_id"
        tableCaption={i18n.translate(
          'xpack.securitySolution.flyout.entityDetails.riskInputs.alertsTableCaption',
          {
            defaultMessage: 'Alerts contributing to the risk score',
          }
        )}
      />
      <EuiSpacer size="s" />
      <ExtraAlertsMessage<T> riskScore={activeRiskScore} alerts={alerts} entityType={entityType} />
    </>
  );

  return (
    <>
      {hasResolutionScore && (
        <>
          <EuiButtonGroup
            legend={i18n.translate(
              'xpack.securitySolution.flyout.entityDetails.riskInputs.scoreViewLegend',
              { defaultMessage: 'Risk score view' }
            )}
            buttonSize="compressed"
            options={[
              {
                id: 'entity',
                label: i18n.translate(
                  'xpack.securitySolution.flyout.entityDetails.riskInputs.entityScoreViewLabel',
                  { defaultMessage: 'Entity risk score' }
                ),
              },
              {
                id: 'resolution',
                label: i18n.translate(
                  'xpack.securitySolution.flyout.entityDetails.riskInputs.resolutionScoreViewLabel',
                  { defaultMessage: 'Resolution group risk score' }
                ),
              },
            ]}
            idSelected={selectedView}
            onChange={(id) => setSelectedView(id as 'entity' | 'resolution')}
            data-test-subj="risk-input-score-view-toggle"
          />
          <EuiSpacer size="m" />
        </>
      )}
      {contributingEntitiesSection}
      {contributingEntitiesSection && <EuiSpacer size="m" />}
      <ContextsSection<T>
        loading={activeRiskScoreLoading}
        riskScore={activeRiskScore}
        entityType={entityType}
        watchlistNamesById={watchlistNamesById}
      />
      <EuiSpacer size="m" />
      {riskInputsAlertSection}
      <AskAiAssistant entityType={entityType} entityName={entityName} />
    </>
  );
};

RiskInputsTab.displayName = 'RiskInputsTab';

interface ContextsSectionProps<T extends EntityType> {
  riskScore?: EntityRiskScore<T>;
  entityType: T;
  loading: boolean;
  watchlistNamesById: Map<string, string>;
}

const ContextsSection = <T extends EntityType>({
  riskScore,
  loading,
  entityType,
  watchlistNamesById,
}: ContextsSectionProps<T>) => {
  const contributions = useMemo(() => {
    if (!riskScore) {
      return undefined;
    }

    const modifiers = riskScore[entityType].risk.modifiers ?? [];
    const criticality = riskScore[entityType].risk.modifiers?.find(
      (mod) => mod.type === 'asset_criticality'
    );
    const watchlists = modifiers.filter((mod) => mod.type === 'watchlist');

    if (!criticality && watchlists.length === 0) {
      return undefined;
    }

    return {
      criticality: {
        level: (criticality?.metadata?.criticality_level as CriticalityLevel) ?? null,
        contribution: criticality?.contribution,
      },
      watchlists,
    };
  }, [entityType, riskScore]);

  if (loading || contributions === undefined) {
    return null;
  }
  const { criticality, watchlists } = contributions;

  const items: ContextRow[] = [];

  if (criticality.level != null && criticality.contribution != null) {
    items.push({
      field: (
        <FormattedMessage
          id="xpack.securitySolution.flyout.entityDetails.riskInputs.assetCriticalityField"
          defaultMessage="Asset Criticality Level"
        />
      ),
      value: (
        <AssetCriticalityBadge
          criticalityLevel={criticality.level}
          dataTestSubj="risk-inputs-asset-criticality-badge"
        />
      ),
      contribution: formatContribution(criticality.contribution),
    });
  }

  watchlists.forEach((watchlist) => {
    const watchlistMetadata = watchlist.metadata as
      | {
          watchlist_id?: string;
          is_privileged_user?: boolean;
        }
      | undefined;
    const watchlistId =
      typeof watchlistMetadata?.watchlist_id === 'string' ? watchlistMetadata.watchlist_id : '';
    const watchlistLabel = watchlistId
      ? watchlistNamesById.get(watchlistId) ?? getWatchlistName(watchlistId)
      : i18n.translate(
          'xpack.securitySolution.flyout.entityDetails.riskInputs.unknownWatchlistLabel',
          {
            defaultMessage: 'Unknown watchlist',
          }
        );

    items.push({
      field: (
        <FormattedMessage
          id="xpack.securitySolution.flyout.entityDetails.riskInputs.watchlistField"
          defaultMessage="Watchlist"
        />
      ),
      value: (
        <FormattedMessage
          id="xpack.securitySolution.flyout.entityDetails.riskInputs.watchlistValue"
          defaultMessage="{watchlistName}{privilegedTag}"
          values={{
            watchlistName: watchlistLabel,
            privilegedTag: watchlistMetadata?.is_privileged_user
              ? i18n.translate(
                  'xpack.securitySolution.flyout.entityDetails.riskInputs.privilegedWatchlistSuffix',
                  {
                    defaultMessage: ' (privileged user)',
                  }
                )
              : '',
          }}
        />
      ),
      contribution: formatContribution(watchlist.contribution),
    });
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <EuiTitle size="xs" data-test-subj="risk-input-contexts-title">
        <h3>
          <FormattedMessage
            id="xpack.securitySolution.flyout.entityDetails.riskInputs.contextsTitle"
            defaultMessage="Contexts"
          />
        </h3>
      </EuiTitle>
      <EuiSpacer size="xs" />
      <EuiInMemoryTable
        compressed={true}
        loading={loading}
        data-test-subj="risk-input-contexts-table"
        columns={contextColumns}
        items={items}
        tableCaption={i18n.translate(
          'xpack.securitySolution.flyout.entityDetails.riskInputs.contextsTableCaption',
          {
            defaultMessage: 'Contextual contributions to the risk score',
          }
        )}
      />
    </>
  );
};

interface ContextRow {
  field: ReactNode;
  value: ReactNode;
  contribution: string;
}

const contextColumns: Array<EuiBasicTableColumn<ContextRow>> = [
  {
    field: 'field',
    name: (
      <FormattedMessage
        id="xpack.securitySolution.flyout.entityDetails.riskInputs.fieldColumn"
        defaultMessage="Field"
      />
    ),
    width: '30%',
    render: (field: ContextRow['field']) => field,
  },
  {
    field: 'value',
    name: (
      <FormattedMessage
        id="xpack.securitySolution.flyout.entityDetails.riskInputs.valueColumn"
        defaultMessage="Value"
      />
    ),
    width: '30%',
    render: (val: ContextRow['value']) => val,
  },
  {
    field: 'contribution',
    width: '30%',
    align: 'right',
    name: (
      <FormattedMessage
        id="xpack.securitySolution.flyout.entityDetails.riskInputs.contributionColumn"
        defaultMessage="Contribution"
      />
    ),
    render: (score: ContextRow['contribution']) => score,
  },
];

interface ExtraAlertsMessageProps<T extends EntityType> {
  riskScore?: EntityRiskScore<T>;
  alerts: UseRiskContributingAlertsResult;
  entityType: T;
}

const ExtraAlertsMessage = <T extends EntityType>({
  riskScore,
  alerts,
  entityType,
}: ExtraAlertsMessageProps<T>) => {
  const totals = !riskScore
    ? { count: 0, score: 0 }
    : {
        count: riskScore[entityType].risk.category_1_count,
        score: riskScore[entityType].risk.category_1_score,
      };

  const displayed = {
    count: alerts.data?.length || 0,
    score: alerts.data?.reduce((sum, { input }) => sum + (input.contribution_score || 0), 0) || 0,
  };

  if (displayed.count >= totals.count) {
    return null;
  }
  return (
    <EuiCallOut
      data-test-subj="risk-input-extra-alerts-message"
      size="s"
      title={
        <FormattedMessage
          id="xpack.securitySolution.flyout.entityDetails.riskInputs.extraAlertsMessage"
          defaultMessage="{count} more alerts contributed {score} to the calculated risk score"
          values={{
            count: totals.count - displayed.count,
            score: formatContribution(totals.score - displayed.score),
          }}
        />
      }
      iconType="annotation"
    />
  );
};

const formatContribution = (value: number): string => {
  const fixedValue = formatRiskScore(value);

  // prevent +0.00 for values like 0.0001
  if (fixedValue === '0.00') {
    return fixedValue;
  }

  if (value > 0) {
    return `+${fixedValue}`;
  }

  return fixedValue;
};

interface ResolutionContributingEntityRow {
  entityName: string;
  entityId: string;
  source: string;
  riskScore?: number;
}
