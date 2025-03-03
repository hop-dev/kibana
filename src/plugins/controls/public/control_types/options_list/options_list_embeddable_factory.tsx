/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import deepEqual from 'fast-deep-equal';

import { EmbeddableFactoryDefinition, IContainer } from '@kbn/embeddable-plugin/public';
import { OptionsListEditorOptions } from './options_list_editor_options';
import { ControlEmbeddable, DataControlField, IEditableControlFactory } from '../../types';
import { OptionsListEmbeddableInput, OPTIONS_LIST_CONTROL } from './types';
import {
  createOptionsListExtract,
  createOptionsListInject,
} from '../../../common/control_types/options_list/options_list_persistable_state';
import { OptionsListStrings } from './options_list_strings';

export class OptionsListEmbeddableFactory
  implements EmbeddableFactoryDefinition, IEditableControlFactory<OptionsListEmbeddableInput>
{
  public type = OPTIONS_LIST_CONTROL;
  public canCreateNew = () => false;

  constructor() {}

  public async create(initialInput: OptionsListEmbeddableInput, parent?: IContainer) {
    const { OptionsListEmbeddable } = await import('./options_list_embeddable');
    return Promise.resolve(new OptionsListEmbeddable(initialInput, {}, parent));
  }

  public presaveTransformFunction = (
    newInput: Partial<OptionsListEmbeddableInput>,
    embeddable?: ControlEmbeddable<OptionsListEmbeddableInput>
  ) => {
    if (
      embeddable &&
      ((newInput.fieldName && !deepEqual(newInput.fieldName, embeddable.getInput().fieldName)) ||
        (newInput.dataViewId && !deepEqual(newInput.dataViewId, embeddable.getInput().dataViewId)))
    ) {
      // if the field name or data view id has changed in this editing session, selected options are invalid, so reset them.
      newInput.selectedOptions = [];
    }
    return newInput;
  };

  public isFieldCompatible = (dataControlField: DataControlField) => {
    if (
      (dataControlField.field.aggregatable && dataControlField.field.type === 'string') ||
      dataControlField.field.type === 'boolean'
    ) {
      dataControlField.compatibleControlTypes.push(this.type);
    }
  };

  public controlEditorOptionsComponent = OptionsListEditorOptions;

  public isEditable = () => Promise.resolve(false);

  public getDisplayName = () => OptionsListStrings.getDisplayName();
  public getIconType = () => 'editorChecklist';
  public getDescription = () => OptionsListStrings.getDescription();

  public inject = createOptionsListInject();
  public extract = createOptionsListExtract();
}
