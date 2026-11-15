// -----------------------------------------------------------------------------
// Entry point of the `receiver` sub-container (manifest `containers[].command`).
// Same image as the main container, another program: no Gladys identity here
// (a sub-container gets no token), only the syslog ports.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Receiver } from './receiver.js';

const logger = createLogger({ name: 'syslog-receiver' });
const receiver = new Receiver();

const stop = (signal) => {
  logger.info(`Received ${signal}, stopping`);
  receiver.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

receiver.start().catch((err) => {
  logger.error(`Cannot start the receiver: ${err.message}`);
  process.exit(1);
});
