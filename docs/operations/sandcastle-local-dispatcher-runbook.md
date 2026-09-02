<a id="sandcastle-local-dispatcher-runbook"></a>
# Sandcastle 本地 Dispatcher 运维手册

本手册供运维人员部署、检查并对本地 WSL Dispatcher 进行 canary 验证。该 Dispatcher 取代了已停用的 Sandcastle claim/watch 流程。Automation Command、Automation Work Item、Blocked Automation、Dispatcher、Target Checkout 和 Legacy Run State 等规范术语在 `CONTEXT.md` 中定义。

Dispatcher 直接通过 Node 24 type stripping 从受信任的本地 `master` checkout 运行。系统没有 TypeScript build、安装器、release 目录、符号链接或回滚机制。Agent worker 使用下文准备的独立本地内容寻址 Docker 镜像。

<a id="protected-configuration"></a>
## 受保护配置

私有环境变量文件位于仓库外：

```text
~/.config/sandcastle/env
```

它必须是权限为 `0600` 的普通文件：

```bash
install -m 600 /dev/null ~/.config/sandcastle/env   # 也可以使用 touch + chmod 600
$EDITOR ~/.config/sandcastle/env
```

以下任一情况都会使启动 fail closed：文件不存在、不是普通文件、权限不是 `0600`，或者缺少 provider 配置，也就是 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 两者之一。`GH_TOKEN` 有意不作为启动前置条件。缺少该 token 时，只读 Agent 容器 readiness 会直接分类为 `"missing"`，不会启动探测容器。系统只读取以下白名单配置项：

- `GH_TOKEN`：只有只读 `inspect` 可以不配置它。任何能使用 GitHub 的操作在获取 Work Item 前都必须通过 Agent 容器 readiness preflight，因此这些操作必须配置 `GH_TOKEN`。请使用仅限本仓库的 fine-grained PAT，授予 Metadata read，以及 Contents、Issues、Pull requests、Commit statuses read/write。不要把 token 写入远程 URL、Git 配置、命令行参数或 unit 文件。
- `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`：用于 CC-Switch 路由、认证和模型映射。
- `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及对应的小写配置项：用于 WSL 网络传输。
- `SANDCASTLE_MODEL`、`SANDCASTLE_PLANNER_MODEL`、`SANDCASTLE_IMPLEMENTER_MODEL`、`SANDCASTLE_REVIEWER_MODEL`：用于选择角色模型，默认值为 `opus`。

优先级从低到高依次是：仓库中的非敏感默认值、`~/.claude/settings.json` 中 `env` 里的白名单值、私有环境变量文件、非敏感 CLI 选项。启动诊断只报告数量，不会报告路由、模型名、代理地址或密钥值。

<a id="docker-image-readiness"></a>
## Docker 镜像 readiness

受保护配置通过校验后，构建 Dispatcher 启动时选中的精确内容寻址镜像：

```bash
npm run sandcastle -- build-image
```

该命令可重复执行，使用与 Agent 运行时启动相同的仓库输入、宿主机 UID/GID 和受保护代理配置。它不会输出所选镜像名、代理值、凭据或原始 Docker 输出。拉取涉及 Dockerfile、依赖 manifest 或 lockfile 的变更后，请重新运行。任一镜像输入变化都会产生新的镜像选择。

使用只读检查命令验证 readiness：

```bash
npm run sandcastle -- inspect
# JSON 输出必须包含："imageReadiness":"ready"
```

结果为 `"missing"` 时，任何 Automation Command 都不能运行。在 `build-image` 成功前，显式执行、定时 dispatch 和架构 review 都会在获取命令前失败。此类失败不会消费触发标签，不会添加 `agent:in-progress`，也不会创建 Blocked Automation。在检查结果变为 `ready` 前，不要创建 canary、给 canary 添加标签或启用任一 timer。

`"ready"` 只说明当前受信任 checkout 选中的镜像存在且可用，不能证明较早获取的 Pull Request revision 具有相同的 manifest seed。基于当前 base 的 Issue 和 PRD 实现继续使用严格的镜像输入 checksum 和离线安装。针对已获取精确 revision 的 feedback 则使用运行时保护和冻结安装，优先使用镜像缓存，并允许有界的网络 fallback。

<a id="agent-container-github-readiness"></a>
## Agent 容器的 GitHub readiness

具备 GitHub 能力的 Agent Session 只使用容器环境中的 `GH_TOKEN` 认证，见 #267。每轮定时 dispatch 获取任何 Automation Work Item 前，以及每个显式 GitHub 操作，也就是 `run review`、`run implement`、`run implement-prd`、`run split` 和 `run feedback`，Dispatcher 都会在精确内容寻址的 Agent 镜像中运行只读 `gh auth status` 探测。探测使用与 GitHub Agent 完全相同的环境，包括网络传输配置、Claude/API 白名单、`GH_TOKEN`，以及下文说明的 Git 身份变量。

探测不会修改 GitHub。不得把 token 值或 readiness 命令的原始输出复制到日志、保留产物、GitHub 诊断或错误消息中。只能报告分类结果 `ready`、`missing`、`invalid` 或 `unavailable`。结果不是 `ready` 时，`inspect` 不会查询远程命令 frontier。此时 `commandInspection` 字段必须明确为 `"unavailable"`，不能返回空的 `commands` 列表。

具备 GitHub 能力的 Agent 环境还会携带运维人员的 Git 身份。`GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、`GIT_COMMITTER_NAME` 和 `GIT_COMMITTER_EMAIL` 从受信任 checkout 的 Git 配置读取。容器中的 Agent 代表运维人员提交，而容器 `HOME` 没有 `.gitconfig`，见 #269。如果受信任 checkout 没有 `user.name` 或 `user.email`，启动会 fail closed。这些身份值不属于敏感信息，但仍不得复制到 GitHub 诊断中。

失败分类如下：

- `missing`：私有环境变量文件中没有 `GH_TOKEN`。添加后重新运行操作，或等待下一轮 dispatch。
- `invalid`：配置的 `GH_TOKEN` 无法通过认证。请在私有环境变量文件中更新它。
- `unavailable`：探测本身无法运行，例如镜像不存在、镜像中没有 `gh`、容器网络失败或 Docker 不可用。请通过 `inspect` 和 dispatch 轮次日志诊断。

结果为 `missing` 或 `invalid` 时，该轮 dispatch 或显式操作会在获取 Work Item 前 fail closed。系统不会移除触发标签，不会添加 `agent:in-progress` 或 `agent:blocked`，也不会写入诊断评论。Automation Work Item 保持不变。凭据恢复后，下一轮 dispatch 或重试会再次获取它。

使用只读检查命令验证 readiness。输出会同时报告探测结果和镜像 readiness：

```bash
npm run sandcastle -- inspect
# JSON 输出必须同时包含："imageReadiness":"ready" 和 "githubAgentReadiness":"ready"
```

不依赖 GitHub Agent 的操作，也就是 `run update-branch`、`architecture-review`、`setup-labels` 和 `inspect`，不会运行该探测，也不会获得具备 GitHub 能力的环境。

<a id="label-setup"></a>
## 初始化标签

标签是唯一的命令入口。执行一次以下命令完成初始化；重复执行不会产生额外影响：

```bash
npm run sandcastle -- setup-labels
```

该命令创建由 Dispatcher 管理的标签：`agent:implement`、`agent:review`、`agent:update-branch`、`agent:queued`、`agent:in-progress`、`agent:blocked`。它不会编辑 Automation Work Item。缺少任一标签时，普通 dispatch 会 fail closed。

`setup-labels` 不创建以下两个标签：

- `agent:to-issues`，PRD 拆分触发标签。如果不存在，请创建一次：`gh label create agent:to-issues --color 0E8A16`。
- `source:architecture-review`，由架构 review 发布流程自行创建，可重复执行。

旧的 `Sandcastle` / `sandcastle:*` 标签不会触发替代系统，也不会自动转换。不要给保留的历史 Work Item 添加触发标签。

<a id="deploying-the-systemd-units"></a>
## 部署 systemd unit

模板位于 `.sandcastle/systemd/`：

```text
sandcastle-dispatch.service              一轮有界 dispatch
sandcastle-dispatch.timer                每分钟第 15 秒运行
sandcastle-architecture-review.service   一次架构 review
sandcastle-architecture-review.timer     周一至周五 09:00 UTC，上游计划时间
```

系统没有安装器，必须在本机显式部署：

```bash
cp .sandcastle/systemd/sandcastle-* ~/.config/systemd/user/
```

然后根据本机环境编辑副本：

1. `WorkingDirectory=` 指向受信任的本地仓库 checkout。它必须是干净的 `master`。
2. `ExecStart=` 指向本机的 Node 24 二进制文件。
3. `Environment=PATH=` 必须能够解析 `claude`、`gh`、`git`、`docker`、`node` 和 `npm`。

重新加载并离线验证。以下命令不会启动任何服务：

```bash
systemctl --user daemon-reload
systemd-analyze verify --user ~/.config/systemd/user/sandcastle-*.service ~/.config/systemd/user/sandcastle-*.timer
systemctl --user list-timers   # 确认两个 timer 都尚未启用
```

合并或复制模板都不会启动写入路径。service 没有 `[Install]` 小节，只有显式执行 `systemctl --user enable` 才会启用 timer。在满足下文的切换保护条件前，不要启用任何 timer。

运行行为说明：

- 如果一轮 dispatch 发现 scheduler lock 已被占用，它会以 `status: "locked"` 退出，不执行任务。重叠轮次不会并发运行。
- `.sandcastle/dispatcher.lock` 记录持有者的进程 ID。如果 lock 所属进程已经退出，例如宿主机崩溃后，下一轮会自动回收。仍需人工处理的一种情况是，进程在创建 lock 文件后、写入 PID 前遭到强制终止，导致文件中没有可读取的持有者 PID。系统不会自动回收这种 lock。先通过 `journalctl --user -u sandcastle-dispatch.service` 和 `inspect` 确认没有 Dispatcher 正在运行，再手动删除 `.sandcastle/dispatcher.lock`。
- architecture-review timer 使用 `Persistent=false`，错过的执行不会补跑。等待下一次计划时间或手动运行即可。
- Dispatcher 自行限制任务运行时间，依次使用进程组 SIGTERM、grace period 和 SIGKILL，因此 unit 禁用了 oneshot 启动超时。

<a id="read-only-inspection"></a>
## 只读检查

```bash
npm run sandcastle -- inspect
```

该命令输出 Docker 镜像 readiness、Agent 容器 GitHub readiness 和本地活动任务。`githubAgentReadiness` 为 `ready` 时，还会返回 `commandInspection:"available"`、当前远程命令 frontier、每条命令的 eligibility，也就是 `eligible`、`blocked`、`stale-in-progress` 或 `inconsistent`，以及重试说明。

readiness 为 `missing`、`invalid` 或 `unavailable` 时，命令返回 `commandInspection:"unavailable"` 并省略 `commands`。这表示没有查询远程队列，不表示队列为空。该命令不会修改 GitHub 或本地状态。

一个 Work Item 同时带有触发标签和 `agent:in-progress`，说明标签只完成了部分修改。系统将它报告为 `inconsistent`，不会执行。在检查结果同时满足 `"imageReadiness":"ready"` 和 `"githubAgentReadiness":"ready"` 前，不得获取任何具备 GitHub 能力的命令，也不得运行或重试 canary。

<a id="explicit-operation-execution"></a>
## 显式执行操作

每个操作都使用与定时 dispatch 相同的 preflight 和标签生命周期，不能凭空创建隐式 Automation Command：

```bash
npm run sandcastle -- run implement <issue-number>        # Issue -> 分支 + Draft Pull Request
npm run sandcastle -- run implement-prd <issue-number>    # 实现一个符合条件的 PRD 子 Issue，然后继续推进
npm run sandcastle -- run split <issue-number>            # PRD -> 可独立理解的子 Issue
npm run sandcastle -- run review <pr-number>              # review Pull Request
npm run sandcastle -- run feedback <pr-number>            # 实现 Pull Request feedback
npm run sandcastle -- run update-branch <pr-number>       # rebase 或更新 Pull Request 分支
npm run sandcastle -- architecture-review                 # 手动执行架构 review
npm run sandcastle -- dispatch [--concurrency <1-8>]      # 执行一轮有界 dispatch，默认 2；环境变量：SANDCASTLE_DISPATCH_CONCURRENCY
```

具备 GitHub 能力的操作，也就是 `run review`、`run implement`、`run implement-prd`、`run split` 和 `run feedback`，会在 preflight 中运行 Agent 容器 GitHub readiness 探测。探测发生在任何标签或诊断修改之前。`run update-branch` 和 `architecture-review` 不运行该探测。

PRD 实现会在完整的子 Issue 操作期间持有强制的跨进程 issue lease。Implementer 使用与 upstream 兼容的普通 push，把结果推送到持续累积的 `sandcastle/prd-<n>` 分支，不会 force-push。受控 publisher 仍只用于 feedback 实现，其中显式 `--force-with-lease` 用于保护现有 Pull Request 分支。如果让普通 PRD 发布也使用该 publisher，只会增加分支和 PR 恢复状态，不能改善 lease 保证，因此这里有意不这样做。

<a id="blocked-automation-diagnosis"></a>
## 诊断 Blocked Automation

执行、超时、push 或发布失败时，系统会给 Work Item 添加 `agent:blocked`，并附上简短的分类原因和不敏感的本地任务标识。Work Item 不会进入终止状态。请按以下顺序诊断：

1. 运行 `npm run sandcastle -- inspect`。如果 `commandInspection` 为 `"available"`，确认命令状态为 `blocked` 并阅读重试说明。如果为 `"unavailable"`，先恢复 GitHub readiness。这不表示没有命令。还要检查两个 readiness 字段。只要 `githubAgentReadiness` 或 `imageReadiness` 不是 `ready`，任何具备 GitHub 能力的命令随后重试时都会在获取前 fail closed，无论上次检查到的 frontier 是什么。
2. 阅读 Issue 或 Pull Request 上经过分类的失败评论。
3. 在本地读取 dispatch 轮次日志：`journalctl --user -u sandcastle-dispatch.service`。架构 review 使用 `-t sandcastle-architecture-review`。完整 Agent 输出只存在于本地日志，不会写入 GitHub 评论。
4. 检查 `.sandcastle/jobs/` 下保留的任务产物。失败或超时的 Target Checkout、metadata 和日志会保留七天。

Agent 容器 GitHub readiness 失败不属于 Blocked Automation。它会让该轮 dispatch 或显式操作在获取 Work Item 前 fail closed，因此不会添加 `agent:blocked`，也不会写入诊断评论。如果具备 GitHub 能力的操作失败，但既没有分类评论也没有标签变化，应先怀疑 readiness。检查 `inspect` 和 dispatch 轮次日志，并严格按上文 Agent 容器 GitHub readiness 小节中的分类处理。不得把 token 值或 readiness 命令的原始输出复制到 GitHub 诊断、保留产物或错误消息中。

<a id="manual-retry"></a>
## 手动重试

系统不会自动重试整个任务。重试必须由运维人员明确执行：

1. 按上文诊断 Blocked Automation。
2. 移除 `agent:blocked`：`gh issue edit <n> --remove-label agent:blocked`。Pull Request 使用 `gh pr edit`。
3. 重新添加对应的触发标签，例如 `agent:implement`、`agent:review`、`agent:update-branch` 或 `agent:to-issues`。
4. 验证 readiness。重试前，`npm run sandcastle -- inspect` 必须报告 `"imageReadiness":"ready"`。对于具备 GitHub 能力的命令，还必须报告 `"githubAgentReadiness":"ready"`。

下一轮 dispatch 或显式 `run` 命令会获取该命令。Review 重试必须复用现有 Work Item。不要创建替代 Issue、分支或 Pull Request。

readiness 失败会保留 Work Item 和触发标签，也没有需要移除的 `agent:blocked`。在本地恢复凭据或镜像，通过 `inspect` 重新验证，然后重新运行操作或等待下一轮 dispatch。不要修改标签。

每次具备 GitHub 能力的重试都必须创建或复用现有的 `sandcastle/issue-<n>` 分支，并且只能产生一个 Draft Pull Request。如果重试将创建第二个 Draft Pull Request 或替代 Work Item，应判定为失败，不能把它当作规避方案。Canary 只能重试一次。记录并验证下文要求的证据后，才能开始后续 canary。

`inspect` 会报告过期的 `agent:in-progress`，例如宿主机崩溃后残留的标签，但系统不会自动接管、恢复或清除它。只有通过 `inspect` 和 `journalctl` 确认没有匹配的活动任务后，才能手动移除。

<a id="job-retention"></a>
## 任务保留策略

成功和失败任务的产物统一保留七天。这样可以诊断近期失败，同时避免形成永久运行状态。

- 成功：自动删除 Target Checkout，保留小型任务 metadata 和日志。
- 失败或超时：在本地保留 Target Checkout、输出和日志，供诊断使用。
- `.sandcastle/jobs/review-artifacts/` 下的 review 产物会在七天后自动过期，每次命令启动时执行清理。`.sandcastle/jobs/` 下失败或超时的 Target Checkout 及其他保留任务目录也采用相同的七天清理策略。只有结构状态 `review-artifacts/`、`pull-request-leases/` 和 `implementation-leases/` 不参与该目录清理。诊断完成后，运维人员可以提前删除保留目录。
- dispatch 轮次日志写入 systemd journal，保留时间由 journald 配置决定。

<a id="safe-cleanup-boundaries"></a>
## 安全清理边界

切换时只能删除以下未跟踪的本地恢复路径，不能删除其他路径：

```text
/home/canxer/repos/obsidian-llm-wiki-cli/.sandcastle/recovered/
```

不要批量删除 `.sandcastle/worktrees/`、`.sandcastle/logs/`、`.git/worktrees/` 或 `.claude/worktrees/`。替代系统会忽略这些目录，而且可能存在带未提交修改的 #166 worktree，不能触碰。不要删除或重写远程 `sandcastle/*`、`archive/*` 分支、历史 Issue、历史 Pull Request 或历史 commit。

<a id="canary-sequence"></a>
## Canary 顺序

每类操作都必须使用新建的专用 canary Work Item。历史失败不能作为测试输入。#216 / PR #217、#166、Legacy Run State 和 archive 分支禁止用于 canary。不要给它们添加标签，不要编辑、关闭或引用它们。

运行 canary 时必须禁用 timer，而且 `inspect` 必须同时报告 `"imageReadiness":"ready"` 和 `"githubAgentReadiness":"ready"`。严格按以下顺序执行。readiness 失败时，canary 会在获取 Work Item 前 fail closed，不会修改标签。按 Agent 容器 GitHub readiness 小节恢复后，重试同一个 canary。不要创建或标记替代 canary。

1. **Issue 实现。** 创建一个小型专用 Issue，添加 `agent:implement`，然后运行 `npm run sandcastle -- run implement <n>`。确认系统创建了 `sandcastle/issue-<n>` 分支和 Draft Pull Request。
2. **Pull Request review。** 给该 Draft Pull Request 添加 `agent:review`，然后运行 `npm run sandcastle -- run review <pr>`。确认发布的 review 标明了被审查的精确 commit。
3. **Feedback 实现。** 在 Pull Request 上留下 change request，添加 `agent:implement`，然后运行 `npm run sandcastle -- run feedback <pr>`。确认修复 push 到现有分支，并且实现回复包含 `feedback-reconcile` provenance marker。
4. **分支更新。** 添加 `agent:update-branch`，然后运行 `npm run sandcastle -- run update-branch <pr>`。确认分支已从 `master` 更新，并使用显式 force-with-lease push。
5. **PRD 拆分。** 创建专用 PRD Issue，添加 `agent:to-issues`，然后运行 `npm run sandcastle -- run split <n>`。确认创建了可独立理解的子 Issue。
6. **PRD 继续执行和最终 review。** 给 PRD 添加 `agent:implement`，然后运行 `npm run sandcastle -- run implement-prd <n>`。确认只实现了一个符合条件的子 Issue，并自动请求下一个。最后一个子 Issue 完成后，确认系统自动请求 Pull Request review。
7. **队列提升。** 创建一个被另一个专用 Issue 阻塞的专用 Issue，添加 `agent:queued`，关闭 blocker，然后运行 `npm run sandcastle -- dispatch`。确认系统根据当前 blocker 状态把标签从 `agent:queued` 改为 `agent:implement`。
8. **手动架构 review。** 运行 `npm run sandcastle -- architecture-review`。确认系统创建了带 `source:architecture-review` 标签的提案 Issue；如果 backlog guard 或宽松的重复项过滤器生效，则确认日志记录了跳过。

开始下一个 canary 前，记录当前 canary 的证据，包括经过分类的镜像和 Agent 容器 GitHub readiness、分支身份、Draft Pull Request 的身份和数量，以及两个 timer 都未启用的确认结果。Canary 必须按顺序推进。前一个 canary 的证据尚未记录并验证时，不得开始后一个。Issue 实现 canary 必须证明只产生了一个 Draft Pull Request。全部完成后，只关闭或清理这些专用 canary Work Item。

成功的 review 会把对应 Pull Request 标记为 Ready for Review。此后 feedback 实现和分支更新必须继续使用同一个仍处于 open、属于同一仓库的 Pull Request。不要把它改回 Draft，也不要创建替代分支或 Pull Request。Draft 要求只适用于 Issue 实现和 review 的前置条件，不适用于之后的修改命令。

<a id="single-writer-cutover-guard"></a>
## 单写入者切换保护

旧写入路径和新写入路径绝不能同时处于活动状态。启用任何替代 timer 前，依次完成：

1. 停止旧的 Sandcastle watch 进程，确认没有旧任务仍在运行，也就是没有 watch 进程和运行中的 Docker 任务容器。
2. 丢弃 Legacy Run State。不要接管、恢复或 reconcile 它。清理范围只能是上文明确列出的恢复路径。
3. 准备权限为 `0600` 的受保护私有环境变量文件，运行 `npm run sandcastle -- build-image`，再运行 `npm run sandcastle -- inspect`。结果必须同时为 `"imageReadiness":"ready"` 和 `"githubAgentReadiness":"ready"`。
4. 运行 `setup-labels`，再次运行 `inspect`。确认命令 frontier 干净，而且镜像和 Agent 容器 GitHub readiness 仍为 `ready`。
5. 在 timer 禁用的状态下按顺序运行上述 canary。如果仓库镜像输入在任何时点发生变化，必须重新构建并重新验证后再继续。
6. 只有 canary 1 至 7 全部通过，而且镜像和 Agent 容器 GitHub readiness 仍为 `ready` 后，才能运行 `systemctl --user enable --now sandcastle-dispatch.timer`。
7. 只有 canary 8 通过且镜像 readiness 仍为 `ready` 后，才能运行 `systemctl --user enable --now sandcastle-architecture-review.timer`。

GitHub Actions 不能作为 fallback consumer。两个 consumer 会重新引入重复执行。如果必须暂停替代系统，运行 `systemctl --user stop sandcastle-dispatch.timer sandcastle-architecture-review.timer`，不要重新启动旧 writer。

使用以下命令确认启用状态：

```bash
systemctl --user list-timers
journalctl --user -u sandcastle-dispatch.service -f
```

<a id="feedback-publication-convergence-and-reconciliation"></a>
## Feedback 发布收敛与 reconciliation

Feedback 实现是分支 push 和规范实现回复的唯一发布者，见 #293。Agent 执行前，系统会读取完整且有界的 review thread 和评论视图，并选择唯一一个未解决的 root 作为不可变 feedback intent。push 和回复前都会重新检查该选择。

以下任一情况都会 fail closed：视图被截断、数据结构无效、存在多个 root、回复不符合规范，或者同一 thread 的后续回复无法表示。Agent 接收精确的 root，并且必须原样返回。

编排器发布回复时会带有有界、机器可读的 marker：

```text
<!-- feedback-reconcile op=feedback pr=<n> pre=<PRE> post=<POST> root=<root> -->
```

marker 中编码的 root 必须等于回复所链接的 root。写入明确成功或结果不确定后，编排器都会根据完整的回复证据执行有界、只读的 marker 收敛检查，其中包括已经 resolved 的 thread。完全不可见和明确的临时读取错误可以重试。证据重复、结构错误、确定性失败或重试耗尽时，系统返回 `feedback-reply`，不会进行第二次写入。

push 后，编排器会在保守的边界内轮询 Pull Request head。默认最多读取五次，每次按尝试次数增加两秒 backoff，总计约 20 秒；测试可以注入其他设置。暂时仍看到已获取的 revision 只表示传播尚未完成。明确的临时读取错误可以重试。如果出现不同的第三方 SHA，操作会 fail closed，不会进行第二次 push。

`blocked` 结果会按阶段分类为 `feedback-execution`、`feedback-publication`、`feedback-convergence`、`feedback-head-conflict`、`feedback-reply`、`feedback-reconciliation` 或 `feedback-finalization`。如果已经完成发布，结果还会携带已发布 revision。公开诊断始终只包含分类信息，不包含执行摘要、路径、凭据或 stack trace。

后续的 `run feedback` 或 Dispatcher dispatch 不能接管已发布状态。如果发现与当前 intent 匹配的证据，系统会在启动 Agent、checkout、push 或回复前返回 `feedback-reconciliation` 分类结果。

诊断确认没有匹配的活动任务后，先执行普通手动重试流程：移除 `agent:blocked`，恢复 `agent:implement`。只有这之后，显式 `reconcile feedback` 命令才能提供额外授权，以接管经过唯一证明的当前 intent 证据。无参数调用也适用。该命令仍会通过 `agent:in-progress` 获取可见命令、消费触发标签并执行普通的 `finally` 清理。

属于其他 root 的历史 marker 既不能满足当前 intent，也不会污染当前 intent。如果提供已获取的 revision，一个严格唯一的旧式回复仍只能通过 reconcile 接管。只补全回复时，提供的 reply root 还必须等于所选 intent。接管完成后，结果会报告独立验证过的 revision 并 reconcile 托管标签。清理失败会体现在类型化结果中，不会被静默忽略。

<a id="automated-verification"></a>
## 自动验证

`test/systemd-units.test.ts` 使用离线 `systemd-analyze verify --user` 验证 unit 语法、calendar 表达式，以及命令是否通过真实 CLI parser 正确接线。测试不会启用、启动或安装任何内容：

```bash
npx vitest run test/systemd-units.test.ts
```
