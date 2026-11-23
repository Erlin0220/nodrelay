// One explicit preview migration, not a generic redirect or host override.
export const legacyPreviewFeed = 'https://raw.githubusercontent.com/Erlin0220/nodrelay-downloads/refs/heads/macos-preview/updates/';
export const legacyPreviewMigrationMirror = legacyPreviewFeed + 'migration/';
export const publicPreviewFeed = 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/updates/';

export function normalizeFeedMigration(input, channel) {
  if (input === undefined) return;
  if (channel !== 'preview' || !input || typeof input !== 'object' ||
      Object.keys(input).length !== 2 || input.from !== legacyPreviewFeed || input.to !== publicPreviewFeed) {
    throw new Error('Invalid signed Nodrelay preview feed migration');
  }
  return Object.freeze({ from: input.from, to: input.to });
}

// The installer baseline was authenticated by managementRelease(). Only that
// exact signed destination may recognize the legacy binding for migration.
export function matchesInstallerFeed(liveFeed, signed) {
  return Boolean(signed?.feed && (liveFeed === signed.feed ||
    (signed.channel === 'preview' && signed.feed === publicPreviewFeed && liveFeed === legacyPreviewFeed)));
}
