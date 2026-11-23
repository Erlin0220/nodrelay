# Install the Nodrelay management console from macOS

In Mac Terminal (zsh), copy the install command from the [v0.1.1 management release](https://github.com/Erlin0220/nodrelay-downloads/releases/tag/v0.1.1). The short command trusts the versioned GitHub launcher over HTTPS. The [command with a pinned launcher hash](https://github.com/Erlin0220/nodrelay-downloads/releases/download/v0.1.1/install-macos-command.txt) also verifies the launcher before execution. Both commands check the archive and verify the signed release. The signed v0.1.1 catalog uses the v0.1.0 device packages for Apple Silicon macOS, Windows x64, and Linux x64.

Use a publisher-signed Nodrelay release and the publisher's Ed25519 public key
obtained independently of that release. Put the signed manifest, its detached
`.sig` file, and `worker.js` in the same directory. Run this from the management
installer package, or from the Nodrelay checkout after running `npm ci`.

```sh
sh packaging/setup-macos.sh /path/to/management-release.json /path/to/trusted-publisher.pub.pem
```

The command downloads and checks a pinned Node archive, verifies the manifest
and the Worker bundle, and opens Cloudflare authorization. The installer
automatically uses a sole authorized account and a sole eligible active domain.
In a kit built from this checkout, use ↑/↓ to move and Enter to select when
more than one account or domain is available. If the account has no eligible domain, add or activate
one in Cloudflare and run the command again. The official MCP Portal requires
an active Cloudflare domain. A management hostname with an existing DNS record
is rejected.

For a new install from this checkout, use a signed kit whose public OAuth
client has been verified for `user-details.read`. The installer reads the
email of the Cloudflare user who authorized it and uses that exact email for
management and MCP Portal access. Check the address and the configured login
methods in the deployment summary. Use the same Cloudflare identity at the
first login, or receive a One-time PIN at the displayed address if that method
is configured. The installer checks configuration. You complete authentication
in the browser after deployment.

If the selected account has only third-party SSO, select an existing provider
and sign in through the browser. Nodrelay creates a temporary Access OIDC
application with a single selected login method and a loopback callback. It
only verifies identity and has no management endpoint, hostname, or Worker.
Nodrelay verifies the signed ID token for that application and login attempt,
then deletes the temporary application. The deployment summary shows the
verified SSO email and identifies the Cloudflare authorization email when they
differ. Confirm the SSO email before deploying. The new management application
and MCP Portal are restricted to that exact email and that SSO provider.
Existing identity providers and Access applications keep their login settings.
If an interruption leaves the temporary application in place, run the original
command with `--resume` to reconcile and clean it up before starting again.
[Cloudflare Access OIDC application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/).

The installer checks Zero Trust before deploying Nodrelay. Releases signed with
`zeroTrustBootstrap: true` can initialize a missing organization and, only when
no identity providers exist, add One-time PIN after an explicit confirmation.
Cloudflare generates the organization name; no team name needs to be entered.
Existing organizations, login providers and their policies are preserved.
A bare 403 or 404 is not proof of an uninitialized account. An exact account API
response containing the known Access-not-enabled signature is reported as
`access_not_enabled`; it does not authorize creating an organization in this
build. Only that fixed marker is retained, not Cloudflare's raw error message.
Enabling automatic creation from the marker requires separate verification
with the installer's OAuth grant on an uninitialized test account.
For an unavailable organization, missing bootstrap capability, or uncertain API
result, the installer offers the selected account's official dashboard, then
rechecks in the same invocation when you return. It never creates subscriptions,
selects plans, submits payment information or changes billing. Cloudflare may
require you to complete its onboarding yourself; this API path has not been
verified to bypass plan or payment prerequisites.

Creation intentions are saved before requests. After an uncertain result the
installer will only read/reconcile, never automatically replay creation. Finish
or inspect the setup in Cloudflare and choose recheck. Keep the local receipt.

For deployment recovery of an existing console, missing prerequisites are not
automatically recreated. Use the original signed release for recovery.

[Cloudflare organization API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/)
and [Cloudflare onboarding](https://developers.cloudflare.com/cloudflare-one/setup/).

Confirm and Cancel appear on one line. Use ←/→ to change the choice.
For a new installation, Enter accepts the default confirmation. The deployment
name defaults to `nodrelay`. Append `--namespace NAME` if you need a custom
name or are resuming an installation that already uses one. The target device
receives its own one-time enrollment ticket.

If Cloudflare accepts the deployment but an installer or the Access login is
still propagating, the command exits with an error and prints the management
origin and Access issuer. For a kit that supports `--check`, append
`--check MANAGEMENT_ORIGIN ACCESS_ISSUER` to its downloaded installation command. This performs a single
read-only readiness check without refreshing OAuth or changing the deployment.
Use `--plan` to inspect the signed release in scripts. Deployment, resume and
reconnect require an interactive terminal. The administrator address appears in
the deployment summary. Keep any recording of that session private. Legacy
signed manifests remain usable for `--plan`, `--check`, and recovery of the
original deployment. Their installers as originally shipped retain their
previous behavior.

## A first Workers upload returns 10063

Keep your original receipt and use the same account, domain, namespace and OAuth
authorization by rerunning the same installation command. The installer offers account subdomain registration only when the first
Worker upload returns 10063 and Cloudflare reports that the account subdomain
does not exist (10007). The prompt names the exact account-wide change. An
existing subdomain is not changed. An unconfirmed registration is not replayed.

Nodrelay still runs on the selected custom domain. The installer disables the
Worker's workers.dev and preview routes before attaching that domain. Subdomain
registration does not change a billing plan or create a subscription.

## Recover an interrupted installation

Use the same Mac, signed OAuth profile, Cloudflare account, domain and
deployment name. Keep the private deployment receipt in
`~/.nodrelay/management/`. It identifies the original administrator email,
Worker, D1 database, Portal and hostnames.

1. Rerun the same one-line command and select the same Cloudflare account and
   domain. The installer checks the exact receipt and original authorization
   under the target lock. It reads back existing Access applications, Portal,
   DNS and D1 configuration before resuming a failed Worker upload. It does
   not ask you to confirm a generic audit checklist.
2. If the target is already complete, it does not deploy again. If a creation
   result is unknown, an expected resource is missing, or an uploaded Worker
   already exists without a completion receipt, it stops with the specific
   reason rather than recreating a resource or overwriting the Worker.
3. If the previous process is provably stopped and the unfinished receipt
   passes the identity and no-replay checks, the installer archives its lock
   automatically before rechecking Cloudflare. A running or unverified lock
   is not taken by this routine. The legacy
   `--resume` spelling still works and may offer to archive a proven stopped
   lock; it uses the same non-replay checks. Temporary SSO proof cleanup and
   `--reconnect` remain separate operations.

Each Cloudflare request has a 15-second deadline that includes the response
body. Ctrl+C during deployment lets the current request settle before stopping
and releasing the lock. A timed-out write may already have changed a resource.

An older or unreadable lock may lack verifiable metadata. Quit all installers
on that Mac. If it is unclear whether one is running, restart the Mac first.
With all other installers stopped, archive only the exact lock file reported
for the target. Its name may end in `.lock` or `.lock.generation-N`. Leave the
matching `.json` receipt and the installer’s historical lock files in place.
Replace `REPORTED_LOCK_FILENAME` with the name printed by the installer. If
that file has a `.retired` companion and the installer cannot validate the
pair, keep both files for inspection.

```sh
lock="$HOME/.nodrelay/management/REPORTED_LOCK_FILENAME"
mv -n "$lock" "$lock.manual-$(date +%Y%m%d-%H%M%S)"
```

If the target has an unfinished receipt, rerun the original install command. If no receipt exists,
verify in Cloudflare that no resources were left behind before starting a new
deployment. If the audit log or ownership is unclear, keep the receipt and
pause there. The installer cannot roll back earlier API calls.

## Release publisher

Configure a registered Cloudflare OAuth client that supports authorization code
with PKCE, refresh, and the exact loopback callback. For external accounts, prepare the management OAuth client in the publisher's
Cloudflare account. Use an authorized publisher domain and logo in the setup
configuration. Start from the [publisher configuration example](oauth-publisher.example.json). The management profile requests the exact scopes listed below.
An account administrator may restrict public OAuth apps for their account.
On the Cloudflare consent page, select only the account that will own Nodrelay
if you already know the target. The Worker retains the authorized grant with
access to every account approved in the browser.
The operator still needs permission for the requested resources in that
account, an active domain and a configured Zero Trust login method supported by
the installer.
[Cloudflare OAuth authorization](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/).

Inspect the registration payload without credentials.

```sh
npm run setup -- /path/to/oauth-publisher.json --register-oauth --management-oauth --plan
```

Register using a separate, owner-only token file with OAuth Client Read and
Write. Cloudflare creates a private client. For public distribution, the
publisher must verify DNS ownership of the client URL, then explicitly promote
the client in Cloudflare. This promotion is permanent. Nodrelay's registration
command leaves DNS and promotion to the publisher.
[Cloudflare client registration and verification](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/).

For an automatic-administrator release, configure `user-details.read` as the
public client's only optional scope. Keep the previous scopes required so
older installers can continue requesting their original permissions. The new
installer requests `user-details.read` and requires the user to leave **User
Details Read** selected in Cloudflare's consent screen. The commands below
verify the expected scopes and do not update an existing client's configuration.

```sh
npm run setup -- /path/to/oauth-publisher.json --register-oauth --management-oauth --oauth-token-file /private/cf-oauth-client-write.token
npm run setup -- /path/to/oauth-publisher.json --check-public-client OAUTH_CLIENT_ID --oauth-token-file /private/cf-oauth-client-read.token
```

For a new installer that can initialize Zero Trust, set `zeroTrustBootstrap: true`
in the publisher config. Its public client must include `access-acct.write` in
both scopes and optional scopes (alongside optional `user-details.read`). The
signing command verifies this configuration before placing the capability flag
in the signed schema-2 manifest. Do not add this flag to an existing signed file.
Rebuild the Worker with the matching code: the new
`FLEET_OAUTH_ZERO_TRUST_BOOTSTRAP` binding makes its strict refresh validation
accept this exact expanded grant only when Cloudflare actually granted the optional scope.
If declined, existing organizations can still deploy without any bootstrap API writes,
and the Worker uses the narrower grant. Recovery checks the exact original grant variant
against the saved receipt and deployed Worker. When granted, the account-level write
authority remains renewable; it is not merely a temporary deployment privilege.
Old signed manifests neither request it nor gain API initialization capability.
This source change does not itself modify any live OAuth client.

Build the Worker and device archives, then publish the approved archives.
Signing downloads each asset without credentials and verifies its SHA-256,
target architecture, version, and browser capability against the catalog.
Use `tar` for TGZ inspection and `unzip` for ZIP inspection on macOS or Linux.
Windows uses its native `tar.exe` for both. Keep the Ed25519 private key
outside the source and release directories. Signing with the public-client
verification options below emits the manifest for fresh installations.

```sh
node packaging/sign-management-release.mjs /path/to/release.json OAUTH_CLIENT_ID http://127.0.0.1:18871/oauth/callback /private/publisher-key.pem /path/to/new-output \
  --public-client-config /path/to/oauth-publisher.json --oauth-token-file /private/cf-oauth-client-read.token
```

Build the public macOS download and one-line command from the signed release.
Run `npm ci` in the checkout before packaging. The archive includes the public
key, signed metadata, Worker, deployment code, and installer runtime dependencies
with their license notices. Publish the archive and `install-macos.sh`
at their versioned addresses. Distribute `install-macos-command.txt` through
Nodrelay's trusted release channel. Its pinned SHA-256 verifies the launcher
before execution. The launcher checks the archive SHA-256 before extraction.
The installer verifies the signed release and the pinned Node binary.

```sh
node packaging/pack-management.mjs /path/to/new-output/management-release.json /path/to/trusted-publisher.pub.pem https://releases.example.com/nodrelay-management-1.0.0-macos.tgz /path/to/public-output
```

If `install-macos.sh` lives elsewhere (for example at the preview branch root
while its archive is in `archives/`), pass its exact public HTTPS URL as the
optional final packaging argument. Otherwise the generator assumes it is beside
the archive. This only sets the destination in the checksum-pinned command; it
does not change the normal short install command.

Before sharing a command, verify that both public downloads serve the generated
bytes without authentication, and run the generated checksum-pinned command
with `--plan` from a clean directory. It lists each target
architecture, version, and whether it includes browser tools. A production release
also requires the live Cloudflare install and Portal acceptance tests below.
To ship the same build as a hosted console, compare its Worker module SHA-256
and every release catalog entry against the signed management manifest before
publishing the command.

Use a dedicated download location for the versioned management kit, device
archives, generated command and checksums. An assets-only public GitHub release
repository can serve these downloads while the development repository stays
private. Set the device `downloadBase` and management kit URL to that version's
download path, then sign the manifest and generate the final command. Only
publish the reviewed archives and accompanying public metadata. Packaged
JavaScript can be read by anyone who downloads it. Keep the signing key, local
setup receipts, and any device or Cloudflare credential out of the release.

The installers use the version and per-architecture SHA-256 values from the
verified release. The authenticated console generates short commands for the
supported operating systems. Devices download the bootstrap script from their
own management hostname over HTTPS. The bootstrap detects the CPU, rejects an
unsupported system, and downloads and verifies the matching archive before
running it. The installer checks that each public bootstrap exactly matches the
script derived from the signed catalog before opening the console. Device tickets
are excluded from download URLs. Archive hashes are
anchored in the signed management release. Running the bootstrap still places
trust in the management hostname and the deployed Worker.

New installations preconfigure the documented ChatGPT, Claude, Cursor and
VS Code OAuth callback addresses. Completed deployments retain their configured
callback lists. When a client shows a connection-specific callback, use the
exact address shown by that client. The installer has no preset for WorkBuddy.

See [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Claude authentication](https://claude.com/docs/connectors/building/authentication), and
[VS Code MCP integration](https://code.visualstudio.com/api/extension-guides/ai/mcp).

## Restore management authorization

If the OAuth grant was revoked or the result of a rotating refresh cannot be
confirmed, run the original signed installation command with `--reconnect`
appended. Use the same Mac and owner-only deployment receipt, Cloudflare
account, domain and deployment name. The administrator remains the one recorded
in the receipt. This requires a
management Worker built with reconnect support.

```sh
sh packaging/setup-macos.sh /path/to/management-release.json /path/to/trusted-publisher.pub.pem --reconnect
```

The confirmation replaces the grant on the existing Worker. The installer
checks the exact account, domain, owner, Worker, OAuth client and deployment
before staging the new secret. The Worker adopts the new grant on the next
authenticated operation. Sign in and open **Client callback settings** to
trigger adoption and check that the existing rules are readable. Nodrelay
keeps the same devices, tickets, D1, Tunnel registrations and Access policies.
An ambiguous refresh is never replayed. If a reconnect is already staged,
try reading the management settings first and inspect the existing staged
secret before attempting another reconnect.

## Cloudflare authorization and verification status

The proposed one-consent management path requests `mcp-portals.write`,
`access.write`, `teams-connector-cloudflared.write`, `dns.write`,
`workers-scripts.write`, `d1.write`, `zone.read`, `access-acct.read`, and
`offline_access`. Kits that automatically discover the administrator also
request `user-details.read`. The installer uses this scope once for the email
lookup. The same permission remains in the grant that the Worker retains,
although the Worker does not call the profile endpoint. The Worker must retain a rotating refresh credential to
continue creating and revoking devices. It encrypts the credential in one
Durable Object and removes the initial secret binding after persistence. The
credential retains the original deployment scopes because Cloudflare returned
the full grant on a narrower refresh request. Limits in Nodrelay's configuration
restrict its normal resource calls. The provider credential itself can write
other resources covered by that Cloudflare grant.

The management command's signature checks, domain selection, and deployment
payloads have been exercised with local fixtures. The remote kit download can
be exercised on macOS with `FLEET_TEST_MANAGEMENT_KIT=1 node --test test/management-kit-local.mjs`.
The account-scoped consent and Mac device call through the official Portal
passed a private pilot using a short-lived grant and a pre-staged device
archive. A later preview verified anonymous package downloads and deployed
the managed OAuth Worker, D1 database and Portal using the published command.
The managed preview downloaded and activated a Mac mini, then returned a
file and command output through the official Portal. The console read live
device status more than an hour after deployment. Cross-account use still
needs acceptance. The [experiment notes](runtime-oauth-experiment.md) describe
each run separately.

## Public readiness checks

New installations wait for both the management Access login and the MCP Portal
endpoint, as well as every pinned public installer. Portal readiness means TLS
and the expected Access redirect or a same-origin MCP OAuth challenge are
available. It does not mean a ChatGPT/Claude login or tool invocation has been
validated. A public HTML page, bare 401/403, or 5xx does not pass the check.

To recheck a Portal too, use the command printed by the installer:
`--check MANAGEMENT_ORIGIN ACCESS_ISSUER --portal https://PORTAL_HOST/mcp`.
Legacy `--check` commands without `--portal` still check the management endpoint
and installers only. These checks send public GET requests, never credentials.

When a selected account has no active domain, the interactive installer offers
to return to account selection (if multiple accounts were authorized), recheck
after configuring the domain, or cancel. No repeated OAuth is needed merely to
choose a different already-authorized account.

### Web upgrade and device enrollment release gates

The one-line command stays unchanged. An owner-managed installation can
adopt its first signed web-upgrade baseline in place when the original
installer receipt and Cloudflare target match. The bridge inherits the
existing D1, Durable Object, OAuth, and other bindings, verifies the D1
schema and staged version, and confirms cutover via the Cloudflare API.
Rerunning the installer from the current channel can also apply a newer
signed release directly, with no upgrade button to click. Authorize only
the original account and select the same domain; the original receipt pins
the target. The installer and web console use the same D1 lock and operation
journal. A same-version run checks the signed feed but does not redeploy.
Older, version-pinned launchers without this feature cannot update themselves.
A browser or proxy failure after cutover does not trigger redeployment.
After an interrupted run, use the same original command. The installer
will not repeat a Cloudflare write whose outcome it cannot prove.

If an in-browser update was interrupted, use **Check actual status** in the
upgrade dialog. It compares Cloudflare's active and latest versions against the
saved operation. If the candidate is uploaded but a timed-out cutover still
shows all traffic on the old version, the check reports that observation and
keeps the operation pending. Check again later instead of resubmitting. An
unconfirmed upload is not safe to reissue, and a staged version has not been
approved for a separate manual cutover. Preserve the operation ID and, if the
Cloudflare values differ, the active/latest version IDs for support. Do not
clear the D1 journal, delete versions, or redeploy to get past this check.
If Cloudflare confirms the candidate is active, independently verify that the
management page, login and device list work; the provider readback does not
test the application or automatically roll back.

#### Run offline simulations

From the repository root with Node.js 24 and the project dependencies installed:

```sh
node --test test/management-auto-resume.test.mjs test/management-command-upgrade.test.mjs test/management-upgrade-ui.test.mjs
```

These tests exercise the installer's recovery logic with temporary receipts,
the CLI and web API against simulated Cloudflare responses with SQLite and
fixture signing keys, and the same browser upgrade script against a simulated
DOM and network. No Cloudflare login, real deployment or device is needed.
The installation recovery cases for the macOS command run on POSIX test
hosts; they do not install a macOS service or invoke the public launcher.

#### Verify command and web upgrades on the same deployment

If the same installation must pass both checks, prepare two successive signed
targets, A and B, with B newer than A and compatible with A. Keep the public
feed on A during the command test. Switching it to B first can let the command
consume the intended web target, leaving nothing for the button to upgrade.

1. Record the existing management origin, account, Worker, 100% active version,
   and enrolled device list. Use the original installation receipt and command.
2. After the command applies A, confirm A against Cloudflare's active version
   and reopen the same management page. Check login and the device list. Rerun
   the command while the feed still points to A: it should report the current
   version without another Worker upload or deployment.
3. After the A check passes, expose the separately signed B on the same channel.
   Check for updates in the existing console and verify it offers B. Apply B
   once, then confirm the new active version, the same login, and the original
   devices. Do not count a same-version result or a different installation
   as validation of either cutover.

Record the management release and the device catalog separately in the
acceptance notes. For a management-only A → B test, record the exact device
versions and archive hashes before the command and confirm they are unchanged
after both cutovers. The management release does not replace an installed
device's files or change the installer inside a pinned device archive; it must
not claim to deliver a device-installer fix. Test device archive changes as a
separate, versioned rollout using the
[native release gates](managed-deployment.md#release-gates).

#### Recover a management page that stops working after cutover

1. Before updating, record the Cloudflare account, Worker name, and exact
   version ID receiving 100% of traffic. Record the existing D1 binding and
   identify a harmless read from an enrolled test device for the smoke check.
2. If the updated page is down, use the **Cloudflare dashboard**, not the
   unavailable Nodrelay dialog. Open the same Worker under **Workers &
   Pages**, find the previously recorded working version under
   **Deployments**, and select **… → Rollback** to restore that version to
   100% of traffic. Follow the
   [Cloudflare rollback instructions](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
   If Cloudflare cannot restore
   that version (e.g. removed bindings or incompatible Durable Object changes),
   stop and escalate with the recorded version IDs.
3. Verify the active version in Cloudflare, then open a fresh browser session
   and check login, the existing device list, and the same read. A rollback
   restores Worker code and configuration, not previous D1 or Durable Object
   state. Keep the upgrade journal and existing bindings intact.
4. In Cloudflare compare the **active version** and the **latest upload**.
   The failed candidate can remain the latest upload after recovery. If they
   differ, Nodrelay blocks a new web upgrade before upload because Cloudflare
   can inherit from the latest upload. A successful rollback restores service
   but does not by itself restore eligibility for another upgrade. Preserve the
   two IDs and contact Nodrelay support to review a safe forward upgrade;
   do not delete versions, clear the journal, or repeatedly submit to bypass
   this protection. A confirmed journal entry denotes a past cutover only.

For a **new** installation to expose intent-based device enrollment, the
release publisher opts in with `--device-intent-v1` when signing the
management release. The signer requires the web-upgrade baseline and
requires macOS arm64, Windows x64 and Linux x64 and verifies that every
supplied native archive contains the exact reviewed
installer and enrollment client. Before signing, run
`node packaging/preflight-enrollment-release.mjs RELEASE_JSON` against
the local release directory. Intel macOS and Linux arm64 stay optional until their native acceptance.
Keep versioned assets immutable and
available; an installation command previously generated must continue
to resolve its pinned assets. Adopting the web baseline must not replace
an existing deployment's legacy device catalog.
If the same kit includes newer device archives for fresh installations,
the publisher can supply the prior signed manifest with
`--bridge-from-signed-manifest`. The signer verifies the previous publisher
signature and OAuth client before recording its catalog digest. Existing
installations keep their original catalog and therefore their original
installer links. This is a publisher option, not an install-command flag.

For existing deployments, publish a code-only v1 bridge first, keeping the
original feed usable by older consoles. A signed v2 release can then enable
or advance new-device enrollment after existing D1 schema and all exact
Access paths pass read-only checks. To generate v2 artifacts, pass
`--enrollment-catalog RELEASE_JSON` to `packaging/sign-web-upgrade.mjs`;
publish the three files together under `CHANNEL/v2/` in the scoped feed.
Use v2 for subsequent updates once that channel has published it. Do not
replace old archive bytes or remove historical archives. Neither a
malformed feed nor a missing Access rule is an invitation to widen access
or offer an older upgrade.
