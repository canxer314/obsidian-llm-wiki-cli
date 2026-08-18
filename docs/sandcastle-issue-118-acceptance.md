# Issue 118 双 Issue 并发验收记录

记录日期：2026-08-18（UTC）

## 结论

本轮 **未通过 Issue #118 的双 Issue Sandcastle 并发验收**。#116 与 #117 的实现时间有重叠，且最终各自通过当前 head 的两道状态门禁、以 `Closes` 关系 squash merge 并关闭；但 GitHub 证据表明它们使用 `worktree-*` 分支，而不是 `sandcastle/issue-<number>`。本轮也没有同一个 `--watch` 进程的批次日志，因此不能证明单机活动上限、独立 Agent Sessions 或独立 repair counters。

不得将下表中的部分成功解释为完整验收成功。

## 不含 secret 的时间线

| UTC 时间 | Issue #116 / PR #140 | Issue #117 / PR #139 |
| --- | --- | --- |
| 20:49:44 | head `247d067eba025c0c90759b85e26b4c99fdd5d7c8` | — |
| 20:54:43 | head `55669fcde7230f930eaf5e3267394f9888c20805` | — |
| 21:17:23 | — | head `f12632060cc2415026e41328f3a1c4c31a2f5000` |
| 21:36:26 | — | PR #139 创建 |
| 21:41:32 | — | `f126320...`: local-quality success |
| 21:48:37 | — | `f126320...`: review failure |
| 21:50:27 | — | repair head `262233f6baa6d00f06eeceeffa7765fb2726dd2e` |
| 21:51:30 | — | `262233f...`: local-quality success |
| 22:25:20 | — | `262233f...`: review success |
| 22:25:48–49 | — | exact-head squash merge为 `255ff431d656abfd80c046d2052bcc1cc32c7282`；#117 关闭 |
| 23:08:12–43 | PR #140 创建；同步 master 后 head `5d2a6b7fbe4df0642dddcc9a2c60bf9d611f4dac` | — |
| 23:10:50 | `5d2a6b7...`: local-quality success | — |
| 23:12:54 | `5d2a6b7...`: review success | — |
| 23:13:19–20 | exact-head squash merge为 `329a6da141598970e61fe6e94b15b97ccddf6a1d`；#116 关闭 | — |

两个任务的开发区间重叠（#116 首个提交在 20:49，#117 在 21:17 开始），但这只能证明人工/独立作业的时间重叠，不能证明它们由同一个 watch 批次启动。

## 逐项验收

| Acceptance criterion | 结果 | 证据 |
| --- | --- | --- |
| 同一 watch 批次，活动数不超过二 | **未证明** | 没有 watch batch/active-count 日志；分支来源也不是 Sandcastle watch。 |
| branches、PRs、Agent Sessions、repair counters、SHA statuses 相互隔离 | **部分通过** | PR #139/#140、head SHA 与状态互相独立；分支分别为 `worktree-implement-issue-117` 与 `worktree-issue-116-unload-snapshot-barrier`，违反确定性分支要求；无 Agent Session 与 counter 证据。 |
| 每个新 SHA 分别获得两道 current-head 结果 | **未通过** | #117 的两个实现 SHA 均有两道结果；#116 的 `247d067...`、`55669fc...` 没有 status，只有最终同步 SHA 有两道成功结果。 |
| 各自 exact-head squash merge，并由 Closes 关闭 | **通过** | PR #139 body 为 `Closes #117`，PR #140 body 为 `Closes #116`；两者 status rollup 均绑定最终 head，随后分别 squash merge 并关闭 Issue。 |
| 一项失败不污染另一项，统一保留失败现场 | **未证明** | #117 的 review failure 后成功 repair，#116 不受其 SHA status 污染；但没有同一 orchestrator 批次或终局失败样本，无法验证统一失败保留策略。 |
| 留存不含 secret 的时间线和结果 | **通过** | 本文记录公开 GitHub 元数据；不包含 token、路由或本机配置。 |

## 下一次复验要求

1. 新建两个小型、互不依赖的行为 Issue，并同时添加精确 `Sandcastle` label。
2. 只启动一个 `npm run sandcastle -- --watch` 实例，并保存 stderr 中 `sandcastleWatch` JSON 事件。
3. 确认同一 `batchId` 的 `batch-started` 包含两个 Issue，随后活动数仅为 1、2，从不大于 2。
4. 保存每个 `sandcastle/issue-<number>` branch、Draft PR、Agent Session 标识、repair attempt、每次 head SHA 的两道状态以及最终 merge/close 时间线。
5. 至少让一个候选经历可恢复失败；确认另一个候选的事件、状态与最终结果不改变。若制造终局失败，确认其 PR/branch/Issue 被保留并单独标记，而成功候选仍正常合并。

仓库的 watch seam 现已输出上述批次与生命周期事件，且自动化测试覆盖同一批次双启动、峰值活动数为二，以及一个失败时另一个仍记录成功。
