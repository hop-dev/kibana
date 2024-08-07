/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import expect from '@kbn/expect';
import { FtrProviderContext } from '../../../services';

export default function ({ getService }: FtrProviderContext) {
  const ebtServerHelper = getService('kibana_ebt_server');

  describe('kibana_started', () => {
    it('should emit the "kibana_started" event', async () => {
      const [event] = await ebtServerHelper.getEvents(1, { eventTypes: ['kibana_started'] });
      expect(event.event_type).to.eql('kibana_started');
      const uptimePerStep = event.properties.uptime_per_step as Record<
        'constructor' | 'preboot' | 'setup' | 'start',
        Record<'start' | 'end', number>
      >;
      expect(uptimePerStep.constructor.start).to.be.a('number');
      expect(uptimePerStep.constructor.end).to.be.a('number');
      expect(uptimePerStep.preboot.start).to.be.a('number');
      expect(uptimePerStep.preboot.end).to.be.a('number');
      expect(uptimePerStep.setup.start).to.be.a('number');
      expect(uptimePerStep.setup.end).to.be.a('number');
      expect(uptimePerStep.start.start).to.be.a('number');
      expect(uptimePerStep.start.end).to.be.a('number');
    });
  });
}
