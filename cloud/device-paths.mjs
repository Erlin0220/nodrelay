export const enrollPath = '/device/enroll';
export const activatePath = '/device/activate';
export const activationErrorCodes = Object.freeze([
  'route_unavailable', 'unexpected_mcp', 'tool_catalog_pending', 'tunnel_pending',
]);
export const supportedEnrollmentTargets = Object.freeze(['macos-arm64', 'windows-x64', 'linux-x64']);

export const installPath = platform => '/device/install/' + platform;

// Stable public entry scripts, published from the repository root like
// Komari's agent installer. They contain no credentials or console address.
export const publicInstallerBase = 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/';
export const operatingSystems = {
  macos: { label: 'macOS', architectures: ['arm64', 'x64'] },
  windows: { label: 'Windows', architectures: ['x64'] },
  linux: { label: 'Linux', architectures: ['x64', 'arm64'] },
};

export function hostedInstallers(releases) {
  const groups = {};
  for (const [platform, { architectures }] of Object.entries(operatingSystems)) {
    const assets = Object.fromEntries(architectures.flatMap(architecture => {
      const asset = releases[`${platform}-${architecture}`];
      return asset?.url ? [[architecture, asset]] : [];
    }));
    const available = Object.values(assets);
    if (!available.length) continue;
    const { version, browser } = available[0];
    if (available.some(asset => asset.version !== version || asset.browser !== browser)) {
      throw new Error(`Hosted ${operatingSystems[platform].label} installers must share the same version and capabilities`);
    }
    groups[platform] = { version, browser, assets };
  }
  return groups;
}
