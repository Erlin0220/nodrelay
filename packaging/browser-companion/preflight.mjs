import { checkBrowserBackend } from '../fleet/src/browser-setup.mjs';

await checkBrowserBackend(process.env.NODRELAY_BROWSER_BACKEND_CONFIG);
