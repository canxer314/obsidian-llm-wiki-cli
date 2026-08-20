# Issue 118 双 Issue 并发验收记录

记录日期：2026-08-20（UTC）

## 结论

Issue #118 的双 Issue Sandcastle 并发验收 **通过**。

一个真实 `npm run sandcastle -- --watch` 进程在同一个 run 和 batch 中领取 Issue #160 与 #161，活动数达到 2 且未超过 2。两项使用独立的确定性 branch、Draft PR、Agent Session、local-quality 容器/worktree、SHA status 与 merge/close 流程。

#160 的 Reviewer 在 verdict 产生前遇到一次 GitHub GraphQL `EOF`。Sandcastle 将 #160 终止为失败并保留 branch、Draft PR、SHA 与脱敏诊断；与此同时 #161 不受影响，继续通过两道 gate 并 exact-head merge。#160 随后同步已更新的 `master`，在新 SHA 上重新完成 local-quality 和独立 review，再 exact-head merge。该样本同时证明并发交付和终局失败隔离。GitHub 瞬时失败缺少有界重试的问题单独记录在 #164。

## 同一 watch 批次

结构化 evidence 只记录公开标识符、角色、attempt、SHA、gate 和终局状态，不包含 prompt、命令输出、凭据、provider routing 或本机路径。

- `runId`: `dc8d8095-001c-4963-beef-6ba4d7a9b882`
- `batchId`: `1`
- `batch-started.issueNumbers`: `[161, 160]`
- Issue #161 启动时 `activeCount=1`
- Issue #160 启动时 `activeCount=2`
- 记录中没有大于 2 的活动数

| Issue | Deterministic branch | Draft PR | Planner Session | Implementer Session | 初始 repair counter |
| --- | --- | --- | --- | --- | --- |
| #161 | `sandcastle/issue-161` | #162 | `planner-issue-161`, attempt 1 | `implementer-issue-161`, attempt 0 | 0；未触发 repair |
| #160 | `sandcastle/issue-160` | #163 | `planner-issue-160`, attempt 1 | `implementer-issue-160`, attempt 0 | 0；未触发 repair |

两个 Implementer Session 并发运行于各自的 Docker sandbox。每个 local-quality gate 又使用独立 container、detached worktree、临时 image 与 writable npm cache；没有共享宿主可写 npm cache。

## 不含 secret 的时间线

| UTC 时间 | Issue #161 / PR #162 | Issue #160 / PR #163 |
| --- | --- | --- |
| watch batch | 同一 run/batch 启动，`activeCount=1` | 同一 run/batch 启动，`activeCount=2` |
| Agent Sessions | 独立 Planner、Implementer；Reviewer `reviewer-pr-162-6c4ccd15e657-attempt-1` | 独立 Planner、Implementer；Reviewer `reviewer-pr-163-460d96007de0-attempt-1` |
| 初始 head | `6c4ccd15e657c5408b6d2996a636cd33fe56d7c1` | `460d96007de06af51750e8eb987aa6f53dc0896f` |
| 04:38:04 / 04:38:22 | local-quality success | local-quality success |
| 04:38:26 | review 正在运行 | review pending；随后读取 GitHub GraphQL 时发生 `EOF` |
| watch 终局 | review success；请求 exact-head merge | `workflow-finished=failed`, stage `reviewer`；branch、Draft PR、SHA 和诊断保留 |
| 04:41:27–28 | PR #162 以 expected head `6c4ccd1...` squash merge为 `cf0f668...`；`Closes #161` 关闭 Issue | 失败不改变 #161 的 gate、merge 或 Issue 状态 |
| 后续恢复 | — | 与 `master` 合成正常双 parent head `bbb9c5477b24e1a9a74d3daa6fd3362e59bcdecf` |
| 04:53:08 / 04:55:56 | — | 新 head 的 local-quality success / review success；未复用旧 SHA 状态 |
| 04:56:04–05 | — | PR #163 以 expected head `bbb9c54...` squash merge为 `e205782...`；`Closes #160` 关闭 Issue |

## GitHub 权威交叉核验

本地 evidence 记录 Sandcastle 尝试的操作；以下结果以 GitHub API 为权威来源：

| PR / Issue | exact head | `sandcastle/local-quality` | `sandcastle/review` | Merge / close |
| --- | --- | --- | --- | --- |
| PR #162 / Issue #161 | `6c4ccd15e657c5408b6d2996a636cd33fe56d7c1` | success | success | squash merge `cf0f668f0cfbb97dbc0d6e4533c730e77c582284`；closing relationship 指向 #161；Issue closed |
| PR #163 / Issue #160（初始失败现场） | `460d96007de06af51750e8eb987aa6f53dc0896f` | success | pending | 未 merge；Draft PR、branch 和失败诊断保留 |
| PR #163 / Issue #160（最终 head） | `bbb9c5477b24e1a9a74d3daa6fd3362e59bcdecf` | success | success | squash merge `e205782975c2fa83b4f839123a32629d46623591`；closing relationship 指向 #160；Issue closed |

PR #163 的最终 head 是旧 #160 head 与 PR #162 合并后的 `master` 组成的正常双 parent merge commit。最终两道 success 均重新绑定该 SHA；旧 SHA 的 local-quality success 和 review pending 没有被复用。

## 逐项验收

| Acceptance criterion | 结果 | 证据 |
| --- | --- | --- |
| 同一 watch 批次，活动数不超过二 | **通过** | 同一 `runId`、`batchId=1`；批次为 `[161,160]`；活动数为 1、2，从未大于 2。 |
| branches、PRs、Agent Sessions、repair counters、SHA statuses 相互隔离 | **通过** | 独立 `sandcastle/issue-*` branch、PR #162/#163、角色 Session 名称和 SHA；两项 repair counter 都从 0 独立开始且未触发 repair。 |
| 每个交付 SHA 分别获得两道 current-head 成功结果 | **通过** | `6c4ccd1...` 与 `bbb9c54...` 均由 GitHub API 返回两道 success；#160 新 head 重新执行 gate。初始失败 SHA 的 pending 现场明确保留而未冒充成功。 |
| 各自 exact-head squash merge，并由 `Closes` 关闭 | **通过** | merge request/REST API expected head 与两道 gate SHA 一致；GraphQL closing relationship 分别指向 #161/#160；两项均 closed。 |
| 一项失败不污染另一项，统一保留失败现场 | **通过** | #160 Reviewer 基础设施失败后，#161 继续成功；#160 未被误合并，branch、Draft PR、SHA 和脱敏诊断保留。 |
| 留存不含 secret 的时间线和结果 | **通过** | 本文仅记录公开 GitHub 元数据和结构化 evidence 的允许字段。 |

## Follow-up

Issue #164 单独处理 GitHub CLI/GraphQL 瞬时 `EOF` 缺少有界重试的问题，包括永久错误分类、非幂等写入对账，以及已发布 pending gate 的终态化。该问题不削弱本轮已经证明的 Docker/Session 隔离、并发上限、exact-head gate 或 failure isolation。

## 历史对照

2026-08-18 的 #116/#117 轮次只证明了独立作业时间重叠，没有同一个 watch batch、确定性 Sandcastle branch 或 Agent Session evidence，因此当时正确地未通过。2026-08-20 的 #160/#161 轮次补齐了这些缺失证据并取代该轮作为 Issue #118 的正式验收记录。
