# 手动更新与恢复

在设备上以原安装用户操作。准备管理控制台的 HTTPS origin（例如 `https://fleet.example.com`）、设备 ID，以及从可信发行清单取得的本平台归档和同名版本的 `install-*` 脚本。按发行方提供的 `SHA256SUMS` 校验两者，再将它们放在同一个目录。脚本还会检查归档的固定 SHA-256，之后才解包。新设备优先使用控制台生成的一键安装命令；它会取回与该设备绑定的版本和校验值。

| 平台 | 本地安装 | 同版本修复 |
| --- | --- | --- |
| macOS ARM64 | `sh ./install-devspace-fleet-0.1.0-macos-arm64.sh` | 同一命令追加 `--repair` |
| Windows x64 | `powershell.exe -NoProfile -File .\install-devspace-fleet-0.1.0-windows-x64.ps1` | 同一命令追加 `-Repair` |
| Linux x64 | `sh ./install-devspace-fleet-0.1.0-linux-x64.sh` | 同一命令追加 `--repair` |

文件名以实际发行版本为准。本页的本地脚本用于同版本修复，或用旧版短时票据进行手动安装。不要把新版一次性接入码填进旧版的票据输入框；用控制台生成的完整命令。修复需要原 HTTPS origin、原设备 ID 与原版本归档，以及完整的安装收据和设备凭据。若 Windows 阻止运行脚本，使用控制台生成的标准安装命令，或让管理员按现有脚本签名策略审批该脚本。

## 同版本恢复

管理台升级不会改动已经安装的客户端，也不会替换旧安装命令固定的归档。同版本修复在版本标记一致时会复用原目录，不会覆盖其中的文件。安装脚本或客户端代码有变更时，发行方会使用新的设备包版本；不要用不同内容覆盖旧版本归档。换到新版请按[换版本与回退](#换版本与回退)操作。

1. 在控制台确认原设备仍可用。检查本机 `~/.devspace-fleet/<fingerprint>/connection-status.json` 的 `status` 和 `observedAt`。Windows 的 `~` 为原安装用户的用户目录。以同一目录中 `service.private.json` 的 `manager`、`deviceId` 和 `release` 核实服务归属。保存日志时只记录状态和时间，凭据文件留在私有目录中。
2. 先用同版本修复命令重新注册或启动已有服务。若归档文件已损坏，先按下段的服务停止步骤停止这套 Fleet 和它的 Personal Runtime。将收据所指的整个 `release-<version>` 目录移动到同一个私有根下的新备份目录，再运行 `--repair` 或 `-Repair` 从已核对的归档重新复制。保留其他状态目录和收据，让重新安装沿用原路径及凭据。
3. 检查本机服务状态与控制台的 Tunnel、MCP 和 Portal 状态。若修复失败，停止该服务，保留失败候选以便诊断。仅在本地备份已核对且设备仍有效时，将同版本备份放回收据中的原路径，然后重新启动对应服务。若收到过吊销确认，按新设备接入流程处理。
## 首次接入中断

- **等待设备接入**：命令尚未领取，没有固定有效期。在原设备上重跑同一条命令即可。若怀疑命令泄露，先在控制台取消未领取的命令，再生成新命令；旧命令不会恢复。
- **安装中**：命令已经领取，但设备还没接入成功。从首次领取起 15 分钟内，用原安装用户在同一台设备上重跑原命令。不要删本机私有目录；恢复需要其中保存的凭据。把命令复制到另一台机器不能恢复。
- **恢复窗口已过，或设备上的恢复凭据已丢失**：在控制台停用原设备，再用新的设备 ID 添加设备并生成命令。已领取的命令不会重新显示，也不能为原设备 ID 补发；若要在同一台机器重新接入，按下文停止原服务并备份私有根目录。
- **仍使用旧版短时票据的管理台**：旧票据与新版一次性接入码是两个流程。待接入设备的旧票据过期或已消耗且凭据未保存时，可为该待接入设备生成新票据。

## 换版本与回退

1. 保留已核对的当前归档、同版本脚本和需要留存的工作数据。确认目标版本已经进入管理控制台使用的发布目录。更新会中断现有设备连接，先停止该设备正在执行的操作。
2. 在控制台禁用旧设备，等吊销状态显示完成。使用下面的系统命令停止并注销这套已核对归属的 Fleet 和 Personal 服务。把整个对应 `<fingerprint>` 目录改名保留在 `~/.devspace-fleet` 下，保持原有权限。管理控制台相同的 origin 会复用这个位置，因此目标路径必须空出。备份包含设备凭据，应留在原安装用户的私有目录内。
3. 为同一台机器创建**新的设备 ID**，选择目标版本对应的平台归档，运行控制台为新设备生成的完整安装命令。确认本机服务启动，控制台的 Tunnel、MCP 和 Portal 都显示就绪，再授权客户端使用新设备。
4. 如果需要回退版本，在管理控制台恢复旧归档为该平台的已审核版本，核对旧归档 SHA-256，然后按这套替换步骤为旧版本创建另一个新设备 ID。旧的已吊销设备凭据继续封存在备份中。

### 找到并停止对应服务

Fleet 服务名是 `devspace-fleet-<fingerprint>`。在系统服务定义中核对执行程序位于 `service.private.json` 里的 `release` 目录内，并且参数引用这份收据。Personal Runtime 的名字形如 `com.personal-devspace.<owner>.<component>`。只处理配置中 `PERSONAL_DEVSPACE_HOME` 精确指向同一私有根中 `personal` 子目录的 `runtime` 或 `desktop`。Linux 无桌面安装通常只有 `runtime`。

下列示例中的 `label`、`task`、`unit` 都是已经核对的具体名称。对同版本修复只执行停止动作，保留注册文件。换版本时执行注销动作，再搬移私有根。遇到权限错误、服务仍在运行或目标归属无法确认时，暂停换版本。

| 平台 | 检查与停止 | 换版本时注销 |
| --- | --- | --- |
| macOS | 用 `launchctl print "gui/$(id -u)/$label"` 和 `plutil -p "$HOME/Library/LaunchAgents/$label.plist"` 检查。执行 `launchctl bootout "gui/$(id -u)/$label"`，再确认该服务已卸载。 | 将已核对的 `~/Library/LaunchAgents/$label.plist` 移入本次私有备份，防止重新登录时加载。 |
| Windows | 用 `Get-ScheduledTask -TaskPath '\' -TaskName $task` 查看 `Actions` 及 `Principal`。执行 `Stop-ScheduledTask -TaskPath '\' -TaskName $task`，查到任务已停止后再继续。 | 执行 `Unregister-ScheduledTask -TaskPath '\' -TaskName $task -Confirm`，确认只移除已核对的任务。 |
| Linux | 用 `systemctl --user cat "$unit"` 查看定义，单位名称包含 `.service`。执行 `systemctl --user stop "$unit"`，再用 `systemctl --user is-active "$unit"` 检查状态。 | 执行 `systemctl --user disable "$unit"`，将已核对的 `~/.config/systemd/user/$unit` 移入本次私有备份，再执行 `systemctl --user daemon-reload`。 |

实例的本机端口记录在该实例私有目录的 `ports.private.json`；没有这个文件的旧安装使用 7829、7830，以及已启用浏览器时的 7831。用系统的端口查看工具确认这些端口已释放。若端口属于其他服务，请保留该服务：支持端口协商的管理台生成的新安装命令会自动改用空闲端口，与已有实例共存；旧管理台的命令仍需先解决冲突再安装。
