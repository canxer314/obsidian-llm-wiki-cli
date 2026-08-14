# 决策：installed cache and graph causality

## 结论

在 ThinkFlywheel Vault 当前安装的 Obsidian 1.13.4 上，Vault Operation Bridge **可以**用公共 `Vault` / `MetadataCache` 事件加定向探针实现有界、逐 Change Set 的成功屏障，但这个屏障必须绑定到最终 Content Version，不能把任一事件、`mtime`、`metadataCache.resolved` 或当前缓存对象本身当作提交证明。

支持的契约是：Change Set 只有在所有最终字节重新读取并匹配预期 Content Version、每个被解析 Markdown 的 `metadataCache.changed(file, data, cache)` 中 `data` 的 SHA-256 匹配该最终 Content Version、并且所有受影响源笔记的 `resolvedLinks` / `unresolvedLinks` 满足预期后置条件且保持一个短 quiet window 后，才可进入 `succeeded`。rename 另需 `vault.rename` 关联旧/新路径；超时必须失败关闭。

## 决定性证据

连续覆盖场景稳定地产生了问题所担心的迟到观察：

1. `rapid-source.md` 的 v1 被创建，随后立即写入 v2；
2. v1 的 `metadata-changed` 到达时，重新读取的磁盘字节已经是 v2，而图仍指向 v1 的旧目标；
3. 回调的 `data` 仍是 v1，因此它的 SHA-256 明确标识 v1，可以与当前预期 v2 Content Version 比较并拒绝；
4. 随后的 v2 `metadata-changed` 携带 v2 字节，图也切换到最终目标，此时屏障才开放。

这证明了两个事实：公共事件确实可能迟到，但 `metadataCache.changed` 的 `data` 足以为该次解析建立 Content Version；仅在事件处理时重新读取文件会把迟到 v1 错认成 v2，不能用于事件归因。

目标 rename 场景还观察到：

- `vault.rename` 立即提供旧/新路径关联；
- derived link rewrite 的新 Content Version 很快进入 metadata cache；
- link graph 曾短暂为空/保留旧 unresolved link，随后才解析到新目标；
- 因而 `metadata-changed` 不是 link-graph readiness，`metadataCache.resolved` 也只是全局活动信号，最终必须读取 `resolvedLinks` / `unresolvedLinks` 的定向后置条件。

创建缺失目标的场景证明：不修改源笔记时，同一个源 Content Version 的图可以从 unresolved 自动转为 resolved。因此 target create/delete/rename 都需要把受影响源笔记加入 semantic probe closure，而不能只等待 touched file 的 metadata 事件。

## 屏障算法

对 Change Set 的最终 footprint：

1. 执行所有 mutation 与显式 derived link rewrite。
2. 重新读取每个最终路径的精确字节并验证 Content Version；任何不匹配立即失败。
3. 为每个预期 Markdown Content Version 等待 `metadataCache.changed`，对回调 `data` 计算 Content Version：
   - 等于最终 Content Version：记录该版本的 metadata-ready evidence；
   - 不等于：这是旧/无关观察，忽略但保留诊断记录。
4. create/modify 由 `changed` 提供版本归因；rename/delete 同时要求相应 `Vault` 事件与路径后置条件。
5. 对 touched/derived-link closure 中每个源笔记，探查：
   - `getFileCache(file)` 的预期 metadata/heading/frontmatter 后置条件；
   - `resolvedLinks[sourcePath]` 的预期目标与计数；
   - `unresolvedLinks[sourcePath]` 不含应已解析目标，或含应保持 unresolved 的 linkpath；
   - 如需验证单一 link 语义，再用 `getFirstLinkpathDest(linkpath, sourcePath)` 定向确认。
6. 所有条件同时满足后保持短 quiet window；窗口内任何相反观察重置计时。
7. 在总 deadline 前收敛才允许写 durable `COMMITTED` 并报告 `succeeded`；超时进入 rollback/failed 路径，绝不能降格为静默成功。

## 有界参数

最终可复现运行使用：

- 每个屏障 deadline：5,000 ms；
- quiet window：250 ms；
- 单写入：1,162.2 ms；
- 连续覆盖最终版本：965.4 ms；
- rename 前：976.3 ms；
- rename + derived rewrite 后：1,986.8 ms；
- unresolved 建立：1,006.5 ms；
- target create 后 resolved：982.3 ms。

这些值证明 5 秒在当前 Vault/安装上足以覆盖所测场景，但不构成永久性能常数。产品应把 deadline 设为可配置并记录逐项 pending evidence；发布前基准语料还需覆盖大 Change Set、并发外部修改和大型 link closure。

## 不保证

- 不保证 Obsidian 有全局、多文件或版本化的 cache commit。
- 不保证 `metadataCache.resolved` 对某个 Change Set 或 Content Version 具有因果含义。
- 不保证 link graph 与 metadata callback 同时更新；实测它们会分阶段收敛。
- 不保证 rewrite 未触及的目标 rename 会自动保持原链接样式；derived rewrite 仍须由 Bridge 明确计划和执行。
- 不保证第三方插件不会观察 Bridge 的临时/执行中路径。实测一个已启用索引插件曾在临时文件极短生命周期内报告“no Obsidian file metadata”；因此产品执行路径不应暴露半成品临时 Markdown，或必须放在 plugin-private、非 Vault-indexed 区域。
- 不把本原型的 5 秒结果推广到所有 Vault、平台或未来 Obsidian 版本；每个受支持版本都要跑同一验收探针。

## 验收资产

- `main.ts`：throwaway 状态/事件探针。
- `run-probe.ps1`：无持久插件安装的一键运行入口。
- `results/2026-08-01T14-30-22-001Z/report.json`：最终结构化运行结果。
- `results/2026-08-01T14-30-22-001Z/events.jsonl`：完整单调时间线与 Content Versions。
- `results/2026-08-01T14-30-22-001Z/verdict.md`：机器运行生成的简要 verdict。
