/*

 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one

 * or more contributor license agreements. Licensed under the Elastic License

 * 2.0; you may not use this file except in compliance with the Elastic License

 * 2.0.

 */

import React, { useCallback, useEffect } from 'react';

import type { EuiBasicTableColumn } from '@elastic/eui';

import {
  EuiFlexItem,
  EuiFlexGroup,
  EuiBasicTable,
  EuiButton,
  EuiText,
  EuiSpacer,
} from '@elastic/eui';

import type { EntityResolutionSuggestion } from '@kbn/elastic-assistant-common';

import {
  ATTACK_DISCOVERY_STORAGE_KEY,
  ConnectorSelectorInline,
  DEFAULT_ASSISTANT_NAMESPACE,
  useAssistantContext,
  useLoadConnectors,
} from '@kbn/elastic-assistant';

import { noop } from 'lodash/fp';

import useLocalStorage from 'react-use/lib/useLocalStorage';

import { useSpaceId } from '../../../common/hooks/use_space_id';

import { CONNECTOR_ID_LOCAL_STORAGE_KEY } from '../../../attack_discovery/pages/helpers';

import { EntityDetailsLeftPanelTab } from '../../../flyout/entity_details/shared/components/left_panel/left_panel_header';

import { ExpandablePanel } from '../../../flyout/shared/components/expandable_panel';

import type { UseEntityResolution } from '../../api/hooks/use_entity_resolutions';

interface Props {
  resolution: UseEntityResolution;

  onOpen: (tab: EntityDetailsLeftPanelTab) => void;
}

export const RelatedEntitiesSummary: React.FC<Props> = ({ resolution, onOpen }) => {
  const header = {
    title: <EuiText>{'Entity Resolution'}</EuiText>,

    link: {
      callback: () => onOpen(EntityDetailsLeftPanelTab.OBSERVED_DATA),

      tooltip: 'View all related entities',
    },
  };

  return (
    <ExpandablePanel header={header}>
      <RelatedEntitiesSummaryContent resolution={resolution} onOpen={onOpen} />
    </ExpandablePanel>
  );
};

export const RelatedEntitiesSummaryContent: React.FC<Props> = ({ resolution, onOpen }) => {
  const spaceId = useSpaceId() ?? 'default';

  // get the last selected connector ID from local storage:

  const [localStorageAttackDiscoveryConnectorId, setLocalStorageAttackDiscoveryConnectorId] =
    useLocalStorage<string>(
      `${DEFAULT_ASSISTANT_NAMESPACE}.${ATTACK_DISCOVERY_STORAGE_KEY}.${spaceId}.${CONNECTOR_ID_LOCAL_STORAGE_KEY}`
    );

  const [connectorId, setConnectorId] = React.useState<string | undefined>(
    localStorageAttackDiscoveryConnectorId
  );

  const onConnectorIdSelected = useCallback(
    (selectedConnectorId: string) => {
      setConnectorId(selectedConnectorId);

      setLocalStorageAttackDiscoveryConnectorId(selectedConnectorId);

      resolution.setConnectorId(selectedConnectorId);
    },

    [resolution, setLocalStorageAttackDiscoveryConnectorId]
  );

  const { http } = useAssistantContext();

  const { data: aiConnectors } = useLoadConnectors({
    http,
  });

  useEffect(() => {
    // If there is only one connector, set it as the selected connector

    if (aiConnectors != null && aiConnectors.length === 1) {
      setConnectorId(aiConnectors[0].id);
    } else if (aiConnectors != null && aiConnectors.length === 0) {
      // connectors have been removed, reset the connectorId and cached Attack discoveries

      setConnectorId(undefined);
    }
  }, [aiConnectors, resolution]);

  const isLoadingOrScanning = resolution.verifications.isLoading || resolution.scanning;

  if (
    resolution.verifications.data &&
    resolution.verifications.data.relatedEntitiesDocs.length > 0
  ) {
    return (
      <EuiBasicTable
        tableCaption="Verified as the same entity"
        items={resolution.verifications.data.relatedEntitiesDocs}
        rowHeader="firstName"
        columns={entityColumns}
      />
    );
  }

  const buttonText = isLoadingOrScanning ? 'Finding matching entities' : 'Find matching entities';

  if (!resolution.candidateData) {
    return (
      <>
        <EuiFlexGroup justifyContent="flexEnd" alignItems="center" gutterSize="s">
          <EuiFlexItem grow={false}>
            <ConnectorSelectorInline
              onConnectorSelected={noop}
              onConnectorIdSelected={onConnectorIdSelected}
              selectedConnectorId={connectorId}
            />
          </EuiFlexItem>
        </EuiFlexGroup>
        <EuiSpacer size="s" />
        <EuiFlexGroup justifyContent="spaceAround" gutterSize="s">
          <EuiFlexItem grow={false}>
            <EuiButton
              iconType="indexMapping"
              isLoading={isLoadingOrScanning}
              css={{ minWidth: 220 }}
              onClick={() => {
                resolution.setScanning(true);
                onOpen(EntityDetailsLeftPanelTab.OBSERVED_DATA);
              }}
            >
              {buttonText}
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </>
    );
  }

  return (
    <EuiText>{`Found ${resolution.resolutions.candidates.length} potential entity matches`}</EuiText>
  );
};

const entityColumns: Array<EuiBasicTableColumn<EntityResolutionSuggestion>> = [
  {
    field: 'user.name',

    name: 'Matched entity',

    render: (name: string) => <EuiText>{name}</EuiText>,
  },
];
