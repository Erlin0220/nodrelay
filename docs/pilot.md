# Isolated pilot and rollback

Choose one Cloudflare account, one active zone, an unused namespace, one
administrator email, one device ID, and a reviewed development-only bundle.
Use a verified HTTPS URL for a normal enrollment. For an attended pilot on a
machine that already holds the verified archive, set `localFile` to its exact
basename in the release catalog and remove the `url` field. Run the console's
command from the directory containing that archive. The same installer checks
SHA-256 and redeems the single-use ticket. The local mode leaves distribution
unverified. Use the existing
Access organization and identity provider. The administrator must be able to
select the chosen account on the Cloudflare consent screen.

For a pilot whose administrator is a member of the account registering the
OAuth client, retain private visibility. Register the public-client PKCE flow
with token authentication `none` and the exact loopback callback. In
Cloudflare, client **visibility** and the protocol's lack of a client secret
are separate settings. Publishing the client is required when it must serve
users outside the parent account. Cloudflare requires verification of the
publisher domain before permanently switching to public visibility.

## Official Cloudflare CLI preflight

From this checkout, run the read-only check with an existing Fleet setup file.

```sh
sh packaging/check-cloudflare-setup.sh /path/to/setup.private.json
```

The check downloads Node 24.22.3 and Cloudflare CLI 1.0.0-rc.1 over HTTPS,
verifies their pinned digests, and uses an isolated temporary directory. The
script reads the Fleet setup plan and reports the requested scopes and device
bundle sources. It can run on macOS and glibc-based Linux on x64 and arm64
with the system curl and tar. This check uses the official CLI and requires
no separately registered OAuth client.

Fleet creates an account-owned Worker provisioning token through
`POST /accounts/{account_id}/tokens`. The API reference names the API token
permission `Account API Tokens Write`. For OAuth the official CLI accepts
`account_api_tokens:create`. The pinned version rejects
`account-api-tokens.write`. The check maps that identifier when preparing
explicit CLI arguments and checks the CLI's account token command schema.
It uses CLI dry runs and leaves the system keyring alone.

The live trial must confirm the consented grant with `cf auth scopes`, then
check the target account's token permissions and verify that the restricted
token can be created with its expected expiry. Cloudflare requires a
provisioning-capable account role and limits the new token's permissions
to the operator's role and the OAuth grant.

The pinned CLI adds `offline_access` to a live OAuth request, even when the
operator supplies `--scopes`. The trial's 24-hour lifetime applies to the
Worker token. The OAuth refresh credentials have a separate lifecycle.
Verify the Fleet device release URL and live OAuth grant separately from
these Node and CLI downloads.

[Cloudflare CLI release candidate](https://developers.cloudflare.com/changelog/post/2026-11-17-release-candidate/) ·
[Cloudflare delegated token provisioning](https://developers.cloudflare.com/changelog/post/2026-10-01-account-api-token-provisioning/) ·
[Cloudflare account-owned token API](https://developers.cloudflare.com/api/typescript/resources/accounts/subresources/tokens/methods/create/)

## Inventory to approve

- OAuth registration uses a short-lived token scoped to the account with
  OAuth Client Read and OAuth Client Write. Register or reuse only the
  explicitly named client. Its credential stays with the registration operator.
- Initial setup asks for Zone Read, DNS Write, Access Apps and
  Policies Write, Access Organizations and Identity Providers Read, Workers
  Scripts Write, D1 Write, MCP Portals Write, cloudflared Write, and Account
  API Tokens Write. Leave `zeroTrustTeam` unset to avoid organization or
  identity provider writes. Normal reconciliation excludes cloudflared Write
  and Account API Tokens Write unless the provisioner is being rotated.
- Provision the Worker custom hostname `<namespace>-fleet.<zone>` and its
  D1 database with owner-only Access. Give `/device/enroll` and
  `/device/activate` their own Access path exceptions. Those two Worker
  handlers require a one-use ticket and a device bearer credential respectively.
- Provision the owner-only Portal with Access OAuth at
  `<namespace>-portal.<zone>/mcp` and one proxied CNAME to
  `gateway.agents.cloudflare.com`. The Worker and D1 names start with
  `fleet-<namespace>-` and use the installation receipt's random suffix.
- Bind an account-owned Worker secret scoped to MCP Portals Write, Access Apps
  and Policies Write, and Cloudflare One Connector: cloudflared Write in the
  chosen account, and DNS Write in the chosen zone. For an attended pilot, set
  `provisionerLifetimeDays: 1`. Setup verifies Cloudflare returned the requested
  expiry before binding the token. Record its ID and Cloudflare-confirmed UTC
  expiry from the setup receipt. The account permissions can affect other
  matching resources in that account if the secret is compromised.
- Enroll one device with a dedicated named Tunnel, proxied CNAME
  `<device>-<namespace>-device.<zone>`, and a bearer-authenticated server
  mapping owned by the pilot Portal. Forward only the development adapter's
  loopback MCP path and port. Log the created resource IDs, names, Access
  policy targets and expiry. Keep the local setup receipt private.

## Rotate the provisioning credential

Its expiry stops Worker operations that call the Cloudflare control plane.
Device connectors and MCP bearer credentials have independent lifetimes.
Schedule rotation or complete device revocation before the recorded expiry.
To rotate, use the same setup receipt with `--rotate-provisioner`, record the
new server-confirmed expiry, verify that the Worker can read device status
with the new token, then revoke the replaced token. If expiry interrupts
revocation, obtain approval to rotate or complete cleanup via the Cloudflare
control plane.

## Stop and remove a verified pilot

1. Cancel the outstanding installation ticket, then disable the enrolled
   device from the pilot console while the provisioning token is valid. In an
   authorized real trial verify the Portal mapping disappears, a current
   Portal session and a fresh session both fail to call the device, the
   device's direct MCP route with its former bearer credential is denied,
   and cloudflared using its prior connector token cannot reconnect. Confirm
   another approved device or existing Portal still responds. Record the
   results independently of the provisioning token's expiry.
2. Match the device resources against the recorded IDs. Remove the device's
   MCP server and its Access app, then the connector, device DNS record, and
   the trial's local jobs using the operating system's service owner.
3. Remove the pilot Portal, Worker custom domain and Worker, and their Access
   apps, reusable policies and pilot Portal DNS record. Remove the D1 database
   after retaining the required enrollment audit data. Revoke the trial Worker
   token and any retired token, then revoke the trial OAuth grant and remove
   the temporary private client if it is not used elsewhere. Re-check names and
   IDs before each deletion. These cleanup operations require their own
   approval and the corresponding Cloudflare permissions.
