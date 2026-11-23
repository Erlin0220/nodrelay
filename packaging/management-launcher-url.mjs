export function managementLauncherUrl(archiveUrl, explicitUrl) {
  const url = explicitUrl === undefined ? new URL('install-macos.sh', archiveUrl) : new URL(explicitUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/install-macos.sh')) {
    throw new Error('Use a public HTTPS launcher URL ending in /install-macos.sh, without credentials, query or fragment.');
  }
  return url;
}
