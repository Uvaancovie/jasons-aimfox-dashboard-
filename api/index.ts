import { createAimfoxApp } from '../server/createAimfoxApp.ts';

const app = createAimfoxApp({
  wsSupported: false,
});

export default app;
