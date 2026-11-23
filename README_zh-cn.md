<p align="center">
  <img src="assets/nodrelay-neon.webp" alt="诺联 Nodrelay" width="560" />
</p>

# 诺联 Nodrelay

[English](README.md) | 简体中文

诺联是一个自托管的本机 MCP 中继：把任意电脑上的本地 MCP（命令行启动的 stdio 服务，或只监听本机的 HTTP 服务）经 Cloudflare Tunnel 接入**一个** Cloudflare MCP Portal。MCP 客户端只连这一个地址，就能使用每台已配置好的电脑上的 MCP。

诺联会让远程客户端在你的电脑上调用工具，其中可能包括读写文件和执行命令。只在你拥有或获准管理的电脑上部署，并把 Portal 的访问策略限制在你本人。如何部署和使用由你自己负责，开发者不对未经授权的访问、命令执行或其他滥用及其后果承担责任。

[文档](docs/managed-deployment.md) · [下载与发布](https://github.com/Erlin0220/nodrelay/releases) · [安全问题报告](SECURITY.md)

## 功能

- **一个 Portal，多台电脑：** 每台电脑有独立的 Tunnel 和凭据。Portal 按电脑和 MCP 区分工具，客户端可以单独开关某个 MCP。
- **任意本地 MCP：** 支持 `command` 启动的 stdio MCP、本机 HTTP 和 SSE MCP，配置格式和 Claude Desktop、Cursor、VS Code 相同，可以直接导入。
- **配置留在电脑上：** 一台电脑提供哪些 MCP、能用哪些工具，只在那台电脑上决定。管理台可以查看和停用，但不能远程添加或修改电脑上运行的命令。
- **自托管：** 管理台是部署在你自己 Cloudflare 账户里的 Worker 和 D1，不经过任何第三方服务器。电脑无需登录 Cloudflare。
- **一行命令安装：** macOS、Linux、Windows 各一行命令，安装码不过期、只能用一次、可随时撤销。
- **内置 DevSpace：** 自带 Personal DevSpace（工作区、读写文件、执行命令），装好即可用。

## 快速开始

### 1. 部署管理台（在 Mac 上）

```zsh
zsh <(curl -fsSL https://github.com/Erlin0220/nodrelay-downloads/releases/download/v0.1.1/install-macos.sh)
```

浏览器打开 Cloudflare 授权页，授权后在终端用方向键选择账户和域名。安装程序部署 Worker、D1、Access 和 MCP Portal，通过 Cloudflare API 逐项核对后打开管理台。账户里需要有一个已激活的域名。

### 2. 接入一台电脑

在管理台点「添加设备」并命名，再点设备行的「安装命令」，复制对应系统的命令，到那台电脑上运行：

```sh
# macOS
zsh <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://<管理台地址> -t <安装码>
# Linux
bash <(curl -fsSL https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.sh) -e https://<管理台地址> -t <安装码>
```

```bat
:: Windows（cmd 或 PowerShell 均可）
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { iwr 'https://raw.githubusercontent.com/Erlin0220/nodrelay/refs/heads/main/install.ps1' -UseBasicParsing -OutFile 'nodrelay-install.ps1' -ErrorAction Stop; & '.\nodrelay-install.ps1' '-e' 'https://<管理台地址>' '-t' '<安装码>' } catch { throw }"
```

### 3. 添加这台电脑上的 MCP

安装完成时终端会显示 `nodrelay` 命令的位置（位于 `~/.devspace-fleet/<实例>/nodrelay`）：

```sh
# 命令行启动的 MCP
nodrelay mcp add files --allow read_text_file,list_directory,search_files -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
# 本机 HTTP MCP
nodrelay mcp add notes --url http://127.0.0.1:3000/mcp --header 'Authorization: Bearer <令牌>'
# 导入现有配置
nodrelay mcp import ~/Library/Application\ Support/Claude/claude_desktop_config.json
# 查看注册状态
nodrelay mcp list
```

几秒后，这些 MCP 就会出现在 Portal 里。也可以直接编辑 `nodrelay mcp path` 显示的 `mcp.json`：

```json
{
  "mcpServers": {
    "files": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "tools": { "allow": ["read_text_file", "list_directory", "search_files"] }
    },
    "notes": { "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

`tools.allow` 和 `tools.deny` 限制可用的工具，`"disabled": true` 可以暂时停用某个 MCP。`url` 只能是本机地址；远程 MCP 请直接添加到 Cloudflare MCP Portal。

### 4. 连接 MCP 客户端

把管理台显示的 Portal 地址 `https://<portal>/mcp` 添加到 ChatGPT、Claude、Cursor、VS Code 等客户端，用 Cloudflare Access 登录即可。

## 工作原理

```text
MCP 客户端 → Cloudflare MCP Portal（Access 登录）
              ├─ 办公室 Mac · files    ─┐
              ├─ 办公室 Mac · devspace ─┼─ Tunnel → 诺联设备服务 → 本机 MCP（stdio / HTTP）
              └─ 家里 Windows · notes  ── Tunnel → 诺联设备服务 → 本机 MCP
管理员     → Cloudflare Access → 诺联管理台（Worker + D1）
```

设备服务只监听本机回环地址，每个 MCP 在 `/mcp/<名称>` 下。设备定期向管理台报告自己提供的 MCP；管理台通过 Tunnel 核对握手成功后，才把它注册到 Portal；电脑上删除或停用后，再从 Portal 移除。

## 升级

- **管理台：** Logo 旁出现升级图标时点击升级，或重新运行第 1 步的命令。两种方式都保留域名、数据库、登录配置、Portal 和已接入的电脑。
- **电脑：** 参阅[更新与恢复](docs/device-recovery.md)。

## 当前状态

预览版，接口和安装包格式可能变化。

| 平台 | 状态 |
| --- | --- |
| macOS Apple Silicon | 已验证安装、Tunnel 和通过 Portal 调用工具 |
| Windows x64 | 已验证安装、修复、Tunnel 和通过 Portal 调用工具 |
| Linux x64 | Ubuntu 22.04（WSL2）已完成安装和 Tunnel 访问，独立主机上的 Portal 调用待验收 |
| macOS Intel、Linux arm64 | 已支持打包，公开安装包待发布 |

- 设备服务以当前登录用户的身份运行。Linux 主机无人值守运行时，请为该用户开启 linger。
- 管理台需要你 Cloudflare 账户里的一个域名，`workers.dev` 地址无法承载 Tunnel 和 Portal。
- 本机 MCP 是新功能，需要新版设备包；已安装的电脑继续提供 DevSpace，不受影响。

## 本地开发

需要 Node.js 24 或更高版本：

```sh
npm ci
npm test
```

## 许可证

[MIT](LICENSE)。安装包中的 Node.js、cloudflared、Personal DevSpace、Tabler Icons 和 npm 依赖遵循各自的许可证，声明收录在 [`licenses/`](licenses) 和各依赖目录中。
