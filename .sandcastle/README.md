<a id="sandcastle-local-dispatcher"></a>
# Sandcastle 本地 Dispatcher

该目录存放本仓库的生产自动化代码，包括一个精简的本地 WSL Dispatcher 及一组固定操作。旧的 claim/watch/repair 流程已经移除。GitHub Issue、Pull Request、分支、标签和评论是唯一的持久业务状态。`CONTEXT.md` 定义了 Automation Command、Automation Work Item、Blocked Automation、Dispatcher、Target Checkout 和 Legacy Run State 等规范术语。

贡献者指南位于 `docs/operations/sandcastle-automation-guide.md`，内容包括标签选择、Issue/PRD/Pull Request 工作流、进度查看和阻塞任务重试。

运维手册位于 `docs/operations/sandcastle-local-dispatcher-runbook.md`，内容包括部署、受保护配置、检查、canary 顺序和单写入者切换保护。

<a id="production-entry"></a>
## 生产入口

所有命令都必须通过本地受信任的 `master` checkout 运行：

```bash
npm run sandcastle -- setup-labels
npm run sandcastle -- inspect
npm run sandcastle -- dispatch [--concurrency <1-8>]
npm run sandcastle -- run implement <issue-number>
npm run sandcastle -- run implement-prd <issue-number>
npm run sandcastle -- run split <issue-number>
npm run sandcastle -- run review <pr-number>
npm run sandcastle -- run feedback <pr-number>
npm run sandcastle -- run update-branch <pr-number>
npm run sandcastle -- architecture-review
```

<a id="private-configuration"></a>
## 私有配置

私有环境变量文件位于仓库外的 `~/.config/sandcastle/env`，权限必须是 `0600`：

```bash
install -m 600 /dev/null ~/.config/sandcastle/env
$EDITOR ~/.config/sandcastle/env
```

`.env.example` 列出了允许使用的配置项。启动适配器只会从 `~/.claude/settings.json` 读取路由、认证、模型映射和代理环境变量。私有文件中非空的白名单配置会覆盖这些设置。

代理配置可以使用同名精确引用，例如 `HTTPS_PROXY=${HTTPS_PROXY}`。Sandcastle 每次启动时只解析一次该引用，值来自启动 Node.js 进程的环境。宿主机环境变量的名称和大小写必须完全一致，并且值不能是空字符串或纯空白。

展开只有一层。解析得到的宿主机值会逐字节传入，其中包含的 `${...}` 或 `$NAME` 只会作为普通文本，不会再次展开。只接受整个值为带花括号的同名引用。以下写法都会在启动时遭到拒绝：

- 不带花括号的 `$HTTPS_PROXY`；
- 跨配置项或任意引用，例如 `${HTTP_PROXY}`、`${OTHER}`；
- 拼接值；
- shell 默认值表达式，例如 `${HTTPS_PROXY:-http://fictional-fallback.example}`；
- 嵌套引用或其他类似引用的写法。

配置错误只会指出受影响的配置项、生效来源和不敏感的失败原因。如果字面值中必须包含 `${`，请使用 URL 百分号编码，例如 `%24%7B...%7D`，不要使用 shell 转义，因为 Sandcastle 没有转义语法。大写和小写代理配置项彼此独立。解析后的值不会经过裁剪，也不会再次展开。

以下任一情况都会使启动在创建 Agent Session 之前失败：文件不存在、权限不是 `0600`、缺少必要的路由或认证配置、代理引用无效。启动日志只记录数量，不记录路由、模型名、代理地址或密钥。

默认模型使用 Claude Code 的 `opus` 别名。`SANDCASTLE_MODEL` 修改本地默认模型；`SANDCASTLE_PLANNER_MODEL`、`SANDCASTLE_IMPLEMENTER_MODEL` 和 `SANDCASTLE_REVIEWER_MODEL` 可分别覆盖对应角色的模型。provider 专用模型 ID 只能写在私有文件或本地 Claude Code 设置中。

Sandcastle 不会把私有环境变量文件或完整的 Claude Code、CC-Switch、OAuth、GitHub CLI 配置挂载进容器。sandbox provider 只接收适配器过滤后的环境变量。

<a id="agent-runtime"></a>
## Agent 运行时

`sandbox.ts` 是 Sandcastle Agent Session 共用的运行时和私有配置入口。编排入口必须调用 `loadSandboxStartup()`，并一起使用它返回的 sandbox、角色模型和按角色选择的 `sandboxHooksFor()`。未经校验的 Docker provider 构造函数不对外导出。

provider 使用 Docker host 网络，以便容器访问 WSL loopback 上的 CC-Switch。系统从仓库上下文构建一个固定的运行时镜像。镜像会预置 npm 缓存，缓存身份绑定 Dockerfile、lockfile、workspace manifest、Node 版本和 npm 版本，但不会保留 `node_modules`。

Implementer 启动时会验证该身份并运行 `npm ci --offline`。Planner 有意不设置依赖安装 hook。不要把 `node_modules` 加入 `copyToWorktree`。代理变量必须经过显式白名单；所有 Docker build context 都会排除凭据文件。

使用以下命令构建并验证镜像：

```bash
npm run test:sandbox
```

smoke test 会创建一个 detached Git worktree，只挂载该 worktree，并在 Node.js 24 中依次运行 `npm ci`、build、typecheck 和完整测试套件。它不会加载凭据，也不会启动 Agent Session。
