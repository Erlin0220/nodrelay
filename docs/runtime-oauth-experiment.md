# Fleet-owned runtime OAuth experiment

The management Worker can provision each device through a private, dedicated
Cloudflare OAuth client. The experiment uses the same device setup, status, and
revocation paths as the managed Worker. Device enrollment still issues a
separate named Tunnel and device credentials. It requires no API token
provisioning entitlement.

## Registration and consent

Preview the runtime registration without contacting Cloudflare.

```sh
npm run setup -- /absolute/path/setup.private.json --register-oauth --runtime-oauth --plan
```

The plan enables authorization code with PKCE and refresh grants for a private
client. The API normalizes `offline_access` from the enabled grant types.
A deployed runtime must confirm the four exact scopes through the OAuth scope
catalog and the token response. The scopes are `mcp-portals.write`,
`zone-access.write`, `teams-connector-cloudflared.write`, and `dns.write`.
The Cloudflare consent screen labels `zone-access.write` as "Access: Apps and
Policies Write".
Users choose the deployment account during consent. OAuth can authorize writes
beyond Fleet’s specific resources. In particular, validate which zones
`dns.write` reaches for the authorizing role before a live trial. Fleet targets
its configured account, zone, and resource names in the application.

Keep the deployment grant local. The deployment grant for Workers, D1, Access and
initial DNS/Portal configuration would be separate from the refresh grant, which
stays narrow and contains no Worker, D1, or token issuance authority. The
experiment does not validate a single consent that yields both grants.
Registering a private client requires the account's OAuth Client Write
permission, plus read access for reconciliation. It does not require
publisher-domain verification or making the client public.

[Cloudflare OAuth client API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_clients/methods/create/) ·
[Cloudflare OAuth scope catalog](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/) ·
[Cloudflare OAuth consent and revocation](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)

## Lifetime and storage

Use an internal `PROVISIONER_OAUTH` Durable Object binding to the exported
`OAuthProvisioner` class in a fresh test Worker. A Cloudflare deployment would
also need a SQLite Durable Object class migration. The fixture supplies
`FLEET_OAUTH_CLIENT_ID`, a random 32-byte base64url `FLEET_OAUTH_KEY` and a
one-time `FLEET_OAUTH_SEED` JSON value containing the access and refresh tokens
and the access expiry in Unix seconds. Remove the seed binding after the
credential is safely persisted. Supply the key and seed only through secret
bindings. Keep `PROVISIONER_TOKEN` unset in the OAuth mode.

Only the internal Worker binding can obtain the short-lived access token.
The Durable Object encrypts the credential with AES-GCM in its persistent
storage. Concurrent operations share one refresh. It writes a marker before
refreshing and persists the replacement credentials together. An interrupted,
revoked, or ambiguous token exchange returns an authorization error. It
never replays the old refresh token or reloads the seed after recording an
attempt. Recovery currently requires a fresh grant and a new pilot state.
A production reconnect flow, live server revocation, and OAuth secret cleanup
are outside this local experiment.

## Local acceptance

Run the Node suite, then use the existing Workerd and D1 fixture with
`FLEET_TEST_RUNTIME_OAUTH=1`. In that fixture, simulate expired access, OAuth
rotation, registration and activation for two independent Tunnels, revoked
device access, and continued access for the other device. Check that device
enrollment returns no OAuth credentials and that the fixture signs no account
API token. The upstream OAuth exchange and Cloudflare control-plane calls in
the fixture are simulated.

## Live credential check

In the November 19, 2026 trial, Cloudflare registered a private client with the
exact four business scopes and `offline_access`. Authorization and refresh
both returned HTTP 200, the expected scopes, and `expires_in: 3599` for the
access token. Refresh returned a different refresh token.

The original and renewed access tokens returned HTTP 200 for Portal listing,
account and zone Access application listing, Tunnel listing, and a DNS lookup
scoped to the trial zone. These reads establish authorization for those
endpoints. The account-level Access write and zone-scoped alternative were
subsequently checked with the combined trial grant below.

The Cloudflare revocation endpoint returned HTTP 200. The renewed access token
then received HTTP 401 from the Portal API with code 10000. Reusing the revoked
refresh token returned HTTP 400 and `invalid_grant`. The test retained the
private client registration and kept OAuth tokens in process memory. Durable
Object persistence and end-to-end device enrollment have only been exercised
locally so far. The maximum lifetime of a refresh token remains unverified.

## Live combined-consent check

A second live round on November 19, 2026 requested the four runtime scopes,
`workers-scripts.write`, `d1.write`, and `offline_access` in one private-client
consent. The authorization-code exchange returned HTTP 200 with all seven
scopes. An explicit refresh request asked for only the four runtime scopes.
Cloudflare returned HTTP 200 and explicitly reported all seven original
scopes, including both deployment writes.

The installer rejected that credential before the first resource write.
The test grant was revoked, and a refresh with the revoked credential
returned HTTP 400 and `invalid_grant`. Read-back confirmed that no trial
Worker, D1 database, Portal, Access application, Tunnel, or DNS record was
created. This result leaves the separate live runtime-only credential check
intact and rules out using the tested refresh request to isolate the
management Worker's runtime permissions.

A provider may omit the scope field when it matches the requested access
scope, as described in [OAuth 2.0 section 5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1).
This Cloudflare response explicitly supplied the original scope set. A
short-lived access token with narrowed scopes would also leave the original
scopes on a rotated refresh token under [section 6](https://www.rfc-editor.org/rfc/rfc6749#section-6).
Keep an initial deployment grant out of the Worker. Long-running device
provisioning requires a separate narrow grant or a supported way to issue
a separate narrowly scoped credential.

## Short-lived management deployment trial

A separately approved trial accepted the full combined short-lived access
token as a Worker secret. The same authorization supplied `offline_access`.
The installer retained the refresh token in memory for revocation and sent
only the temporary access token to the isolated Worker. The token included
Workers Scripts and D1 write access in addition to runtime permissions and
expires in about an hour. A production deployment needs a credential that
limits the Worker's ongoing permissions and supports continued operation.

Cloudflare rejected `POST /accounts/{account_id}/access/policies` with HTTP 403
and code 1010. The experiment used `zone-access.write` with
`POST /zones/{zone_id}/access/apps` instead. It created the three management
and device bootstrap applications with inline policies and checked the policy
readback. Creation of the Portal itself did not expose its Access application
via either Access list during the initial trial. Explicitly creating a zoned
`mcp_portal` application and adding an app-specific owner policy both returned
HTTP 201. The installer checked that Portal OAuth was enabled before writing
the Portal DNS record. It then created and migrated D1, uploaded the Worker,
disabled its `workers.dev` and preview endpoints, and attached its custom
domain. The management domain returned an HTTPS redirect to the expected
Cloudflare Access team. The Portal endpoint returned HTTP 401 to an anonymous
request. The bootstrap endpoint rejected a request without an enrollment
ticket.

The permitted owner opened the real management page in Chrome and generated a
one-use command for the Mac mini. The trial used a pre-staged archive. The
Mac's ordinary resolver path reset connections to the new hostname. A test-only
lookup using a public Cloudflare address preserved TLS hostname and certificate
checks. With that lookup, the command redeemed its ticket and started the Mac
service. The packaged Personal Runtime initially lacked its own OAuth owner
credential. After fixing the isolated Runtime initialization, an MCP client
connected through the named Tunnel, read a trial file and ran a fixed command
with exit code 0. An anonymous request was rejected with HTTP 401.

Cloudflare rejected creation of the upstream MCP server's zone-scoped Access
application with HTTP 400, code 12130, and an app/token domain mismatch. A
`via_mcp_server_portal` application has no public zone destination. The Portal
therefore had no authorized device mapping in this trial. The proposed
account-scoped application path uses `access.write` and still requires live
acceptance. Cloudflare's [Portal policy documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#policy-limitations)
describes the dedicated server Access application.

The isolated diagnostic repeated only the failed shape against the same trial
server. Its redacted request and response were as follows.

```text
POST /zones/<trial-zone-id>/access/apps
{"name":"<trial-server-id>","type":"mcp","destinations":[{"type":"via_mcp_server_portal","mcp_server_id":"<trial-server-id>"}]}

HTTP 400
{"result":null,"success":false,"errors":[{"code":12130,"message":"access.api.error.invalid_request: app and token domain mismatch"}],"messages":[]}
```

The [official Terraform example](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#configure-via-terraform)
configures the same destination with `account_id`, without a public hostname,
and attaches a policy to the server Access application. Both the Portal and
its server require matching access policies. The combined installer has an
account-scoped path, and the OAuth catalog distinguishes the `access.write`
and `zone-access.write` identifiers despite their identical display labels.
The actual seven-scope grant used `zone-access.write`. It was revoked. No
account-scoped OAuth write was attempted under a broader grant in this trial.
`zone.read` is for automatic active-zone listing. `access-acct.read` is for
checking the Zero Trust organization and identity provider. These two reads
are installer requirements and do not create or attach MCP policies.

Disabling the trial device returned HTTP 410 with a signed revocation proof.
The previously working MCP credential could no longer reach the Tunnel.
The test grant was revoked, the refresh returned `invalid_grant`, and Cloudflare
read-back confirmed removal of the Worker, domain, D1 database, Portal, DNS,
and trial Access apps. Cloudflare retained only the deleted Tunnel's metadata.

## Account-scoped Portal and device test

Later on November 19, 2026, the existing private Nodrelay client was updated
to replace `zone-access.write` with `access.write` and include `zone.read` and
`access-acct.read`. The dashboard read-back and the token response both showed
the nine expected combined scopes. The test grant listed the active zone and
read the existing Zero Trust organization and identity provider. The install
created the Worker, D1, DNS, Portal, and account Access apps with the one
authorization. The isolated Worker held the short-lived access token. The
refresh token remained in local process memory.

An owner signed in to the management page and generated the Mac mini's
one-use ticket. The pre-staged trial bundle initially mixed installer source
versions and stopped after ticket redemption. The isolated installation was
repaired by aligning its source modules, then resumed with its saved device
credentials. A process-local DNS lookup was used for HTTPS probes when the
Mac's normal DNS path reset connections. TLS hostname and certificate checks
remained in effect. The corrected local installer started its real Runtime
and adapter without hand-seeding the Runtime's owner credential.

Activation returned HTTP 200 with `active`. Read-back identified the healthy
Tunnel, the ready bearer-authenticated MCP server, its account-scoped Access
application with one owner allow policy, and its Portal mapping. An official
MCP SDK client discovered and completed the Portal OAuth authorization against
Cloudflare Access. Over the Portal's `/mcp` endpoint it opened the Mac's
isolated workspace and obtained both the expected file contents and fixed
command output. The dedicated upstream app no longer encountered `12130`.

Cloudflare accepted cleanup of the Worker, custom domain, D1 database, Portal,
MCP server, Access applications, DNS records, and named Tunnel. An independent
API read-back found only the Tunnel's deletion record. Refreshing the revoked
deployment grant returned `invalid_grant`. The isolated Mac LaunchAgents and
the corresponding private device state were removed and checked for absence.

After the trial, the ordinary device packer rebuilt an Apple Silicon archive
from a single source revision. Node in the extracted archive loaded the
installer preparation and Personal state modules. Separate localhost HTTPS
tests passed the management kit download from an empty directory, refusal of
a corrupted kit, and the device command's download, LaunchAgent startup,
retry, and confirmed revocation with synthetic providers.

This run covered the private-account Portal path with a single device and a
short-lived grant. A clean public package install, the Cloudflare lifecycle
of the long-lived Worker OAuth broker, external-account distribution,
cross-device isolation and ChatGPT Web connection still need live acceptance.

## Signed download rehearsal

The publisher scripts built an Apple Silicon device archive with the upstream
notices and a management kit with an Ed25519-signed release catalog. An
isolated HTTPS server on loopback served both final archives. The publisher
verifier streamed the full device archive and matched its SHA-256. From an
empty directory, the generated macOS command then downloaded its management
kit, prepared pinned Node, and validated the signature and deployment plan.
The rehearsal catalog points to loopback and uses a disposable signing key.
The same command ran in a clean interactive terminal with simulated Cloudflare
responses. It completed the real local PKCE callback, discovered one zone,
used the requested owner email and deployment name, and opened the simulated
Access-protected management console. Its API fixture received one Worker, one
D1 database, one Portal and five Access applications. It issued no account
API tokens.

The same Worker bundle passed the local Workerd test with
`FLEET_TEST_RUNTIME_OAUTH=managed`, using D1, Durable Objects and simulated
Cloudflare API responses. The test exercises refresh, deletion of the
initial Worker secret, registration and independent revocation of two
devices, and account-scoped Access policies. No external OAuth call or cloud
deployment is exercised by this test.

## Public Apple Silicon preview

The [downloads repository](https://github.com/Erlin0220/nodrelay-downloads/releases/tag/v0.1.0-preview.2)
contains the management kit, Apple Silicon installer, published command,
checksums, signed catalog, detached signature and public verification key.
Both archives were verified over anonymous HTTPS. The device bundle excludes
the optional Claude Agent SDK, native clipboard helper and private desktop
snapshot reference. It retains the third-party licenses and notices for the
packaged dependencies. The extracted bundle passed the isolated test with the
actual Personal Runtime.

The published management command ran from an empty directory, completed
Cloudflare OAuth once, and deployed a Worker, D1, Portal, and five Access
applications. Cloudflare listed the Durable Object binding and the initial
OAuth seed on first read-back. The Mac's configured DNS path was still
returning a synthetic address while a request to the verified Cloudflare edge
already returned the expected HTTPS Access redirect. The source installer now
waits for that redirect for up to 15 minutes before opening the chosen browser,
and prints the URL for later use if this network is still waiting.

After the Mac could reach the Access login, the management console opened in
Chrome and generated the Apple Silicon command. The command ran from an empty
directory and installed the device using the GitHub release. No local device
archive was staged. Its service reported `active`, Cloudflare showed a healthy
Tunnel, and the bearer-authenticated MCP server was mapped to the Portal. The
independent MCP client then completed Portal OAuth and read back a unique test
file marker and fixed command output through the official `/mcp` endpoint.

The management Worker removed its initial OAuth secret binding during
enrollment. About 111 minutes after deployment, the owner console still
showed the healthy Cloudflare Tunnel and a verified MCP tool catalog using
the managed OAuth broker, with no new management authorization. This run did
not capture the issued token's exact expiration or trace the rotation directly.
