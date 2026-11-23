# Managed deployment and acceptance

The production design uses the official MCP Portal and one remotely managed,
named Tunnel per device. The Worker provisions resources and handles enrollment.
ChatGPT tool requests flow through the Portal and named Tunnel directly to the
device. Each device verifies an independent bearer token on its origin.
The Tunnel never routes the local Control Center, Runtime port, or browser CDP.

## Publisher prerequisites

### OAuth client

Register a publisher client once. Configure authorization code with S256
PKCE, token authentication `none`, the exact loopback callback and the Fleet
deployment scopes. Cloudflare's account-scoped API can register or recover the
client with an existing short-lived API token carrying **OAuth Client Read**
and **OAuth Client Write** on the explicit account. The token file must be
owner-only. The registration command neither persists the token nor provisions
Fleet resources. If a create response is lost, repeat the same command and
config. It reconciles the existing client by name and settings. The local
attempt receipt prevents a second create while the result remains uncertain.
Remove that receipt only after reviewing the account and confirming the client
was never created.

```sh
npm run setup -- /private/oauth-registration.json --register-oauth --plan
npm run setup -- /private/oauth-registration.json --register-oauth --oauth-token-file /private/cf-oauth-registration.token
```

The registration JSON requires `accountId`, `namespace` and `oauthRedirect`.
For a signed management release, follow the [management OAuth registration guide](management-macos.md#release-publisher).
For a publisher client, also set `oauthPublisher.url` and `oauthPublisher.logo`
to the authorized public HTTPS URLs. New clients start private and can be used
by members of the registering account. Distribution across accounts requires a
publisher-owned domain, verification through Cloudflare's DNS TXT challenge,
and an explicit switch to public visibility. Cloudflare treats that switch as
permanent. Fleet's registration command leaves promotion and DNS verification
to the publisher. Put the resulting `oauthClientId` and `oauthRedirect` in the
setup config customers receive. The registration token is a publisher
credential, so it is never part of a customer setup or a target device command.

### Release packages

Bundle the management Worker using Wrangler `deploy --dry-run` with
[the example config](worker.wrangler.example.jsonc). Build native Personal
payloads using each target's dependencies and the existing Personal project.
A browser-enabled bundle also requires a reviewed companion directory.
`packaging/browser-companion` attaches to a separately managed local provider
that exposes only the supported browser tools and uses a dedicated credential.
The device operator sets `NODRELAY_BROWSER_BACKEND_CONFIG` to an absolute private
JSON file based on `packaging/browser-companion/config.example.json`.
The installer checks the provider identity and tool catalog over its configured
loopback endpoint before redeeming the one-time ticket. Setup records the
validated identity and token's local path in `browser-backend.private.json`.
The adapter checks that identity and browser-only catalog at each reconnection.
Browser catalog queries reach the local provider so a paused provider reports
unavailable even when a previous session is still cached. The management page
reports development and browser catalog results separately. A browser-enabled
archive requires explicit confirmation in the device row's **Install command**
form before the manager generates the command. Development-only archives do not
offer browser tools.
The browser provider continues to own its process, profiles, sessions, proxies
and paused state.

On macOS, give `FLEET_TEST_BROWSER_ARCHIVE` the path to a reviewed browser-enabled
archive and `FLEET_TEST_PLAYWRIGHT` the path to an installed Playwright module.
Run `node --test test/browser-packaged-local.mjs` to check the packaged
installer, one-time ticket preflight, browser-only tools and a real Chrome page
using only local test services and temporary browser state.

To verify the management flow in the same environment, set
`FLEET_WORKER_BUNDLE` to a Wrangler dry-run bundle and `FLEET_MINIFLARE` to
an installed Miniflare module. Run
`FLEET_TEST_RUNTIME_OAUTH=managed node --test test/workerd-local.mjs` with
`FLEET_TEST_PLAYWRIGHT` set. This exercises the actual Worker and local D1 with
an isolated Cloudflare API fixture, including ticket consent and unavailable
browser status while the development catalog remains reachable.

Apple Silicon macOS and Windows x64 are the ShardX candidates. The existing
WindowsTerminalMCP Fleet listener uses a device-wide credential and honors
remote pause. Integrating that service requires a dedicated browser-only
listener and a live acceptance test. Intel Mac and Linux have development-only
releases.

Provide the Worker bundle, upstream license notices and independently reviewed
SHA-256 pins for Node and cloudflared for each target in
[the release build example](release.example.json).
The packer verifies copied binaries against descriptor hashes and the declared
OS and CPU. Build and sign target-specific Personal dependencies on the target
platform. On Windows, the packer uses the built-in bsdtar to create the ZIP.
It uses Git to apply the reviewed least-privilege patch to the staged Personal
Runtime. Supply the unpatched Windows payload matching that patch. The Windows
archive excludes the optional Claude Agent SDK and clipboard packages. The
Linux packer applies a systemd unit path and log output patch to the staged
Personal Runtime. It also applies the ModelRuntime migration to the reviewed
Personal payload when the installed Pi coding agent is exactly `1.5.2`.
Use the reviewed native dependency lockfile and credited notices when staging
that payload. The Windows and Linux archives omit `desktopSnapshot` from
upstream metadata. Both retain the supplied Node, cloudflared and Personal
DevSpace notices.
The publisher can package one or more targets in one invocation. It emits
versioned archives, matching `install-*.sh` or `install-*.ps1` local installers,
`worker.js`, `worker-jose-license.txt`, `SHA256SUMS`, and a setup-ready
`release.json`. Keep the notice with any redistribution of the
Worker file. Compare the bundled package’s notice with
[`licenses/jose.txt`](../licenses/jose.txt) when upgrading `jose`.

```sh
npm run pack:release -- /private/release-input.json /private/new-release
(cd /private/new-release && shasum -a 256 -c SHA256SUMS)
npm run pack:release -- --verify-published /private/new-release/release.json
```

Publish only reviewed archives to an approved, versioned HTTPS download origin
accessible without GitHub membership or any device credential. A private
repository's ordinary release URL requires authorization. The anonymous check
streams each published archive through the same HTTPS redirect limit as the
installer and compares it with the pinned SHA-256. The verifier caps each
compressed archive download at 1 GiB and bounds archive inspection time.
Set `releaseManifest` in the administrator setup config to the generated local
`release.json` next to its `worker.js`. The administrator CLI validates the Worker hash before opening
OAuth. Direct `workerBundle`, `workerSha256`, and `releases` remain supported.

## Administrator setup

Copy [the example](setup.example.json) into an owner-only directory and replace
the publisher, email, Worker and release inputs. `accountId` and `zoneId` are
optional selectors when the OAuth grant exposes more than one choice. For an
account that has never configured Zero Trust, `zeroTrustTeam` optionally permits
creating the named organization and adding one-time PIN if it has no identity
provider. It adds the explicit Zero Trust organization write scope. Existing
organization policies and identity providers are otherwise left as configured.
Cloudflare account setup, plans, domain ownership and account authorization
restrictions remain governed by Cloudflare.

```sh
npm run setup -- /private/setup.private.json --plan
npm run setup -- /private/setup.private.json
```

The installer opens the Cloudflare OAuth browser window, discovers active
zones, and displays the selected URLs and the service-token permissions before
writing resources. It creates Access policies and apps, Portal with managed
OAuth, proxied Portal DNS, D1, and the management Worker using a custom domain.
It waits for the console's own Access login and every configured versioned
installer route before opening the console. The Access login is separate from
the authorization used to configure the Cloudflare API. A timeout prints the
console URL for a later retry.

The bootstrap grant is used in memory. The ongoing account-owned token grants
MCP Portals Write, Access Apps and Policies Write, and Cloudflare One Connector: cloudflared Write
within the selected account, plus DNS Write only in the selected zone.
Cloudflare scopes these permissions at the account or zone level. Fleet further
checks resource names and ownership locally before updates. A platform release
should use a dedicated zone or account where isolation from unrelated resources
is important. The Worker stores the token as a secret. The private local setup
receipt retains pending private keys until a successful binding, then retains
the identifiers for repeat setup. Back up the receipt. An interrupted token
creation whose returned value was lost must be reviewed and revoked in
Cloudflare. Re-running a known setup preserves deployment identity and existing
devices. Use `--rotate-provisioner` to stage and bind a new service token. After
successful verification, revoke the previous token in Cloudflare. For a
time-limited deployment, set `provisionerLifetimeDays` to 1–90 before issuance or
rotation. Enrollment, live status and revocation require a valid provisioning
token. Rotate it before expiry or remove the trial while it remains usable.
Existing device traffic uses its own connector token and MCP bearer credential.

The two device HTTP entry points have separate Access path applications for
`/device/enroll` and `/device/activate`. The Worker authorizes the ticket or
device credential. A prior preview's `/device/*` Access application requires
an explicit migration. Setup detects it before making any writes.

See [the pilot inventory and rollback steps](pilot.md) for a first deployment.

## Connecting a device

In the console, enter a device name of up to 20 characters, such as `Office Mac`.
The console assigns a separate device ID; the name is a display label and does
not need to be unique. Saving only creates a pending row; it does not choose a
system, issue a command, or provision a Tunnel. Existing devices keep their
original IDs and display them if they do not have a name. Select
**Install command** on that row. With enrollment intents enabled, the dialog
shows the macOS command immediately; Windows and Linux are one click away and
use the same durable code. The code never expires, can be revoked from the
row, and only the first claim on any system succeeds; that claim narrows the
command to the claiming system. Opening the dialog, switching systems and
copying never install anything or create a Tunnel. If a hosted bundle carries
browser tools, the dialog asks for that consent once before showing commands.

The copied command has the same shape as Komari's agent installer: a fixed
public script in this repository, the console address and the install code.

```text
zsh <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://CONSOLE -t CODE
bash <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://CONSOLE -t CODE
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\nodrelay-install.ps1' '-e' 'https://CONSOLE' '-t' 'CODE' } catch { throw }"
```

The Windows command works from cmd or PowerShell; it contains no `$`, so an outer PowerShell expands nothing, and a failed download never runs an older local `nodrelay-install.ps1`. The public scripts (`install.sh`, `install.ps1`) hold no credentials. They
POST the code to `https://CONSOLE/device/install/<os>`; the code travels only
in the request body. The console returns the installer pinned for that device,
which downloads the approved release, retries, verifies SHA-256 and starts it.
That request claims nothing: the device claims the code later, once, during
installation. Every script runs from its last line, so a truncated download
runs nothing. Older `?v=VERSION` commands that were already copied keep working.

In legacy mode, the management Worker provisions a dedicated Tunnel and proxied DNS, generates
independent credentials, and returns a ten-minute one-use connection command.
The command downloads the chosen release, verifies SHA-256 and starts its
installer. All three platforms allow at most five redirects and require
HTTPS for every hop. Windows uses its system `curl.exe` and starts the verified
archive's bundled Node executable directly. Existing Windows state directories
and credential files must pass ownership, DACL and reparse-point checks. Fleet
refuses an unsafe existing credential without repairing its permissions. Treat
the command as a temporary secret, including clipboard and shell history. The installer receives only per-device credentials and uses the
bundled Runtime, Node and cloudflared. It registers the existing Personal
DevSpace jobs and a separate Fleet job using launchd on macOS, Task Scheduler on
Windows, and systemd user services on Linux. A packaged browser adapter may
provide a local companion backend, retaining local browser state. The target
device does not have a Cloudflare account permission, API token, or OAuth grant.

The device verifies its local configuration and authenticates an activation
request. The Worker verifies the MCP handshake and known tool catalog over the
Tunnel, then registers the bearer-authenticated MCP server and owner-only
mapping in the Portal. A device keeps its own credentials and can reconnect
after network loss through cloudflared. A normal rerun uses the existing
matching local receipt and can repair the matching installation. The verified
local installer also supports ticket-free same-version repair for an installed
device. Follow the [manual update and recovery guide](device-recovery.md) to
replace an enrolled device with a different release. If network loss consumes
the one-time ticket before the device receives credentials, issue a fresh
ticket for the pending device. Use the console to cancel an unclaimed ticket.
A pending device keeps the original release digest when a ticket is regenerated.
Add a new device row to enroll against a different release. A display name is
not a substitute for the device ID in an existing command.

Device status shows registration, Cloudflare Tunnel status and authenticated
MCP tool discovery separately. Use the displayed Portal server IDs to identify
the device in namespaced tool calls. The console shows whether revocation is
complete or still needs reconciliation. This status does not establish command
execution through the Portal. The disable action rejects new origin requests,
rotates the dedicated Tunnel secret, disconnects its connectors, removes its
Portal mappings and invalidates pending/activation credentials. Verify both
direct and Portal access after revocation. A healthy peer's mappings and
origin credentials remain untouched. After remote revocation succeeds, the management Worker returns an
authenticated revocation proof for that device. Only that proof stops the
local Fleet listener and connector. If Tunnel rotation disconnects the connector first, the service checks for that proof before restarting. Generic HTTP 401/403, redirects, invalid
proofs and network failures retry with bounded backoff and record the last
observed state in the device's private `connection-status.json`.
The Local DevSpace Control Center remains the owner of local workspaces
and execution.

## Domain and network choices

| Layer | Supported production plan |
| --- | --- |
| Management Worker | Workers custom domain. Cloudflare permits workers.dev and Access for it but recommends a custom domain or route for business-critical Workers. |
| MCP Portal | An active full or partial Cloudflare DNS zone. API deployment creates the proxied CNAME to `gateway.agents.cloudflare.com`. A provider-owned workers.dev or pages.dev hostname is not established as a production Portal option. |
| Device origin | A named Tunnel dedicated to one device and an exact authenticated MCP path. The default publishes a proxied hostname in the selected zone. No Quick Tunnel is used. |
| Optional private origin | Portal server-level Gateway routing plus an official private hostname or CIDR route. Requires Gateway networking and DNS resolution from the cloudflared host, and isolated hostnames or unique per-device prefixes/virtual networks where device LANs overlap. |

The default is the simplest repeatable path. Each device origin is authenticated
independently of Portal Access, and Cloudflare forwards only the intended
paths. Private routing can remove device public DNS while preserving the
Portal's own domain requirement. A private implementation needs verified
per-device DNS resolution and Gateway policy; Gateway TCP/UDP proxy settings
can have organization-wide impact. Device readiness would need a separate
verification path through Gateway because the public management Worker cannot
assume it can directly reach the private address. Validate the real
Streamable HTTP handshake, bearer forwarding, independent tool calls, loss of
one route and route revocation before selecting this mode.

Sources: [OAuth client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[official Portal protocol and limits](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/),
[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[official Tunnel provisioning](https://developers.cloudflare.com/tunnel/get-started/),
[private hostname route API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/networks/subresources/hostname_routes/methods/create/).

## Release gates

- Run `workerd test test/workerd/upgrade.capnp` using the workerd build pinned
  in CI. It verifies signed feed downloads and rejects redirects before
  deployment using an offline fixture at the deployed Worker compatibility date.
  This is not a live Cloudflare upgrade or a device enrollment test.
- Review the production dependency trees of Nodrelay and the bundled Personal
  Runtime. Run the dependency audit on each native payload and include the
  required third-party notices for the binaries and packages in the final
  archive. Retain Nodrelay’s MIT license, the notice for the exact release of
  each bundled binary and the Personal DevSpace license. For a bundled npm
  dependency without a license file, verify whether the complete notice is
  embedded in its distributed files. Include any missing required notice
  before publishing. Record the source revision and exact inputs used to
  produce each archive, including the Personal DevSpace build and lockfile.
- Inspect the final archives for signing keys, credentials, private setup
  receipts, build-machine paths and host account fields in archive headers.
  A valid signature authenticates the archive bytes. Archive content and
  metadata still require review.
- One real authorized setup in a dedicated Cloudflare account/zone must
  establish OAuth grant, token creation, managed Access, Portal and DNS.
- Verify actual device setup on clean Windows, macOS and Linux. Windows Task
  Scheduler uses an interactive token, and the macOS LaunchAgent uses the
  logged-in GUI user's domain. Neither service guarantees connectivity before
  login or after logout. Headless Linux prepares only the Runtime; it still
  uses systemd's user service manager. Unattended operation requires user
  linger or a separately approved system service. The installer leaves those
  platform settings to the administrator. On WSL2, the Runtime is available
  while the distribution is running. A systemd service alone does not keep
  WSL running. [Microsoft WSL systemd behavior](https://learn.microsoft.com/en-us/windows/wsl/systemd).
  Run the native Windows ACL test on
  NTFS before claiming Windows support. The PowerShell and ACL report fixtures
  can validate command flow and rules on other systems, but cannot verify
  Windows PowerShell, security descriptors, or service startup on Windows.
- Use an isolated ChatGPT workspace for the first successful Portal call.
  Check 401/403 behavior and one fresh call on each device. Confirm an
  authenticated execution result independently of Tunnel Connected/Portal Ready.
- Disconnect one tunnel during an in-flight action and confirm the other
  device keeps responding. Drop a completed `exec_command` reply on the client
  side, then retry with the same `operationId` and arguments and verify that
  the device starts the command once. Test whether ChatGPT preserves the ID on
  retries. Verify that a new client can resume handles while the device adapter
  and its upstream session survive. After adapter or Runtime restart, reopen
  the workspace and verify the previous workspace and process handles are
  refused. Verify device revocation from a real client.
- Portal times out after 60 seconds. DevSpace command submission/poll use
  a bounded wait, with the Runtime limiting waits to 30 seconds. Start long
  jobs with a short yield and keep polling the process handle at the original
  device. Runtime restart invalidates running process handles. Verify a job
  lasting longer than the Portal deadline through multiple short calls.

## Command retry limits

The adapter retains up to 128 command replies of at most 32 KiB and records up
to 65,536 command IDs per adapter lifetime. If a reply has been evicted or was
too large to cache, retrying its ID reports that the outcome must be checked
on the original device. If the ID limit is reached, new commands are refused.
Restart the adapter after checking active jobs and reopen the workspace. The
journal is cleared on adapter restart, and the old workspace handles are
rejected. An MCP caller that changes the ID can start another command. Recovery
across adapter restarts or retries under a new ID requires checking the original
operation on the device before resubmitting it.
