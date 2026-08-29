# Codex Scope 5：仓库写入门禁

## 状态

Scope 5 已完成本地实现和干净提交自动化验收。发布前仍要补 Desktop UI 的交互 trust，以及真实企业环境的 managed-only 验收。当前自动测试、Docker L0、installed-cache 和本机 CLI 探针绑定到以下环境：

- macOS arm64；
- 独立 `codex-cli 0.146.0`，以及 Codex Desktop 26.820.60940 内置的 `codex-cli 0.150.0-alpha.8`；
- Hook runtime digest `39009949440eefea3fbd24f5b665bf0daad2af540b008601e72e3997c0f89691`；
- manifest hard timeout：5 秒。

这份文档说的是实际边界，不把 Hook 写成操作系统沙箱。

## 用户能得到什么

安装后的插件通过一个同步 `PreToolUse` dispatcher 检查 Codex 工具调用：

- primary checkout 只允许审核过的读取命令。15 个 TMB MCP 工具还要求 canonical `project_root` 一致，而且当前 cwd 到仓库根之间不能出现项目级 `.codex/config.toml`；
- `apply_patch` 只能在 branch-backed linked worktree 中修改 canonical root 内的普通路径；
- 所有 checkout 都拒绝 Git、`gh` 和 `glab` 写操作；
- bare shell、REPL、TTY 会话和 `write_stdin` 被拒绝；
- 未知工具名、未知 payload、无效 JSON、超限输入和 runtime digest 漂移一律拒绝。

放行时 dispatcher 不输出内容。拒绝时输出 Codex 接受的 `permissionDecision=deny` JSON，并给出以 `TMB-CODEX-HOOK:` 开头的原因。`permission_mode=bypassPermissions` 不会放宽策略；CLI 的 `--dangerously-bypass-hook-trust` 只跳过信任确认，Hook 仍会运行。

## 具体策略

| 调用 | primary checkout | linked worktree |
|---|---|---|
| `Read`、已知只读宿主工具 | 放行 | 放行 |
| 15 个 TMB MCP 工具 | 无项目级 Codex 配置且 `project_root` 一致时放行 | 规则相同 |
| 审核过的文件读取和 Git 查询 | 放行 | 放行 |
| package/build/test | 拒绝 | 只放行有限的非交互验证入口 |
| `apply_patch` | 拒绝 | 路径解析和 containment 通过后放行 |
| `Edit`、`Write` 和 code-mode wrapper | 拒绝 | 拒绝 |
| Git/forge 写操作 | 拒绝 | 拒绝 |
| shell、REPL、TTY、`write_stdin` | 拒绝 | 拒绝 |
| 未知工具或 payload | 拒绝 | 拒绝 |

Git 查询只接受固定前缀：`git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null ...`。`--no-lazy-fetch` 防止 partial clone 在查询缺失对象时写入 pack。子命令限于 `status`、`diff`、`log`、`show`、`rev-parse`、`ls-files`、`ls-tree` 和 `worktree list`；其中 `diff`、`log`、`show` 还必须显式带 `--no-ext-diff --no-textconv`。带 `--output`、`--exec`、`--config-env`、`--recurse-submodules`、签名验证等参数的调用不会放行，`git -C` 也不在范围内。

shell 命令按执行前的字面参数审核；环境变量、glob、brace、tilde、shell comment 和续行等二次展开语法直接拒绝。外部命令必须通过当前 `PATH` 解析到 checkout 和 Git 元数据之外的普通可执行文件，项目内同名程序与常见 toolchain shim 目录不会放行；dispatcher 自己固定调用 `/usr/bin/git`。读取命令也要满足有限参数形状：例如 `cat`、`head`、`wc` 和 `jq` 只能读取 checkout 内的普通文件；`rg` 必须显式使用 `--no-config`，也不能启用外部预处理或解压程序；`tail` 不能 follow；forge 查询不能 watch、显示凭据或打开浏览器。

linked worktree 的验证入口包括仓库的 `bash tests/run-all.sh`，以及受限的 `node --test`、Bun、npm、pnpm、pytest、Cargo 和 Go 测试/检查形状。package manager、Cargo 和 `tests/run-all.sh` 这类固定签名只能从 worktree root 启动。Node 和 pytest 的直接测试目标按实际 cwd 解析，必须留在当前 worktree；Go 还要求目标写成 `.` 或 `./...` 这类明确的本地文件系统形式。`all`、`std` 和模块导入路径不会放行。这里只审核入口，不能证明脚本内部的每一次文件访问。运行这些命令时仍要依赖 Codex sandbox。

## `apply_patch` containment

dispatcher 从 patch header 提取 `Add File`、`Update File`、`Delete File` 和 `Move to` 的全部目标。以下情况会拒绝：

- primary checkout、detached checkout 或 Git root 无法确定；
- 绝对路径、`..`、空路径段、反斜杠路径或无法解析的 patch；
- 目标越出当前 linked worktree；
- 任一路径组件是 symlink，已有目标文件带有额外 hard link，或现有目标不是普通文件；
- rename 的新目标越界；
- 目标位于 `.git/**`、`.claude/**`、`.tmb/**`；
- 目标是 `.codex/config.toml`、`.codex/hooks.json` 或两个 TMB Agent 文件。

两个 Agent 文件仍只能通过 Scope 4 materializer 修改。Hook 允许对应的 TMB MCP 调用，由 materializer 继续执行确认、exact-byte ownership 和冲突检查。

## 已验证的宿主行为

本机 CLI 探针记录到的实际工具名和 payload：

- shell：`Bash`，payload 必须精确为 `{command: string}`；带额外执行字段的 payload 和未实测的 shell 别名都会拒绝；
- patch：`apply_patch`，patch 位于 `tool_input.command`；
- code mode 的嵌套 `exec_command` 在当前版本最终以 `Bash` 进入 Hook；
- collaboration spawn：`collaborationspawn_agent`。

installed-cache 的插件 Hook 能被 CLI 加载，`${PLUGIN_ROOT}` 指向缓存副本。实测结果如下：

- primary 的 `apply_patch` 在文件变化前被拒绝；
- primary 的 shell 重定向在文件变化前被拒绝；
- primary 的 interpreter、shell wrapper、package script、Git 写入和 forge 写入都在 sentinel、index、refs 或本地 fake-forge log 改变前被拒绝；
- linked worktree 内的合法 patch 成功；
- linked worktree 的 parent、absolute、mixed-case protected、symlink、rename 和 detached patch 都在副作用前被拒绝；
- bare `bash` 未启动，因此没有后续 `write_stdin` 注入入口；
- `codex mcp list --json` 确认 installed provider 已启用；随后实测 `mcp__trajectory_server__agent_materialization_get` 产生配对的 started/completed 事件，返回 `status=completed`、`ok=true`，且 canonical `project_root` 与当前 checkout 一致；
- installed-cache policy 字节被修改后，runtime digest mismatch 拒绝了工具调用；
- `--dangerously-bypass-hook-trust` 下 Hook 仍执行；
- `permission_mode=bypassPermissions` 没有改变判定；
- `--disable hooks` 和插件卸载后，disposable primary patch 会执行，证明这两种状态确实没有 Scope 5 保护；
- Docker L0 的 31 个构建步骤全部通过，覆盖零 `node_modules` 冷启动、真实 Claude marketplace 安装缓存、SQLite 首次写入、语义搜索降级和 v1 数据库迁移；ShellCheck 0.11.0 也通过了仓库全部 shell 文件；
- 最近一次完整门禁中，40 次 warm Hook 调用的结果为 median 77.403 ms、p95 79.845 ms，cold 77.088 ms。该测量包含 canonical worktree 解析、Node launcher、dispatcher、启动链 watchdog 和内联 policy。性能结果仍需要在每个发布候选上重跑。

上述完整 CLI 矩阵已分别在独立 0.146.0 和 Desktop 内置 0.150.0 alpha 上通过。两者都使用隔离 `CODEX_HOME`，并要求 `candidate_dirty=false`；后者证明 Desktop 所携带宿主二进制没有产生策略漂移，但不能替代 Desktop UI 的交互 trust 和 managed-only 验收。

这次 CLI 环境没有建立出可运行的 collaboration child，无法证明子 Agent 继承同一 Hook。策略因此拒绝 `collaborationspawn_agent`。这不影响用户直接启动独立 Agent task，但不能把 model-driven spawn 当成已支持能力。

## 故障语义

dispatcher 只依赖 Node 内置模块，不读取 `node_modules`，不访问网络，也不写日志或数据库。manifest 先用固定 `/usr/bin/git` 和清理后的 Git 环境解析 canonical worktree root，再从宿主 `PATH` 找到 Node launcher，并用 `process.execPath` 解析真实可执行文件；checkout、插件缓存、Git 目录和 `node_modules/.bin` 中的 launcher 或真实文件都会被拒绝。这个检查在 cwd 位于仓库子目录时同样成立。nvm、fnm、asdf、mise、Volta 一类仓库外版本管理器可以继续工作；解析失败时才尝试四个固定系统路径。启动 dispatcher 前会清空环境，只传入最小 `PATH`、原始宿主 `PATH` 和插件目录。

manifest 用一次固定 Git 查询取得 canonical root、Git dir 和 common dir，并把这三个值传给 dispatcher。policy 会根据 `.git`、`commondir` 和 `HEAD` 核对这些值；验证通过后，policy 在受 digest 固定的 dispatcher 进程内执行，不再为常规同 checkout Hook 创建新的 Node isolate。宿主 Hook 进程的 `$PWD` 与 payload `cwd` 不一致、证明字段缺失或证明无法覆盖 payload `cwd` 时，dispatcher 会丢弃证明并回退到最长 3.5 秒的 policy worker；worker 继续使用固定 `/usr/bin/git` 和清理后的环境独立解析 payload `cwd`，不会把不一致当成放行。直接调用 dispatcher 时也走这条受监督路径。

manifest 另有固定 4 秒 watchdog，覆盖 Git、`realpath`、Node launcher、dispatcher 启动和内联 policy。超时后先向独立 launcher 进程组发送 TERM，0.2 秒后再发送 KILL；watcher 以状态 `124` 通知父 shell。即使 launcher 捕获 TERM 后返回成功，父 shell 也会 deny。Node 缺失、启动失败或启动链卡住时，这条路径会在 Codex 的 5 秒 host timeout 前结束。stdin 上限为 8 MiB，单条 shell command 上限为 256 KiB。

以下情况返回稳定 deny：

- runtime 文件缺失或 digest 不匹配；
- stdin 超限、JSON 无效或 payload 字段不完整；
- Git checkout 类型、canonical root 或 patch 目标无法确定；
- policy 抛错或没有给出明确判定。

Codex 在 5 秒后终止 Hook 进程。本机 `codex-cli 0.146.0` 的独立探针已经证明：如果整个 Hook 命令直接触发 host timeout，工具仍可能执行。因此 5 秒只能当最后的进程回收上界，不能当 deny 机制。发布验收必须证明 4 秒内部 watchdog 先返回有效 deny，且工具没有执行。

## 已知边界

Hook 只能判断宿主提交给它的工具调用。它不是通用 shell parser，也不能检查获准测试脚本的所有子进程。linked worktree 中，`apply_patch` containment 是强约束；验证脚本仍依赖宿主 sandbox。路径和可执行文件检查与真正执行之间存在同用户 TOCTOU 窗口；checkout 外的用户自管 `PATH` 程序和 Node 版本管理器仍属于宿主信任边界。

TMB MCP 只接受三个精确前缀：当前宿主实测到的 `mcp__trajectory_server__*`，以及安装模式可能生成的 `mcp__plugin_tmb_trajectory-server__*` 和下划线变体。调用中的 canonical `project_root` 必须等于当前 branch-backed checkout。由于 Hook payload 没有 provider 身份字段，未限定的 `trajectory_server` 名称可能被项目 MCP 影射；策略因此在当前 cwd 到仓库根的任一层发现 `.codex/config.toml` 时拒绝全部 TMB MCP 调用。用户级或企业级宿主配置仍属于受信任边界。宿主改变 MCP 合成方式后必须重新验收。

Hook definition 的任何改动都会使原有信任失效。更新带有 load-bearing policy 时，发布说明必须要求用户重新信任。未完成信任前，不能说 TMB enforcement 已启用。

当前实现不修改 `~/.codex/hooks.json`。如果插件 Hook 被禁用、未信任或卸载，Scope 5 不生效；Scope 4 的 Skills、MCP 和 Agent materializer 仍按各自边界工作。

## 验收与回滚

自动门禁包括：

- L1：manifest shape、runtime 文件边界、零依赖和 digest；
- L2：38 项 policy、dispatcher、oversize 和 malformed input 测试；
- L3：64 项 sentinel、Git tree、persistent receiver、Node launcher、完整进程组回收和 patch containment 测试；
- L0：真实 Codex installer、installed-cache 字节一致性和缓存内 dispatcher；
- MCP installed-cache：无源码 `node_modules` 的冷启动和 Hook 调用；
- 全量 Claude L1-L4 回归。

发布候选必须是干净提交。提交前的 dirty-worktree 结果只能作为实现验证，不能当发布证据。形成候选 SHA 后，独立 CLI 和 Desktop 内置 CLI 必须在同一提交上重跑 bypass、disabled Hook、卸载和回滚矩阵；Desktop UI 另行验收交互 trust，managed-only 只在真实受管环境验收。任一已知 primary source-write 产生副作用，或者 Desktop 无法从 installed-cache 加载同一 Hook，均停止发布。

回滚不写全局配置。卸载当前插件，或安装最后一个空 Codex Hook manifest 的可信版本，然后开新 task。回滚后要复查两个 TMB Agent 文件和 `.tmb/` 状态；插件卸载不会替用户删除项目文件。
