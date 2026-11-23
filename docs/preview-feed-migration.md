# Preview upgrade feed cutover (.15 to .16)

The .15 management installer included the feed base
`https://raw.githubusercontent.com/Erlin0220/nodrelay-downloads/refs/heads/macos-preview/updates/`.
The new preview installer must be signed for
`https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/updates/`.
Keep the current signing key, existing OAuth client and callback. Do not change the stable channel.

1. Build from the reviewed public source revision and use the exact Worker and three native archives in the enrollment preflight. Publish native archives to canonical anonymous HTTPS URLs before either signing command. Sign the management manifest with the new preview feed; sign web upgrade with the same key, channel `preview`, `--enrollment-catalog` and `--migrate-preview-feed`. Do not reuse the pre-migration Worker hash.
2. Publish the exact signed trio (manifest, signature, Worker) to the public `updates` branch at `preview/v2/` and to the old `macos-preview` branch at `updates/migration/preview/v2/`. Stage all three files together on each ref; verify anonymous direct HTTP 200 and matching bytes on both sides before switching the old short launcher's target to the signed .16 installer. **Do not publish the migration at the old `updates/preview/v2/`**. An unmodified .15 Worker probes it before schema 1 and cannot validate the new migration field; retain its previous feed and 404 fallback.
3. The administrator runs the original one-line command. The signed installer recognizes only the exact legacy preview feed, checks the matching signed releases at both locations before writing, and preserves the installed D1, OAuth and domain. It may repair only the required public enrollment routes. The staged Worker is read back before switching traffic; retries reconcile the journal rather than resubmitting.
4. After owner verification, check the active version's `NODRELAY_UPGRADE_FEED`, case-sensitive browser upgrade route, old device list, and an unchanged retry. Keep this bridge available until all targeted preview installations have moved. Do not advance the destination v2 feed past .16 before this checkpoint. Also keep the old short launcher usable during the transition.

## What still depends on the downloads repository

- The pre-cutover raw launcher and old signed legacy preview feed.
- Versioned v0.1.0 native archives referenced by existing signed catalogs and installed version records; same-version repair and outstanding legacy commands still need their original URLs.
- Current README links and the macOS installation guide (update only once a new download returns anonymously); the runtime OAuth experiment contains a historical reference.
- Other deployed accounts and any previously shared command were not inventoried here. An OAuth access restriction is not proof that no other deployment or published URL depends on the repo.

Do not delete the repository as part of this release. Retirement is a separate task after deployment, repair/rollback and reference inventory. A local backup alone does not keep a signed public URL working.
