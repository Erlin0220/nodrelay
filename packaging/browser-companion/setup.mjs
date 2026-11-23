import { attachBrowserBackend } from '../fleet/src/browser-setup.mjs';

await attachBrowserBackend(process.env.NODRELAY_BROWSER_BACKEND_CONFIG, process.argv[2]);
