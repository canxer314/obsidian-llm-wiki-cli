<a id="using-sandcastle-automation"></a>
# 使用 Sandcastle 自动化

Sandcastle 把 GitHub Issue 和 Pull Request 上的显式标签转换为本地自动化任务。本指南面向提交和推进工作的贡献者。部署、凭据、systemd、保留产物和故障处理请参阅[运维手册](sandcastle-local-dispatcher-runbook.md)。

<a id="before-you-add-a-label"></a>
## 添加标签前

Issue、Spec、review thread 或 Pull Request 必须能够独立说明任务。请写清楚预期行为、相关约束和验收标准。标签只授权相应操作，不能代替任务说明。

本地 Dispatcher 每分钟扫描一次 GitHub。一般只需添加标签并等待下一轮扫描，不需要在本地运行 Sandcastle 命令。

> [!IMPORTANT]
> Sandcastle 不会合并 Pull Request。自动 review 成功后，它会把 Draft Pull Request 标记为 Ready for Review。最终仍需人工核对 required checks 并合并。

<a id="label-reference"></a>
## 标签参考

<a id="labels-contributors-add"></a>
### 贡献者添加的标签

| GitHub 对象 | 标签 | 请求的操作 | 成功后的停止位置 |
| --- | --- | --- | --- |
| 没有子 Issue 的顶层 Issue | `agent:implement` | 规划并实现该 Issue | 一个 `sandcastle/issue-<n>` 分支和一个 Draft Pull Request |
| 没有子 Issue 的顶层 Issue | `agent:to-tickets` | 把 Spec 拆成可独立理解的子 Issue | 相互链接并带 blocking dependency 的子 Issue |
| 带子 Issue 的顶层 Issue | `agent:implement` | 实现下一个符合条件的 Spec 子 Issue | 自动请求下一个子 Issue；最后一个完成后自动请求 PR review |
| Draft Pull Request | `agent:review` | review 当前精确 revision，必要时修复 | 发布 review，并将 Pull Request 标记为 Ready for Review |
| Pull Request | `agent:implement` | 实现可执行的 review feedback | 更新同一分支和 Pull Request |
| Pull Request | `agent:update-branch` | 从 base branch 更新 head branch | 更新同一分支和 Pull Request |
| 顶层 Issue | `agent:queued` | 等待所有 blocking Issue 关闭 | 标签改为 `agent:implement`，随后进入普通实现流程 |

不要给 Spec 子 Issue 添加 `agent:queued` 或操作标签。父 Spec 负责推进子 Issue。来自 fork 的 Pull Request 不能执行这些写操作。

<a id="labels-sandcastle-manages"></a>
### Sandcastle 管理的标签

| 标签 | 含义 | 贡献者该做什么 |
| --- | --- | --- |
| `agent:in-progress` | Sandcastle 已获取该 Work Item | 任务运行期间不要添加或移除该标签 |
| `agent:blocked` | 执行、超时、push 或发布失败 | 找出失败原因后再授权重试 |

Sandcastle 获取操作时会消费触发标签。获取后标签消失，不代表任务被取消。

<a id="common-workflows"></a>
## 常用工作流

<a id="implement-an-ordinary-issue"></a>
### 实现普通 Issue

1. 创建一个说明完整、没有子 Issue 的顶层 Issue。
2. 添加实现标签：

   ```bash
   gh issue edit <issue-number> --add-label agent:implement
   ```

3. 等待 Sandcastle 创建 `sandcastle/issue-<issue-number>` 分支，以及正文中关闭该 Issue 的唯一一个 Draft Pull Request。
4. 检查实现，然后在该 Draft Pull Request 上请求自动 review：

   ```bash
   gh pr edit <pr-number> --add-label agent:review
   ```

5. Sandcastle 发布 review 并将 Pull Request 标记为 Ready for Review 后，检查 required checks，再手动合并。

普通 Issue 实现不会自动添加 `agent:review`。

```text
Issue + agent:implement
  -> 实现分支 + Draft PR
  -> 人工添加 agent:review
  -> 自动 review，必要时修复
  -> Ready for Review
  -> 人工合并
```

<a id="split-and-implement-a-spec"></a>
### 拆分并实现 Spec

当一个顶层 Issue 描述的工作需要按顺序拆成多个可独立理解的子 Issue 时，使用此流程。

1. 给 Spec 添加拆分触发标签：

   ```bash
   gh issue edit <spec-number> --add-label agent:to-tickets
   ```

2. 检查生成的子 Issue 及其 blocking relationship。
3. 给父 Spec 添加实现触发标签，不要给子 Issue 添加：

   ```bash
   gh issue edit <spec-number> --add-label agent:implement
   ```

4. Sandcastle 每次在共享的 `sandcastle/spec-<spec-number>` 分支上实现一个符合条件的子 Issue。一个子 Issue 成功后，Sandcastle 会关闭它并自动请求下一个。
5. 最后一个子 Issue 成功后，Sandcastle 会自动给共享 Draft Pull Request 添加 `agent:review`。
6. review 将 Pull Request 标记为 Ready for Review 后，检查 required checks，再手动合并。

```text
Spec + agent:to-tickets
  -> 相互链接的子 Issue
  -> 父 Spec + agent:implement
  -> 按顺序实现子 Issue
  -> 最后一个 Draft PR 自动获得 agent:review
  -> Ready for Review
  -> 人工合并
```

<a id="implement-pull-request-feedback"></a>
### 实现 Pull Request feedback

1. 在尚未解决的 Pull Request review thread 中写明要修改的内容。
2. 给 Pull Request 添加实现标签：

   ```bash
   gh pr edit <pr-number> --add-label agent:implement
   ```

3. Sandcastle 在现有 head branch 上实现选中的 feedback，把结果 push 到同一个 Pull Request，并回复 reconciliation evidence。
4. 如果还需要一次自动 review，请在 feedback 实现完成后添加 `agent:review`。

在 Pull Request 上，`agent:implement` 表示实现 review feedback。它不表示普通 Issue 实现，也不会合并 Pull Request。

<a id="update-a-pull-request-branch"></a>
### 更新 Pull Request 分支

需要从最新 base branch 更新且不是来自 fork 的 Pull Request，可以添加：

```bash
gh pr edit <pr-number> --add-label agent:update-branch
```

Sandcastle 会更新现有 head branch。如果分支已经是最新状态，它只会留下评论，不会创建 commit。需要 review 时请另行请求。

<a id="queue-work-behind-blockers"></a>
### 排队等待 blocker

用 GitHub blocking dependency 描述阻塞关系，然后给顶层 Issue 添加标签：

```bash
gh issue edit <issue-number> --add-label agent:queued
```

每轮 dispatch 都会读取当前 dependency 状态。所有 blocker 关闭后，Sandcastle 会把 `agent:queued` 改为 `agent:implement`，无需重放事件或手动提升。系统会拒绝排队的子 Issue，因为子 Issue 的推进由父 Spec 管理。

<a id="observe-progress"></a>
## 查看进度

GitHub 是持久状态的查看入口：

- 触发标签表示操作正在等待获取；
- `agent:in-progress` 表示任务已获取该操作；
- `agent:blocked` 和诊断评论表示任务失败；
- 分支、Draft Pull Request、review、评论或标签变化记录成功结果。

如果你也负责受信任的本地 checkout，可以运行只读检查：

```bash
npm run sandcastle -- inspect
```

该命令报告本地镜像和 GitHub readiness、活动任务及发现的命令，并显示 `eligible`、`blocked`、`stale-in-progress`、`inconsistent` 等 eligibility。它不会修改 GitHub 或本地任务状态。

<a id="recover-blocked-work"></a>
## 恢复阻塞任务

Sandcastle 不会自动重试整个阻塞任务。

1. 阅读 Issue 或 Pull Request 上经过分类的诊断评论。
2. 如果评论不足以定位问题，请运维人员检查本地任务。运维人员应按[运维手册](sandcastle-local-dispatcher-runbook.md#blocked-automation-diagnosis)使用 `npm run sandcastle -- inspect`、systemd journal 和保留产物。
3. 修复根本原因。
4. 确认没有匹配的活动任务后，移除 `agent:blocked` 并恢复原触发标签。例如：

   ```bash
   gh issue edit <issue-number> \
     --remove-label agent:blocked \
     --add-label agent:implement
   ```

   对 Pull Request 使用 `gh pr edit`，并根据操作恢复 `agent:review`、`agent:implement` 或 `agent:update-branch`。

不要创建替代 Issue、分支或 Pull Request 来绕过阻塞任务。重试必须复用现有 Work Item 和实现分支。

如果 `agent:in-progress` 看起来已经过期，不要只根据经过的时间清除它。运维人员必须先通过检查和本地日志确认没有匹配的活动任务。一个 Work Item 同时带有触发标签和 `agent:in-progress` 时属于 `inconsistent`，人工修正前不会执行。

本地镜像或 GitHub 凭据 readiness 失败发生在获取之前。触发标签会保留，Sandcastle 不会添加 `agent:blocked`。运维人员恢复 readiness 后，下一轮扫描会获取未变化的命令。

<a id="what-sandcastle-does-not-infer"></a>
## Sandcastle 不会自行推断什么

Dispatcher 只校验带有显式标签的工作，不会扫描所有 Issue 和 Pull Request 并决定仓库下一步该做什么。它不会：

- 推断一个没有标签的 Issue 已经可以实现；
- 推断普通实现产生的 Draft Pull Request 已经可以 review；
- 推断 Ready Pull Request 可以合并；
- 合并 Pull Request 或启用 GitHub auto-merge。

以上显式标签就是授权边界。不确定时不要给 Work Item 添加标签，请维护者明确下一步只能执行哪一个操作。
