// -----------------------------------------------------------------------------
// Entry point of the main container: wires the Gladys SDK to the syslog hub
// (src/app.js). The syslog ports live in the `receiver` sub-container
// (src/receiver-main.js), reached over the private network of the integration.
//
// Environment provided by the Gladys supervisor: GLADYS_HOST_API_URL,
// GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR (read by the SDK).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const app = registerHandlers(gladys);

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal}, stopping`);
  return app.stop(); // waits for the last write under /data
});

logger.info('Starting the Syslog integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
