# Codex Scope 5：仓库写入门禁

## 状态

当前 `1.0.6-rc.1` 候选包含针对 PR #1183 评论的本地修复，已完成一轮配套 CLI 联调，发布验收尚未完成。修复覆盖 shell 显式读取、Git 查询参数、core 分支前缀兼容和 Node launcher 后续候选解析，并接入仓库配置的受保护分支集合。新增的 macOS 受限命令 runner 让验证脚本、Node 子进程、npm 生命周期和 Git filter 继承相应文件与网络限制。发布前还需在同一干净候选 SHA 上完成安装与宿主矩阵。

官方 CLI `0.151.0` 和 `0.153.4` 仍存在宿主阻塞：`exec_command` 到达 Hook 时只有 `Bash` 和 command 字符串，没有实际启动所需的 shell、login、tty、workdir 信息。当前候选会拒绝这类只有 command 的 Bash 调用，包括文件读取和 `pwd`。这两个未经修改的 CLI 版本仍不能使用受限 Git、forge 和验证执行。

当前插件候选增加了对配套宿主补丁的支持，由宿主在顶层 `execution_context` 中提供已经解析的启动参数。真实 CLI 与已安装插件的八个局部验收场景已通过，接口尚未合入或发布；官方 CLI 的上述限制仍在。完整 Desktop 矩阵和 L6 验收尚未完成，下方历史测试记录不作为这次宿主修复的验证结果。

本轮联调使用隔离 profile，确认九个安装文件与候选逐字节一致，再通过正常 `/hooks` 界面审阅并信任 Hook。测试由本地服务提供确定的 Responses 事件，调用经过真实 CLI、Hook 和执行管理器；没有向 dispatcher 直接提交人工构造的 Hook payload。

允许的读取返回了预期 checkout 的 marker。raw Node 测试先被拒绝，随后 fixture 从拒绝消息中取出恢复参数，以 `/bin/sh`、`login=false`、`tty=false` 和匹配的 workdir 发起直接 `exec_command`。受限测试实际运行，成功写入普通文件，并确认内层 sandbox 拒绝写入 `.git/forbidden-marker`。

错误 cwd、`login=true`、`tty=true` 和默认 shell 四个场景均在命令启动前被 Hook 拒绝。同一安装与 trust 状态下，未经修改的 CLI `0.153.4` 也拒绝了读取。配套 CLI 使用外层 read-only sandbox 时，runner 创建私有 scratch 遇到 `EPERM`，退出码为 125，测试写入目标没有创建。这些结果覆盖八个局部场景，不能代替完整发布验收。

交付验收另修正了两处真实宿主问题：forge/push 进程需要访问精确的系统 trust agent 才能校验 TLS 证书；Codex 提供的插件数据目录尚未创建时，也应能生成受限命令。后者只验证并保护未来路径，不创建目录，不放宽路径绑定。

`1.0.5` 曾完成交付自锁修复的本机重新安装、trust 和少量全新会话探针；下方保留这些历史记录，不将它们当作当前候选的验收。Human 已经发出的交付指令仍由主对话继续执行，Hook 检查分支、命令和路径状态，不生成授权令牌。

当前源码候选绑定到以下环境：

- macOS arm64；
- 下方本地验证记录使用 Node `25.8.0`、Bun `1.3.11` 和独立 CLI `0.151.0`；本次另检查了官方 CLI `0.153.4` 的调用合同，读取版本号或源码本身不算执行验收；
- 历史 `1.0.4` 兼容矩阵包含独立 `codex-cli 0.146.0` 和 Codex Desktop 26.820.60940 内置的 `codex-cli 0.150.0-alpha.8`；`1.0.5` 隔离安装烟测使用 `codex-cli 0.150.1`；
- 本地未发布插件候选版本 `1.0.6-rc.1`；
- 七个固定 ESM 文件加规范化 Hook definition 的 Hook runtime digest `e7f0e387afa2a9a533f549ce84ec02575e152618fed5c057d771067f0e2dd9f0`；
- manifest hard timeout：5 秒。

Hook 审核调用，受限 runner 在 macOS 操作系统层执行进程权限限制。两层职责不同；其他平台目前拒绝 Git、forge 和验证执行。

## 用户能得到什么

安装后的插件通过一个同步 `PreToolUse` dispatcher 检查 Codex 工具调用：

- 受保护分支允许审核过的读取命令；分支策略有效时，还允许创建受控 feature branch 和显式取消暂存。15 个 TMB MCP 工具还要求 canonical `project_root` 一致，而且当前 cwd 到仓库根之间不能出现项目级 `.codex/config.toml`；
- branch-backed primary checkout 和 linked worktree 只要位于允许的 feature branch，都可以用 `apply_patch` 修改 canonical root 内的普通路径，并运行有限的非交互验证入口；
- feature branch 可以执行有限交付链：显式文件暂存、取消暂存、单条 message commit、把当前分支非 force 地 push 到 `origin`，以及创建、更新或 ready pull request；
- `main`、`master`、`dev` 等共享分支，以及 merge、rebase、reset、force-push、PR merge、GitHub Issue 写入和其他 Git/forge 变更继续拒绝；
- bare shell、REPL 和 TTY 会话被拒绝；`write_stdin` 只接受空轮询或单个 Ctrl-C；
- `functions.exec` 只接受一个静态可解析的 canonical 嵌套调用，并在执行前递归应用同一策略，不依赖宿主再次触发 Hook；
- Codex 的只读任务诊断，以及仅指向 TMB 的插件卸载入口保持可用；
- 未知工具名、未知 payload、无效 JSON、超限输入和 runtime digest 漂移一律拒绝。

放行时 dispatcher 不输出内容。拒绝时输出 Codex 接受的 `permissionDecision=deny` JSON，并给出以 `TMB-CODEX-HOOK:` 开头的原因。`permission_mode=bypassPermissions` 不会放宽策略；CLI 的 `--dangerously-bypass-hook-trust` 只跳过信任确认，Hook 仍会运行。

## 具体策略

以下描述策略和 runner 的接口规则，本次宿主验收目标为 macOS arm64。配套宿主补丁保留 `Bash` 和精确的 `tool_input: {command: string}`，另在顶层提供 `execution_context`。启动检查只接受本地执行，要求 `kind=exec_command`、`shell_mode=direct`、`is_remote=false`、`login=false`、`tty=false`，且实际 shell 参数必须精确为 `["/bin/sh", "-c", command]`。其中 canonical `cwd` 必须等于 Hook 的 canonical cwd；`environment_id` 不能全为空白、超过 256 个 UTF-8 字节或包含 ASCII 控制字符。

Codex 的 `shell` 参数只用于选择 shell 类型，最终可能选中另一条同类型程序路径。因此即使请求填写 `/bin/sh`，实际 argv 选中其他 `sh` 程序时仍会拒绝。模型塞进 `tool_input` 的执行字段或 `execution_context` 不可信，不能代替宿主顶层信息。顶层 argv 描述执行管理器添加 sandbox 或平台 shell wrapper 之前的命令，本策略只接受上述本地 direct 子集。

所有 Bash 调用都先检查启动信息，再判断命令是否允许。即使是 `cat marker.txt`，也不能在 A checkout 检查路径后去 B checkout 读取；启动字段缺失、无效或带有额外字段时，`pwd`、`true` 同样拒绝。原生文件读取、Codex 诊断和精确插件卸载仍可使用。

既有静态 `functions.exec` 嵌套调用路径仍保留，供单独完成验收的宿主使用。每个嵌套 `exec_command`，包括 `cat`、`pwd` 和 `true`，都必须显式提供 `shell=/bin/sh`、`login=false`、`tty=false`，以及与 Hook canonical cwd 完全相同的 canonical `workdir`。任一字段缺失或无效都拒绝。

官方 CLI `0.151.0` 和 `0.153.4` 缺少所需证明，继续拒绝受限执行。两条路径中的 Git、forge 和验证命令都必须使用完整固定 runner wrapper，raw 调用仍拒绝；命令中的 `env -i` 晚于外层 shell 启动，不能替代启动参数检查。

| 调用 | primary checkout | linked worktree |
|---|---|---|
| `Read`、已知只读宿主工具 | 放行 | 放行 |
| 15 个 TMB MCP 工具 | 无项目级 Codex 配置且 `project_root` 一致时放行 | 规则相同 |
| 审核过的文件读取和 Git 查询 | 放行 | 放行 |
| package/build/test | feature branch 只放行有限的非交互验证入口 | 规则相同 |
| `apply_patch` | feature branch 且路径 containment 通过后放行 | 规则相同 |
| `Edit`、`Write`、REPL | 拒绝 | 拒绝 |
| `functions.exec` 编排壳、只读 Codex 诊断 | 仅放行单个 JSON-literal 嵌套调用；内层先按同一策略检查 | 规则相同 |
| 卸载 TMB 的恢复调用 | 仅接受精确 TMB selector | 规则相同 |
| 有限 Git/PR 交付 | feature branch 按状态和参数放行 | 规则相同 |
| 危险或越界 Git/forge 写操作 | 拒绝 | 拒绝 |
| shell、TTY | 拒绝 | 拒绝 |
| `write_stdin` | 仅空轮询或单个 Ctrl-C | 规则相同 |
| 未知工具或 payload | 拒绝 | 拒绝 |

Git 查询只接受固定前缀：`git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c core.hooksPath=/dev/null ...`。`--no-lazy-fetch` 防止 partial clone 在查询缺失对象时写入 pack。子命令限于 `status`、`diff`、`log`、`show`、`rev-parse`、`ls-files`、`ls-tree` 和 `worktree list`；其中 `diff`、`log`、`show` 还必须显式带 `--no-ext-diff --no-textconv`。参数按子命令精确列入白名单，不接受长选项缩写、文件输入选项、签名格式别名或 `--no-index`。路径参数和 revision 中的路径部分必须位于 checkout 内，不能借隐式 no-index 比较读取仓库外文件。`git -C` 不在范围内。这些参数必须放在受限 runner 内执行。Git 查询进程及其 helper 只读 checkout/Git 元数据，不能访问网络或写入仓库。

shell 命令按执行前的字面参数审核；环境变量、glob、brace、tilde、shell comment 和续行等二次展开语法直接拒绝。外部命令必须通过当前 `PATH` 解析到 checkout 和 Git 元数据之外的普通可执行文件，项目内同名程序与常见 toolchain shim 目录不会放行；dispatcher 自己固定调用 `/usr/bin/git`。文件内容和 metadata 命令的显式路径必须留在 checkout 内，拒绝 symlink、额外 hard link 和特殊文件。`rg` 解析 pattern、路径及 flag 参数：始终需要 `--no-config`；目录搜索和 `--files` 还需 `--no-ignore`，避免隐式 ignore 文件是 FIFO 时等待。需要过滤目录时可使用 `-g` 或显式普通文件 `--ignore-file`。不允许 stdin、跟随链接、外部预处理或解压；`tail` 不能 follow。`jq` 的 inline 或文件 filter 不支持 `import/include` 模块；源码中的字符串、注释也保守拒绝这两个词。文件 filter 限 256 KiB，且不能来自受保护状态路径。此检查不保证任意表达式执行时间有界。`dirname`、`basename` 仅操作字符串。forge 查询不能 watch、显示凭据、打开浏览器或指定其他仓库。受限入口绑定唯一 `origin`，只支持 GitHub.com/GitLab.com；CLI 使用独立配置目录和 cwd，不继承目标覆盖变量。`--jq`、`--template` 等动态 formatter 拒绝，保留 JSON 字段输出。宿主 `Read` 等工具没有同一条路径 gate，因此不能据此宣称全局保密边界。

feature branch 的验证入口包括仓库的 `bash tests/run-all.sh`，以及受限的 `node --test`、Bun、npm、pnpm、pytest、Cargo 和 Go 测试/检查形状。package manager、Cargo 和 `tests/run-all.sh` 这类固定签名只能从 checkout root 启动。Node 和 pytest 的直接测试目标按实际 cwd 解析，必须留在当前 checkout；Go 还要求目标写成 `.` 或 `./...` 这类明确的本地文件系统形式。`all`、`std` 和模块导入路径不会放行。入口审核后，runner 以清空环境的固定 Node 启动，并通过 macOS Seatbelt 执行目标。验证可以写普通源码和私有 scratch；Git、`.tmb`、`.claude`、`.codex`、插件目录及仓库外路径不能写，治理状态和任意仓库外文件不能读；固定系统目录、已选运行时和工具链安装目录保留读取权限，网络拒绝。普通子进程继承同一限制。执行前拒绝可写树中的硬链接和特殊文件，profile 阻止受保护祖先改名及新硬链接。进程组清理不能保证终止自行脱离的后代；这些后代继续受原权限限制。具体调用格式及兼容范围见 [受限执行说明](RESTRICTED_EXECUTION.md)。

feature branch 必须使用 `codex/`、`feat/`、`feature/`、`fix/`、`bugfix/`、`docs/`、`chore/`、`refactor/`、`test/`、`perf/`、`hotfix/`、`build/`、`ci/`、`style/` 或 `revert/` 前缀，而且不能属于配置的保护集合。`git add` 必须在 `--` 后逐个列出文件，避免把用户未要求的改动一起带入 commit。push 只能指向 `origin` 的当前 feature branch，不能 force，也不能附带第二个 refspec。GitHub 写操作只开放 `gh pr create`、正文/标题 `edit` 和 `ready`；GitLab 只开放 `glab mr create`。本地 Git 交付禁止派生子进程，并在执行前拒绝已配置的 hooks、filters、signing 和可执行仓库 Hook。push 使用绑定 origin 的 HTTPS、明确 refspec 和固定系统执行器。受限 runner 不会执行任意 credential helper、SSH 命令或仓库 CLI alias。这些命令是否符合 Human 的原始要求由主对话负责，Hook 不解析“继续”“可以”等自然语言。

`apply_patch`、验证和交付 gate 会读取当前 acting worktree 的 `.tmb/<Codex manifest name>/trajectory.db`。插件名取自受信任的 `.codex-plugin/plugin.json`，`repos` 行按 canonical worktree path 匹配；不会转向 primary checkout 的数据库或 Claude 状态。保护集合是匹配 repo 的 `repos.protected_branches`、`target_branch`、可选旧字段 `pr_target` 和相关 `tasks.parent_branch_id` 的并集，再叠加固定规则。当前数据库中 `tasks.repo IS NULL` 的合法 parent 分支也纳入保护，不受 repo 注册行数量限制。空值不会增加保护分支。

配置保护 key 和待检查分支名统一经过 `.normalize("NFC").toLowerCase()` 后比较，新建分支的目标名称也遵守该规则。这避免 macOS 上仅改变 HEAD 拼写就绕过同一 Git ref 的保护；即使文件系统能区分大小写或 canonical Unicode 变体，也按同一保守规则拒绝这些等价拼写。

数据库不存在时使用固定基线。有效数据库尚未登记当前 canonical root 时，仍纳入其中的 NULL-repo task parent；没有这类 parent 才只使用固定基线。已存在的数据库若损坏、路径不安全、schema 不支持、注册重复、配置无效或无法读取，则拒绝 patch、验证和交付调用，包括新建分支及取消暂存；不会退回固定规则。配置有效时，`git restore --staged -- <files>` 可在受保护分支执行，只取消指定文件的暂存。审核过的读取和诊断不会加载分支策略模块，也不会查询数据库。

现有数据库的读取目前只支持 macOS：固定使用 `/usr/bin/sandbox-exec` 包裹 `/usr/bin/sqlite3`，在操作系统层拒绝文件写入和网络访问，并使用 SQLite read-only、query-only、`trusted_schema=OFF`、空启动文件和清理后的环境。读取预算为 500 ms，每次快照读入内存的数据库及 sidecar 文件合计不得超过 64 MiB。只接受所需的普通 `repos`、`tasks` 表，拒绝 rollback journal、孤立 sidecar 和不完整 WAL/SHM 对。

有 WAL 时，先校验文件字节，再让 SQLite 查询：检查 WAL header 和逐 frame 的累计 checksum、salt、最终 commit 边界，以及 SHM 双 header、checksum、`mxFrame`、`nPage`、`aFrameCksum`、page/hash 索引和已 backfill 的数据库页是否一致。SQLite 查询成功本身不能证明状态完整；它可能忽略损坏的 WAL 尾部而读取旧 checkpoint。

当前兼容范围如下，所有可读状态还必须通过 schema、路径、容量和前后完整性检查：

| 数据库状态 | 分支策略读取 |
|---|---|
| 完整且已提交的 WAL generation，SHM 一致 | 普通只读查询 |
| 一致的 PASSIVE/FULL backfill 状态 | 普通只读查询 |
| 已关闭且没有 sidecar 的数据库 | immutable 查询 |
| 空 WAL，例如 TRUNCATE 后连接仍打开 | 拒绝 |
| 只有 header 的 WAL | 拒绝 |
| 未提交或 rollback 留下的尾部 | 拒绝 |
| RESTART 后残留的旧 generation 尾部 | 拒绝 |

后四类可以是合法 SQLite 状态，属于当前兼容限制，不能一概称为损坏。拒绝会阻止 patch、验证和交付；仅重试同一状态不能保证恢复。Hook 不会为放行而 checkpoint、修复数据库或删除 sidecar。两次查询前后还比较文件身份、metadata 和内容 hash，状态变化即拒绝。这些检查不提供原子文件系统快照，路径检查与执行之间的 TOCTOU 边界仍在。现有数据库位于不支持的平台时，写入类调用同样拒绝。

## `apply_patch` containment

dispatcher 从 patch header 提取 `Add File`、`Update File`、`Delete File` 和 `Move to` 的全部目标。以下情况会拒绝：

- 受保护分支、detached checkout 或 Git root 无法确定；
- 绝对路径、`..`、空路径段、反斜杠路径或无法解析的 patch；
- 目标越出当前 checkout；
- 任一路径组件是 symlink，已有目标文件带有额外 hard link，或现有目标不是普通文件；
- rename 的新目标越界；
- 目标位于 `.git/**`、`.claude/**`、`.tmb/**`；
- 目标是 `.codex/config.toml`、`.codex/hooks.json` 或两个 TMB Agent 文件。

两个 Agent 文件仍只能通过 Scope 4 materializer 修改。Hook 允许对应的 TMB MCP 调用，由 materializer 继续执行确认、exact-byte ownership 和冲突检查。

## 验证状态

本次宿主参数修复的完整本地回归 exit 0：Codex L2 194/194、L3 191/191，两轮 MCP 单元测试各 1025/1025、MCP integration 70/70，均无跳过；全部 65 个 Hook 测试文件及六个 L4 flow 通过。真实 CLI `0.153.4` 隔离安装和缓存冷启动检查通过。读取路径 benchmark 的 cold 为 76.580 ms，40 次 warm median 为 77.451 ms，p95 为 79.204 ms，门限未改。ShellCheck `0.11.0` 随后独立检查 253/253 个脚本通过。

上述结果来自提交前的工作树。配套宿主补丁另通过 176 项 Hook 测试、4 项准备调用测试、16 项 Hook 集成、32 项 registry/unified-exec 单元测试和 18 项执行与权限集成测试；`just fmt` 与 Clippy 通过。八场景真实 CLI 联调的范围见上方状态。完整发布矩阵、当前候选的 Claude Docker L0 和 maintainer L6 仍未完成。

2026-09-08 交付验收发现并修复了上述 TLS 与未来插件数据目录问题。修正后的 profile 15/15、runner 14/14 通过，均无跳过；真实 `gh` 查询在当前生产 profile 下完成 TLS 校验并成功返回。完整回归与宿主验收需要绑定包含这两处修正的提交，不能沿用前一候选的结论。

前一候选 `849196bb` 的 Docker L0 原有断言全部通过，ShellCheck 0.9.0 检查 253/253 个 shell 文件通过。Docker 的既有语义搜索探针接受缺失 `id:2` 的响应，本次确实没有该响应，因此不算语义搜索结果或完整冷加载超时的验证。CLI 0.151.0 隔离安装字节一致，并已通过真实 `/hooks` 界面信任；这些记录只覆盖修正前的候选。

修正前的七模块候选完整回归 exit 0：Hook L2 173/173（无跳过）、L3 178/178、两轮 MCP 各 1025/1025、MCP integration 70/70，全部 65 个 Hook 测试文件及六个 L4 flow 通过。真实 CLI 0.151.0 隔离 installer 和缓存冷启动也通过。专项进程边界测试为 profile 13/13、runner 10/10，包含 Git include 不能读 Claude 状态的回归。读取路径 benchmark 的 cold 为 77.246 ms，40 次 warm median 为 75.906 ms，p95 为 77.415 ms，均通过原有门限。

前一次完整运行因两处旧缓存测试仍使用 raw Git 正例而 exit 1。这两处已改用实际安装目录生成的 wrapper，并保留 raw Git 拒绝断言。ShellCheck 缺失，在线标签检查受环境限制，日志仍保留此前已有的原生库退出信息。真实 glab、真实远程 push/PR 写入和同一干净 SHA 宿主矩阵尚未验证。

以下 2026-09-07 完整回归对应旧三模块实现，只作为历史证据。

2026-09-07 的三模块源码曾冻结。配置分支、WAL/SHM 故障、NULL-repo parent，以及四类配置来源和新建分支的大小写/Unicode 双向变体正式回归 26/26，无 skip；基线 Codex L2 82/82，合计 108/108。冻结后的完整本地回归 exit 0：真实 CLI 0.151.0 隔离安装烟测通过，Hook L3 105/105、两轮 MCP 各 1022/1022、MCP integration 70/70，全部 65 个 Hook 测试文件和六个 L4 flow 通过。最终读取路径 benchmark（Bash pwd）为 cold 74.694 ms、40 次 warm median 74.775 ms、p95 76.327 ms，门限通过。ShellCheck 缺失、在线标签鉴权/网络检查 skip；Claude Docker L0/L6、当前用户 trust 和完整同 SHA CLI/Desktop 矩阵未运行。日志仍有此前已有的原生库 mutex lock failed 退出信息，测试断言及分层 exit 均通过。这些本地结果不代表发布验收通过。

同日、分支名比较修正之前的 WAL 版本完整本地回归 exit 0；读取路径 benchmark 为 cold 79.641 ms、median 77.155 ms、p95 79.112 ms，独立 34-case 探针确认所测 WAL 状态的判定及数据库字节不变。这是该阶段的历史证据，不能覆盖之后的分支名比较修正。

历史记录：2026-09-06 的 `1.0.6-rc.1` 工作树检查中，Codex L2 合计 81/81；两轮 MCP 单元测试各 1022/1022；MCP integration 70/70。Hook 读取路径 benchmark 的 cold 为 77.873 ms、40 次 warm median 为 76.572 ms、p95 为 78.28 ms，门限通过。真实 installer 脚本在临时 `CODEX_HOME` 和 CLI `0.151.0` 下通过，覆盖缓存污染、卸载重装、逐字节比较和缓存内 dispatcher。该结果不代表当前用户已重新 trust，也不是干净 SHA 的宿主矩阵。完整本地 L1–L4 随后 exit 0，65 个 Hook 测试文件和六个 L4 flow 全通过；ShellCheck 与在线标签检查 skip，Docker L0/L6 和完整宿主矩阵未运行。补充 jq filter 源码不得来自受保护状态的检查后，81 项 L2、104 项 L3、相关静态检查和真实 installer 再次通过；该阶段读取路径 latency 为 cold 115.339 ms、median 92.896 ms、p95 117.566 ms。完整回归日志保留 jq 补充前的结果，不能覆盖之后的分支配置实现。

Hook benchmark 使用 `Bash` 的 `pwd` payload，经 manifest 调用 41 次，其中一次 cold、40 次 warm。它测量读取路径，不包含分支配置的 SQLite 查询，也不证明写入类调用在同一时间内完成。

本地 `1.0.6-rc.1` 增加了 core 前缀契约、文件与 Git 参数、配置分支及数据库读取的回归测试，并扩展 Node PATH 集成测试。每轮结果只覆盖测试时的实现；发布验收还需在同一干净候选提交上完成宿主矩阵。

以下为 `1.0.5` 历史记录。源码级自动测试覆盖了 feature-branch patch、验证、暂存、commit、push 和 PR 交付，以及受保护分支和危险操作的拒绝。`codex-plugin-surface-smoke.sh` 还在隔离 `CODEX_HOME` 中故意污染缓存，确认卸载会删除旧路径，并验证重装后的 manifest、dispatcher 和 policy 与 `1.0.5` 源码逐字节一致。这些结果证明源码和隔离安装链；本机 trust、缓存状态和全新会话证据单独记录在下方。

原 `1.0.4` 宿主基线还确认了以下 payload 事实，它们仍用于兼容回归：

- shell：`Bash`，payload 必须精确为 `{command: string}`；带额外执行字段的 payload 和未实测的 shell 别名都会拒绝；
- patch：`apply_patch`，patch 位于 `tool_input.command`；
- `functions.exec` 本身没有 Node、文件系统或网络能力，但当前宿主不会为其嵌套工具再次触发 Hook；policy 因此只接受 `text(JSON.stringify(await tools.<name>(<JSON>)));` 形状，并在外层判定中先审核内层工具；
- collaboration spawn：`collaborationspawn_agent`。

`1.0.5` 的自动测试和隔离安装烟测得到以下结果：

- 受保护分支的 `apply_patch` 在文件变化前被拒绝；
- 受保护 checkout 的 shell 重定向在文件变化前被拒绝；
- 受保护分支的 interpreter、shell wrapper、package script 和危险 Git/forge 写入都在 sentinel、index、refs 或本地 fake-forge log 改变前被拒绝；
- feature branch 内的合法 patch、验证和有限交付命令通过策略；
- feature checkout 的 parent、absolute、mixed-case protected、symlink、rename 和 detached patch 都在副作用前被拒绝；
- bare `bash` 未启动；`write_stdin` 的空轮询和单个 Ctrl-C 可以收尾已获准的进程，其他字符和额外字段会被拒绝；
- `functions.exec`、只读任务诊断和精确的 TMB 卸载恢复入口可达，其他插件卸载仍被拒绝；
- installed-cache policy 字节被修改后，runtime digest mismatch 拒绝了工具调用；
- 40 次 warm Hook 调用的 median 为 77.216 ms、p95 为 79.464 ms，cold 为 76.2 ms，低于 100 ms、250 ms 和 1 秒的对应门限；
- 干净候选形成后，本机删除了旧 `1.0.4` 缓存，重新安装 `1.0.5`，确认 Hook manifest、dispatcher 和 policy 与源码逐字节一致，再通过 CLI `/hooks` 审阅、trust 并启用当前定义；
- 全新 CLI 会话允许 `pwd`，并在执行前拒绝无副作用的广泛暂存探针 `git add --dry-run .`。会话正常退出，没有重试或生命周期循环；
- 全新 Desktop task 可以调用 `read_thread_terminal`，也能通过 `functions.exec` 完成嵌套 `pwd`，两项均未被 Hook 拒绝。

原 `1.0.4` 的真实宿主矩阵还证明：installed-cache Hook 能被 CLI 加载，`${PLUGIN_ROOT}` 指向缓存副本；`codex mcp list --json` 确认 installed provider 已启用；`mcp__trajectory_server__agent_materialization_get` 产生配对的 started/completed 事件，返回 `status=completed`、`ok=true`，且 canonical `project_root` 与当前 checkout 一致。此外：

- `--dangerously-bypass-hook-trust` 下 Hook 仍执行；
- `permission_mode=bypassPermissions` 没有改变判定；
- `--disable hooks` 和插件卸载后的旧基线证明这两种状态没有 Scope 5 保护；`1.0.5` 已在 `codex-cli 0.150.1` 上完成本机闭环，历史 0.146.0、0.150.0 alpha 和 Docker 矩阵仍只算旧版兼容基线；
- Docker L0 的 31 个构建步骤全部通过，覆盖零 `node_modules` 冷启动、真实 Claude marketplace 安装缓存、SQLite 首次写入、语义搜索降级和 v1 数据库迁移；ShellCheck 0.11.0 也通过了仓库全部 shell 文件。

旧矩阵曾在独立 0.146.0 和 Desktop 内置 0.150.0 alpha 上通过。由于 Hook definition 和 runtime digest 已变化，这些结果只说明宿主基础兼容，不是 `1.0.5` 发布证据。

这次 CLI 环境没有建立出可运行的 collaboration child，无法证明子 Agent 继承同一 Hook。策略因此拒绝 `collaborationspawn_agent`。这不影响用户直接启动独立 Agent task，但不能把 model-driven spawn 当成已支持能力。

## 故障语义

runtime 包含七个固定 ESM 文件：dispatcher、repo policy、branch policy、restricted runner、restricted profile、forge binding 和共享 tool names。它们只导入 Node 内置模块或这组固定文件，不依赖 npm runtime 包。Hook 判定模块不写状态；runner 和 forge binding 只创建私有 scratch 配置。摘要还包含规范化的 `hooks/codex/hooks.json`，仅将唯一摘要值归零，launcher 字节、timeout 和其他字段变化都会改变摘要。

launcher 先用固定 `/usr/bin/git` 和清理后的环境解析 canonical worktree root、Git dir 和 common dir，再检查宿主 PATH 中的 Node。系统 `realpath` 加 builtin `-ef` 祖先身份检查覆盖 checkout、插件、外置 Git 元数据及 linked common dir；这些目录中的伪 Node 不能成为启动器。遇到不可信候选会继续检查后续绝对 PATH 条目和固定系统路径；相对条目跳过。版本管理器 shim 在清空环境、固定 PATH、安全绝对 HOME 和 `/` cwd 下解析宿主默认 Node，避免预加载和项目配置在 Hook 前执行；项目局部版本设置不参与 bootstrap。无效 HOME 会使对应 shim 被跳过。启动 dispatcher 时仅保留固定 PATH、原始宿主 PATH、仓库证明和宿主提供的插件路径。

受限命令通过 `/usr/bin/env -i` 启动固定 Node；宿主插件数据路径随 canonical wrapper 固定传入，模型不能替换。子进程使用私有 HOME、缓存与临时目录。详细 profile、凭据处理及兼容限制见 [受限执行说明](RESTRICTED_EXECUTION.md)。

manifest 用一次固定 Git 查询取得 canonical root、Git dir 和 common dir，并把这三个值传给 dispatcher。dispatcher 先判断该证明能否覆盖 payload `cwd`：能覆盖就走内联 policy，不能覆盖或字段缺失就直接走受监督 worker。两条路径只会选一条。policy 一旦返回 allow 或 deny，dispatcher 不会按拒绝理由重试。worker 继续使用固定 `/usr/bin/git` 和清理后的环境独立解析 payload `cwd`，证明不一致不会变成放行。

manifest 另有固定 4 秒 watchdog，覆盖 Git、`realpath`、Node launcher、dispatcher 启动和内联 policy。超时后先向独立 launcher 进程组发送 TERM，0.2 秒后再发送 KILL；watcher 以状态 `124` 通知父 shell。即使 launcher 捕获 TERM 后返回成功，父 shell 也会 deny。Node 缺失、启动失败或启动链卡住时，这条路径会在 Codex 的 5 秒 host timeout 前结束。stdin 上限为 8 MiB，单条 shell command 上限为 256 KiB。

以下情况返回稳定 deny：

- runtime 文件缺失或 digest 不匹配；
- stdin 超限、JSON 无效或 payload 字段不完整；
- Git checkout 类型、canonical root 或 patch 目标无法确定；
- 写入类调用无法安全读取已有的分支配置数据库；
- policy 抛错或没有给出明确判定。

Codex 在 5 秒后终止 Hook 进程。本机 `codex-cli 0.146.0` 的独立探针已经证明：如果整个 Hook 命令直接触发 host timeout，工具仍可能执行。因此 5 秒只能当最后的进程回收上界，不能当 deny 机制。发布验收必须证明 4 秒内部 watchdog 先返回有效 deny，且工具没有执行。

## 已知边界

Hook 只能审核宿主提交的工具调用，不解析每个测试脚本或 Git filter 的实现。此前的可变脚本和 clean/process filter 越界已由受限 runner 处理：验证继承文件与网络限制，Git 查询的 helper 继承只读限制。`--no-ext-diff --no-textconv` 本身仍不会关闭 clean/process filter，真实回归验证了这个 helper 在新 profile 下不能写 `.tmb`。路径和可执行文件检查与执行之间仍有同用户 TOCTOU 窗口；仓库外宿主工具链属于信任边界。进程组清理不能保证终止自行脱离的全部后代，但不会解除后代继承的 sandbox。

Hook payload 没有可信的 Human 批准字段或 Agent 角色字段。与 Claude Code 一样，TMB 把主对话里的直接执行要求当作持续指令，Hook 只检查可观察的仓库状态。它无法证明某句自然语言来自 Human，也无法硬区分主任务和 standalone Agent。后者仍靠 Rule 6 persona 指令禁止 Git 和远程交付。这条交付通道是工作流门禁，不是身份认证系统。

既有 `functions.exec` 路径的放行不依赖宿主再次触发 Hook。policy 只接受一个直接的 `tools.<name>(<JSON>)` 调用，拒绝动态属性、变量别名、额外语句和嵌套生命周期调用。所有嵌套 `exec_command` 都必须通过完整启动参数检查，Git、forge 和验证命令还要通过固定 runner wrapper 与内部命令审核。这条路径的宿主执行语义需要单独验收。

配套 CLI 补丁通过另一条合同提供顶层 `execution_context`，插件据此核对实际 shell argv 和 cwd，不把静态请求参数当成启动结果。缺失、伪造或不符合上述精确条件的 context 不能放行任何 Bash 命令。宿主补丁仍使用原执行管理器、sandbox 和审批流程；它尚未发布，当前不能把候选实现写成官方 CLI 的既有能力。宿主改变 payload 或执行语义后，必须重新验收。

TMB MCP 只接受三个精确前缀：当前宿主实测到的 `mcp__trajectory_server__*`，以及安装模式可能生成的 `mcp__plugin_tmb_trajectory-server__*` 和下划线变体。调用中的 canonical `project_root` 必须等于当前 branch-backed checkout。由于 Hook payload 没有 provider 身份字段，未限定的 `trajectory_server` 名称可能被项目 MCP 影射；策略因此在当前 cwd 到仓库根的任一层发现 `.codex/config.toml` 时拒绝全部 TMB MCP 调用。用户级或企业级宿主配置仍属于受信任边界。宿主改变 MCP 合成方式后必须重新验收。

Hook definition 的任何改动都会使原有信任失效。更新带有 load-bearing policy 时，必须使用新的不可变插件版本，并在发布说明中要求用户重新信任。未完成信任前，不能说 TMB enforcement 已启用。

Codex 的缓存路径含 marketplace、插件名和版本。不得把修改后的 Hook 继续标成已经安装或发布过的版本；本次评论修复把本地未发布候选升到 `1.0.6-rc.1`，已安装的 `1.0.4` 或 `1.0.5` 缓存都不能作为当前实现。候选形成后再执行用户安装验收；当前没有替用户刷新安装或 trust 状态。本地刷新必须按下面的顺序进行：

1. 在 `/hooks` 中禁用当前 TMB Hook，停止自动重试，并记录 Hook definition hash、源文件 hash 和缓存文件 hash。
2. 卸载精确的 TMB plugin ID，确认旧的 installed path 已不存在。仅再次执行 `plugin add` 不算刷新证据。
3. 重新安装后，逐字节比较 `.codex-plugin/plugin.json`、`hooks/codex/hooks.json` 和 `RUNTIME_RELATIVE_PATHS` 声明的全部七个 ESM 文件。
4. 通过 `/hooks` 审阅新 definition；只信任当前显示的 hash，然后启用新 Hook。
5. 新开会话，先验证诊断入口，再验证一个安全读取和一个无副作用的拒绝样本。旧会话不能作为重新加载证据。

任一步失败都保持 Hook 禁用。`/hooks`、只读任务诊断和精确 TMB 卸载不依赖分支配置数据库。分支策略有效时，还可显式取消暂存，或从受保护分支创建受控 feature branch；已有数据库无法安全读取时，这两项 Git 恢复操作也会拒绝。policy 不允许卸载其他插件，也不允许借恢复流程执行危险 Git/forge 写入。

当前实现不修改 `~/.codex/hooks.json`。如果插件 Hook 被禁用、未信任或卸载，Scope 5 不生效；Scope 4 的 Skills、MCP 和 Agent materializer 仍按各自边界工作。

## 验收与回滚

自动门禁包括：

- L1：manifest shape、七个 runtime 文件的边界、无 npm 依赖，以及包含规范化 launcher 的 digest；
- L2：policy、dispatcher、oversize、malformed input、单次路由、恢复入口、feature-branch 交付，以及配置分支、数据库路径、schema、WAL 和文件完整性测试；
- L3：sentinel、Git tree、bounded lifecycle、静态编排审计、Node launcher、watchdog 进程组清理、patch containment 和交付状态测试；
- Codex installer 验收：由 `tests/l0-install/codex-plugin-surface-smoke.sh` 检查故意污染的旧缓存清除、installed-cache 字节一致性和缓存内 dispatcher。`tests/run-all.sh` 在找到 Codex CLI 时使用隔离 profile 自动执行；没有 CLI 时明确 SKIP，显式设置的 `CODEX_BIN` 无效时 FAIL。这不替代真实用户的 trust 或全新宿主会话矩阵；
- MCP installed-cache：无源码 `node_modules` 的冷启动和 Hook 调用；
- 全量 Claude L1-L4 回归。

发布候选必须是干净提交。提交前的 dirty-worktree 结果只能作为实现验证，不能当发布证据。形成候选 SHA 后，独立 CLI 和 Desktop 内置 CLI 必须在同一提交上重跑允许与拒绝矩阵、bypass、disabled Hook、卸载和回滚；Desktop UI 另行验收交互 trust。任一受保护分支或越界写入产生副作用，或者 Desktop 无法从 installed-cache 加载同一 Hook，均停止发布。

回滚先在 `/hooks` 禁用当前 TMB Hook，再卸载当前插件；如需恢复旧版本，只能安装使用不同版本路径且仍受信任的构建。随后开新 task，复查两个 TMB Agent 文件和 `.tmb/` 状态。插件卸载不会替用户删除项目文件。
