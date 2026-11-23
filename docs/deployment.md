# Manual probe setup and acceptance

For automatic provisioning, follow the [managed deployment guide](managed-deployment.md).

## First device

Authorize a single isolated Mac mini probe before enabling any development or
browser tool. Use a dedicated Portal or an explicitly approved pilot mapping.
Keep the existing Fleet and Unified MCP connections available throughout.

1. Start the probe adapter under a dedicated local service identity for this
   test, with an isolated Runtime workspace and a new bearer credential. Use a
   dedicated Tunnel and only the exact probe route. The Tunnel connector and
   origin listener must be on the same Mac. Configure the origin Host header
   as the loopback listener.
2. Register the probe as a separate MCP server with a unique server ID and
   bearer authentication. Attach an owner-only Access policy to both the
   MCP server and the Portal. Keep the endpoint credential separate from the
   Tunnel token and all Runtime credentials.
3. Prefer a private route through Gateway when the account supports the exact
   hostname and routing design. Verify that Cloudflare Gateway resolves the
   chosen hostname on the intended network, reaches only the probe listener,
   and cannot reach the Runtime or local Control Center. Escalate account-wide
   Gateway changes separately. A dedicated public Tunnel hostname, limited to
   the protected probe route, requires a separate DNS and origin exposure
   decision.
4. The owner signs into the ChatGPT web connector and Cloudflare Access. Check
   tools discovery from that host. Call the probe with a fresh challenge and
   verify its device ID and marker hash. Check that an uncredentialed and a
   wrong-credential origin call fail. Compare with the local probe results.
   Cloudflare Ready confirms capability synchronization only.

Record the exact Portal and server IDs, Tunnel route, host client, protocol,
timestamp, challenge and hash. Avoid recording credentials and task arguments.
The Cloudflare [Portal documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
covers bearer credentials, 2025 transport compatibility and the 60-second
deadline. See [private hostname routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/)
for the Gateway prerequisites.

## Management deployment

Create an independent D1 database and apply [the migration](../cloud/0001_tickets.sql).
Copy the [Wrangler example](worker.wrangler.example.jsonc) into a deployment
config, set its real identifiers, and keep preview and workers.dev routes off.
Generate and bind a separate 32-byte base64url `TICKET_KEY` as a Worker secret.
Configure Access for the administrator UI and forms, with the exact audience,
issuer and owner identity checked by the Worker. Allow public traffic only to
the exact `POST /enroll` redemption endpoint. Bind an approved custom hostname
matching `APP_ORIGIN`. Use HTTPS and avoid request-body logging at every hop.
Check the account limits and costs before deploying.

The owner creates each independent Tunnel, chooses the credential for the
relevant Portal origin, and enters both in the admin form. The target device
uses the resulting one-time ticket. Keep the portable release inputs pinned and
verify signed upstream packages before execution. The enrollment command will
refuse an existing output directory. After an uncertain redemption, rotate the
device credentials and issue a fresh ticket. Cancel a pending ticket in the UI.
To revoke an active device, remove its Portal mapping or the Access permission
first, stop the device listener as appropriate, and revoke or rotate the
dedicated Tunnel credential. Verify that both new and existing connections are
denied. Changing a device credential also requires updating the Portal-side
credential. Rotating the ticket encryption key invalidates all pending tickets.

## Expansion gates

- Approve the development profile separately. On each physical device verify
  native file access and patch, command submission and polling, and isolation
  across simultaneous calls. Interrupt one Tunnel mid-call and verify that
  the other device succeeds. After a lost command reply, repeat the original
  `operationId` and arguments, and verify the retry does not start another
  process. Check service recovery across restart and rejection of stale handles.
- Approve the browser profile separately. Use the existing Windows x64 or
  Apple Silicon macOS ShardX backend, verify an existing test Profile and proxy
  policy, and work in a task-owned tab. Check that the user's tabs and Profile
  sessions persist. Confirm how the browser backend receives an approved local
  MCP credential and retains its pause control before on-boarding new devices.
- Verify Linux DevSpace under the intended account, desktop or headless service
  setup. Browser support depends on a separately verified existing ShardX SDK
  backend for that platform. Windows Session 0, Intel Mac ShardX, and Linux
  ShardX require independent validation.
- Complete per-platform clean-machine installation using existing signed
  installers and OS service owners. Before any Cloudflare API automation,
  review scoped permissions for Tunnel, DNS, MCP Portals and Access policies,
  as well as deterministic resource reconciliation. Keep account-level
  credentials of the management service off target devices.
- Confirm cutover and rollback separately. Remove or disable only the new
  Portal mappings and dedicated test services when reverting the pilot.
