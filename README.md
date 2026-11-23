<p align="center">
  <img src="assets/nodrelay-neon.webp" alt="Nodrelay" width="640" />
</p>

<h1 align="center">Nodrelay</h1>

<p align="center">Reach every Personal DevSpace device through one Cloudflare MCP Portal.</p>

<p align="center"><a href="README.md">English</a> · <a href="README_zh-cn.md">简体中文</a></p>

> **Preview.** Nodrelay is under active development. Interfaces and package formats may still change between versions. Read [Status](#status) before relying on it.

## What it is

Nodrelay has two parts:

- **Management console**: a Cloudflare Worker with D1 that you deploy into *your own* Cloudflare account. It gives each device its own Tunnel and credentials, issues install commands, shows connection state, and revokes access.
- **Device service**: a small service on each macOS, Windows or Linux machine. It connects that machine's Personal DevSpace Runtime to the Portal through the device's Tunnel.

Your MCP client (ChatGPT, Claude, Cursor, VS Code, …) connects to one Portal address and works on whichever device you choose: open a workspace, read and patch files, run commands.

```text
Admin      → Cloudflare Access → Nodrelay console (Worker + D1)
MCP client → Cloudflare MCP Portal → device Tunnel → device service → Personal Runtime
```

Nothing runs on servers other than your own Cloudflare account and your own devices. Devices never sign in to Cloudflare.

## Install

### 1. Deploy the management console (macOS)

```zsh
zsh <(curl -fsSL https://github.com/Erlin0220/nodrelay-downloads/releases/download/v0.1.1/install-macos.sh)
```

A browser window opens for Cloudflare authorization. Then pick an account and a domain with the arrow keys. The installer deploys the Worker, D1, Access and the MCP Portal, confirms each step through the Cloudflare API, and opens the console. You need a Cloudflare account with an active domain. To check the launcher before running it, use the [command with its pinned SHA-256](https://github.com/Erlin0220/nodrelay-downloads/releases/download/v0.1.1/install-macos-command.txt).

### 2. Add a device

In the console, choose **Add device** and give it a name (up to 20 characters). Choose **Install command** on its row and copy the command for that device's system:

```sh
# macOS
zsh <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://<console> -t <code>
# Linux
bash <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://<console> -t <code>
```

```bat
# Windows (cmd or PowerShell)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\nodrelay-install.ps1' '-e' 'https://<console>' '-t' '<code>' } catch { throw }"
```

[`install.sh`](install.sh) and [`install.ps1`](install.ps1) contain no credentials. They ask your console for the installer pinned to that device; the installer downloads the approved package, verifies its SHA-256 and installs the service. An install code does not expire, works once, and can be revoked from the console. Treat it like a password until it is used.

### 3. Connect an MCP client

Add the Portal address shown in the console (`https://<portal>/mcp`) to your MCP client and sign in with Cloudflare Access. To allow a client's OAuth callback, use **Client callbacks** in the console.

## Upgrade

- **Console:** use the upgrade icon next to the logo, which appears only when a verified newer release exists, or run the step 1 command again. Both keep your domain, database, login, Portal and enrolled devices.
- **Devices:** follow the [update and recovery guide](docs/device-recovery.md).

## Status

| Platform | State |
| --- | --- |
| macOS Apple Silicon | Installation, Tunnel and Portal tool calls verified |
| Windows x64 | Installation, repair, Tunnel and Portal tool calls verified |
| Linux x64 | Installed and reached over its Tunnel on Ubuntu 22.04 (WSL2); Portal calls on a standalone host pending |
| macOS Intel, Linux arm64 | Packaging supported; public packages and acceptance pending |

Known limits:

- The device service runs as the signed-in user: a LaunchAgent on macOS, an interactive scheduled task on Windows, and a systemd user service on Linux. For unattended Linux hosts, enable user lingering.
- A Nodrelay console needs a domain in your Cloudflare account. Device Tunnels and the MCP Portal are created under it; a `workers.dev` address cannot host them.
- The public management package uses a Cloudflare OAuth client that only its owning account can authorize. To deploy into another account, build the kit with your own client. See [Cloudflare OAuth client visibility](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/#private-and-public-clients).

## Documentation

- [Management console on macOS](docs/management-macos.md)
- [Managed deployment, devices and release gates](docs/managed-deployment.md)
- [Update and recovery](docs/device-recovery.md)

## Develop

Node.js 24 or later:

```sh
npm ci
npm test
```

To run one device adapter by hand, start from [`docs/device.example.json`](docs/device.example.json) and keep its credentials in an owner-only directory:

```sh
npm start -- /absolute/private/device.private.json
```

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Bundled Node.js, cloudflared, Personal DevSpace, Tabler Icons and npm dependencies keep their own licenses; their notices are collected under [`licenses/`](licenses) and in each package.
