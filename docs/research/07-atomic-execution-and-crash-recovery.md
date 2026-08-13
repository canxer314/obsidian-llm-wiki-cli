# Change Set 原子执行与崩溃恢复证明

**研究日期：** 2026-08-01  
**对应票：** [Prove atomic execution and crash recovery](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/7)  
**结论：** 可在插件托管的 Vault Operation Bridge 中实现「单桥接器内、无并发外部写入时」的可恢复 all-or-restore Change Set；这不是 Obsidian 提供的多文件事务。恢复语义必须以一个在第一次 Vault mutation 前已持久化的 Recovery Journal、完整 before-image 和启动时 write gate 为基础。纯公开 Obsidian API / Node `fs` 不能证明跨文件 ACID 提交，也不能在存在任意外部写入或断电且底层设备不遵守 flush 时保证无条件回滚；此时必须停止写入并要求 Primary Operator 处理冲突。

## 1. 已固定的边界与本研究的结论

本研究遵循 `CONTEXT.md` 中的术语：一个 Change Set 包含相关 Vault mutations，完成时全成，否则恢复执行前状态；Recovery Journal 是短期恢复状态，Submission Key 使重试幂等，而不是 Git 提交或永久审计记录。

父地图与已关闭的 [Define the MVP product boundary and operating model](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/3)、[Choose the runtime and Claude Code transport architecture](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/4)、[Specify the Change Set contract](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/6) 已固定以下前提：

- **唯一语义权威。** 已加载的 Obsidian 插件托管 loopback Streamable HTTP MCP Bridge；所有 Agent Sessions 连接同一进程、同一执行器。外部文件服务、每会话 stdio 和 Git 都不是写事务层。
- **可变操作范围。** `create_directory`、`create_note`、`edit_body`、`edit_frontmatter`、`move`、`copy_attachment`、`move_attachment`、`trash`，以及 move 所导致的确定性、format-preserving derived link rewrite。
- **提交契约。** Change Set 在入队前、及取得串行写租约后都要验证 Content Versions / Read Dependencies；同一 Submission Key + 同一 canonical fingerprint 返回既有 record，不得再次执行；不同 fingerprint 被拒绝。
- **不能借用不存在的保证。** `Vault` 公共声明列出的是单文件/单目录异步操作；`Vault.process(file, synchronousTransform)` 只承诺一份文件的 atomic read-modify-save。声明没有多文件事务或 metadata-cache commit barrier。[Obsidian `Vault` 声明](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7394-L7534)

因此这里的「证明」是受以下前提约束的故障原子性：在 journal 已持久化、before-images 可读、Bridge 是唯一 writer，且恢复过程中未检测到外部冲突时，任何在 begin 后的进程崩溃都会在下一次 plugin load、任何新写入之前，收敛为完整的执行前逻辑 Vault 状态。它不是文件系统的通用原子事务，也不宣称覆盖硬件谎报 flush、磁盘永久损坏或绕过 Bridge 的写入。

## 2. 一手资料所允许和不允许的内容

### 2.1 Obsidian 的可用语义

`App` 向 plugin 暴露 `vault`、`metadataCache` 和 `fileManager`；插件经 `this.app` 访问它们。[`App` 与 `Plugin` 声明](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L406-L441) [插件 API README](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/README.md#L37-L44)。这支持把 Vault 语义和全局队列放在一个已加载 plugin 内；它**不**提供外部进程可调用的多文件 transaction。

- `Vault` 提供逐项 `create`、`modify`、`rename`、`trash`、`delete`；`DataWriteOptions` 只有可选 timestamps，并没有 transaction/flush/cache-ready 字段。[`Vault` mutation 声明](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7450-L7534) [`DataWriteOptions`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2148-L2162)
- `Vault.rename()` 明确建议需要自动 rename links 的调用方使用 `FileManager.renameFile()`；后者的文档限定为按用户 preference 更新 links。因此它不能作为本产品的确定性 derived rewrite 或事务证明。Bridge 应先用 cache 计算并校验闭包，再将每个 rewrite 自己纳入 Change Set。[`Vault.rename`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7466-L7474) [`FileManager.renameFile`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2895-L2902)
- `Vault.trash(file, false)` 是 vault-local trash，而 `Vault.delete()` 是永久删除；`FileManager.trashFile()` 又受 preference 控制。没有公开的「把本次 trash 恢复到原 path」API。因此，不可把 opaque `Vault.trash` 的结果当作可逆操作；见第 5 节的 Bridge 管理 `.trash` staging namespace 方案。[`Vault` trash/delete](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7450-L7465) [`FileManager.trashFile`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2904-L2920)
- `metadataCache.changed` 表示某文件已 index、metadata 可用，但声明明确说 rename 时不触发；`Vault` 另有 `rename` event，cache 还有 per-file `resolve` / global `resolved` events。它们是观察信号，并非全 Vault transaction barrier。[cache events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4446-L4472) [`Vault` events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7567-L7593)

### 2.2 Node 与 Windows 的持久化边界

Node 的 `FileHandle.sync()` / `fs.fsync()` 是「请求把该 open descriptor 的数据 flush 到 storage device」，文档明确该实现受 OS/device 影响；`datasync()` 不 flush modified metadata。[Node `FileHandle.sync`](https://nodejs.org/docs/latest-v26.x/api/fs.html#filehandlesync) [`fs.fsync`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fsfsyncfd-callback) [`datasync`](https://nodejs.org/docs/latest-v26.x/api/fs.html#filehandledatasync)。在 Windows，libuv 的 fsync 路径调用 `FlushFileBuffers(uv__get_osfhandle(fd))`，所以它只针对**已打开的文件句柄**，并不补足 rename 所需目录元数据持久化保证。[libuv immutable Windows fsync source](https://github.com/libuv/libuv/blob/c0bd247782f3a7fbb22499970c2c14ac05a46f26/src/win/fs.c)。因此 journal 记录要用 `sync` 而不是 `datasync`，但仍应将意外断电与实际 volume 类型列入验收。

Node `rename()` 的官方页面只承诺 rename，且 destination-exists 行为在 Windows 与 POSIX 不同；它没有公布 crash-safe multi-file commit 或 directory-metadata-durability 保证。[Node `fs.rename`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fspromisesrenameoldpath-newpath)。同样，`fs.cp()` 没有 atomic/correct-after-interruption 承诺，绝不能用于「已提交」的多文件发布。[Node `fs.cp`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fspromisescpsrc-dest-options)

Windows 的更低层资料说明为什么不能把一般 Node rename 当作 durability proof：

- `FlushFileBuffers` 将指定文件的 buffered information 写入 device；Microsoft 同时指出若要求 critical data 到 persistent media，应考虑 unbuffered I/O / `FILE_FLAG_WRITE_THROUGH`，且该调用对所有写入逐次使用会低效。[Microsoft `FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
- `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` 才有「return 前已实际 move 到 disk」的文档；其中 copy-and-delete move 的 flush 在 copy 结束时发生。`MOVEFILE_COPY_ALLOWED` 则可以变成 copy+delete，且 source 删除失败时 API 仍可能成功并保留 source。因此跨 volume move 不能纳入一个 atomic Change Set。[Microsoft `MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- Node 的 Windows rename 由官方 Node source 的 `binding.rename(oldPath, newPath, kUsePromises)` 进入 libuv；libuv 的 Windows `uv__fs_rename` 调用 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，并未请求 `MOVEFILE_WRITE_THROUGH`。Node API 只承诺 rename，不承诺 crash/power-loss 后的 rename 或 directory entry 已持久化；这一 source-level chain 强化了「不能把 Node rename 成功当作 power-loss durable commit」的限制。[Node immutable promises source](https://github.com/nodejs/node/blob/a46087d7e8e5dfaecfdff6cb146f1b5fd2dc9411/lib/internal/fs/promises.js) [libuv immutable `uv__fs_rename` source](https://github.com/libuv/libuv/blob/c0bd247782f3a7fbb22499970c2c14ac05a46f26/src/win/fs.c)

**决策：** MVP 的 journal durability 使用 plugin desktop runtime 中的 Node file handles + `FileHandle.sync()`，并把其承诺准确限制为「已请求 OS/device flush」。若产品要求可验证的断电级持久提交，必须先做 Windows-native capability prototype（同卷 NTFS、native `FlushFileBuffers` / `MoveFileExW(MOVEFILE_WRITE_THROUGH)` 的实际可用性），并将 failure-injection 结果作为上线门槛；不要仅凭 JS `rename` 声称证明。

## 3. 全局 FIFO 串行 Change Set executor

### 3.1 所有权、线性化点与队列规则

Bridge 在 plugin lifecycle 内创建**唯一** `ChangeSetExecutor`。所有 MCP submit handler 只做 schema/size validation、canonicalization、Submission-Key lookup，然后把 acceptance 放入同一个内存 FIFO。handler 本身、定时任务、link updater 和任何 diagnostic tool 都不得直接调用 Vault mutation。

1. **Admission（短临界区）。** 对 canonical request 求 `requestFingerprint`；在 durability store 中原子读/写 `{submissionKey, fingerprint, changeSetId, state}`。同 key + 同 fingerprint 返回已有 record；同 key + 异 fingerprint 返回 `submission_key_conflict`；只有新 key 得到一个单调 `enqueueSeq`。
2. **FIFO。** executor 依 `enqueueSeq` 取首项；不得优先化、按连接并发，或在同一 Change Set 中穿插另一项。取消只允许尚未开始的 queued item 转为 terminal `rejected/cancelled`（若以后加入取消语义）；开始后只可 rollback/recover。
3. **写租约内重做 preflight。** 把在 ingress 得到的 preview 当提示而非 token。取得队首写租约后，从 `Vault.read` / binary read 重取所有 explicit 和 derived target，重验 Content Version、SHA-256、read dependency、absence/collision、anchor cardinality、path containment、cache generation 与 derived rewrite closure。任一不符，在**第一次 mutation 前** `rejected`。
4. **执行线性化点。** `PREPARED` journal record 成功 `sync` 后、首次 Vault mutation 之前。此点以后只存在「未完成、将由 rollback/recovery 恢复」的事务；不允许新 writer 越过它。
5. **完成线性化点。** 后写验证与 cache-readiness 都通过，且 `COMMITTED` record 成功 `sync` 后。此时 record 才能为 `succeeded`，后续 bridge reads/searches 才可承诺观察成功版本。

这证明的是**所有经 Bridge 的 Change Set** 的 FIFO；它不是 Windows 文件锁，也不能序列化 Primary Operator 在 Obsidian 编辑器、另一插件、同步服务或 Explorer 中进行的外部修改（第 8 节）。

## 4. Recovery Journal：数据模型、状态机与顺序

### 4.1 存放与编码

Journal 位于插件自己的持久 data area，并且不是 Change Set 可写的 Vault path；在 Obsidian 的常见安装布局中该 plugin-private state 可以物理位于 `.obsidian/plugins/<plugin-id>/`，但它不属于 `.obsidian/` 的用户 Change Set 语义，只有 executor 可写。它也不在 `.git/` 或用户 `.trash/` 语义范围内。desktop-only plugin 可使用 Node/Electron `require`，但 plugin 生命周期仍必须负责停机与恢复。[Obsidian plugin packaging/runtime](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/README.md#L15-L35) [`Plugin.onload` / cleanup](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4901-L4929)

使用有 version、length 和 SHA-256/CRC 的 append-only framed WAL。每个 frame 在完整写入后 `FileHandle.sync()`；解析到不完整或 checksum 不符的尾 frame 时丢弃该尾部，采用最后一条有效 frame。为避免「刚创建 journal 文件但目录 entry 尚未耐久」的问题，安装/启用阶段预建固定的双 journal slots 和固定 manifest；运行期只覆写/append 已存在文件，不依赖每个 Change Set 的临时文件名。达到容量阈值时只在**没有 active Change Set** 时 rotate/compact，并先重新验证固定 slots。若该准备工作或 sync 失败，Bridge `recovery_required`，拒绝写入。

必须设置 Change Set 最大恢复 footprint（所有 before-image raw bytes + attachment bytes + record overhead）；超限在 preflight `payload_limit_exceeded`，而不是开始后才发现 journal 放不下。此限制是无 SQLite 方案的成本；本研究不提议 SQLite，故没有假定 SQLite 自带的 atomic commit。

### 4.2 每笔 `PreparedChangeSet` 的必备字段

| 字段 | 用途 |
| --- | --- |
| `formatVersion`, `journalGeneration`, `changeSetId`, `enqueueSeq` | 解析、排序和升级防护。 |
| `submissionKey`, `requestFingerprint`, `agentSessionId` | 幂等、status 和 request identity；key 只按权限边界披露。 |
| `vaultIdentity`, canonical root identity, bridge build | 防止 journal 被错误 Vault / plugin 配置恢复。 |
| `state`, `phase`, `createdAt`, `attempt`, error | lifecycle、故障诊断和重启恢复。 |
| canonical requested/derived operation plan | 使恢复知道完整预期 footprint；含 `causedByOperationId`。 |
| `preconditionSet` | 每个原始/derived path 的 type、absence 或 Content Version/SHA-256，以及读依赖。 |
| `beforeImageSet` | 每个会变更的 note/attachment 的原始 bytes、path、kind、hash、文件大小；每个 create destination / parent directory 的 initial absence；move/trash 的 source/destination mapping。 |
| `expectedAfterSet` | 每个 path 在成功后应为 absent 或 exact bytes/hash，供 rollback 的 compare-before-restore 及 restart classification。 |
| `managedTrashEntries` | 受 Bridge 控制的 staging path、原始 path、collision nonce；不使用 opaque trash result。 |
| `postCommitVersions`, `cacheEvidence` | 成功后的 Content Versions、events/probes；只在 commit 前写入。 |

before image 必须在 preflight-after-lease 后、PREPARED 前从 authoritative `Vault.read` / attachment bytes 重读并 hash；不可复用 Agent Session 早先的 Exact Read。它把前端 edit、Frontmatter edit、derived Markdown rewrite 一律化为「恢复这个 raw bytes」，故保持原换行、Unicode、注释、quote、YAML formatting，而不是试图做逆 patch。

### 4.3 生命周期状态机

```text
preflighting -> queued -> executing/preparing -> executing/applying
    -> verifying -> cache_wait -> succeeded
                     |              |
                     v              v
                rolling_back -> rolled_back

process/plugin crash with durable PREPARED and no durable terminal frame
    -> recovering -> rolled_back | failed (writes blocked)

preflight failure -> rejected
any untrustworthy state / external divergence -> failed (writes blocked)
```

对外沿用 [Specify the Change Set contract](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/6) 的状态：`preflighting`、`queued`、`executing`、`recovering` 为 nonterminal；`succeeded`、`rolled_back`、`rejected`、`failed` 为 terminal。内部 `preparing/applying/verifying/cache_wait/rolling_back` 放入 `phase`，不创造第二套 contract。`rolled_back` 永不等于成功；`failed` 意味着 Bridge 不能证明逻辑 Vault 状态，所有后续 Change Set 必须被 gate。

### 4.4 Write-ahead / durability ordering

以下每一项「durable」都指 frame 完整写入、checksum 可验证、`sync()` 成功；不是宣称任意硬件都提供绝对断电持久性。

1. **Durably bind key。** 写 `SUBMISSION{submissionKey, fingerprint, changeSetId, state: preflighting}` 并 sync，才报告可查询的 ID；重试不会创造第二个队列项。
2. **Lease 后重验和计算闭包。** 若失败，durably 写 `REJECTED` 并 sync；没有 Vault mutation。
3. **Capture first。** 完整写入所有 before-images、absence records、expected-after hashes 与可逆 trash mapping；对 journal sync。任何 snapshot 不全或 hash 不符均不得继续。
4. **Prepare before write。** durably 写 `PREPARED`（其含完整 snapshot/plan 的 generation、`state: executing`）并 sync，**再**允许首个 `Vault` mutation。这是 WAL rule。
5. **Apply deterministic plan。** 逐项执行 create/edit/frontmatter/manual derived rewrites/move/attachment/managed-trash。可选进度 frames 仅供诊断；恢复不能依赖它们，因为崩溃可发生在 mutation 返回前或进度记录前。
6. **Verify bytes and paths。** 通过 Vault authoritative read / binary bytes 重读每个 `expectedAfterSet`，确认源消失、目标恰好存在、哈希相符。若任一失败，进入 rollback；不得 `succeeded`。
7. **Wait for cache readiness。** 第 7 节的 event + targeted probe 都通过前，写租约仍被持有，不能 ack success。
8. **Commit terminal。** durably 写 `COMMITTED{final hashes, versions, cache evidence}` 并 sync，再写状态 `succeeded`。仅在这之后允许 dequeue 下一笔。
9. **Failure path。** 对 every path 做 compare-before-restore；成功后重读 before-image、等待其 cache evidence，durably 写 `ROLLED_BACK` 并 sync，才打开队列。若 compare/restore/verify 任何一步不可信，durably 写 `FAILED`，保持全局 write gate。
10. **Clean up。** active recovery material 仅能在 durable terminal 和 retention policy 都满足后被清理/轮转；清理失败不是成功失败，不得删除仍有可能需要恢复的 slot。

崩溃发生在第 4–8 步任何位置时，下一启动把最后有效 frame 视为 active：即使没有 progress frame，也按**整套** before-image 恢复，因而覆盖「写已发生但进度未记」的不确定窗口。崩溃发生在 `COMMITTED` sync 后则按已成功状态验证，不能倒回。`COMMITTED` 前未验证成功的执行绝不被当作成功。

## 5. 混合操作的完整恢复规则

| 操作 | 正常应用 | before image / rollback |
| --- | --- | --- |
| `create_directory` / implicit parents | 仅创建 preflight 证明不存在且属于本次的目录 | 仅在空、仍由本 Change Set 创建、且 ancestor listing 未被外部改变时移除；否则 `failed`。 |
| `create_note` | 以精确 caller bytes 创建 | 记录 destination absence；只在当前仍等于 expected after bytes 时移除。 |
| `edit_body` | 先验证 target Content Version / exact anchor；写 projected raw Markdown | 保存整份原 bytes（不是 inverse patch）；只在当前 hash 等于 expected-after 时 restore bytes。 |
| `edit_frontmatter` | Bridge 的最小 format-preserving serializer 产生完整 projected bytes | 同上；所以 untouched order/indent/quotes/comments/scalars 回到 before bytes。 |
| `move` | 只同一 Vault volume；使用不触发偏好型自动 rewrite 的底层 Vault move，derived files 由计划显式修改 | snapshot source bytes、destination absence、所有 derived targets；把 content 回到 source、确认 destination 删除。 |
| derived link/embed rewrite | 预先计算 closure；每个 rewrite 是 explicit journal member | 每个 affected Markdown file 的完整 before bytes；不做「替换新链接为旧链接」猜测。 |
| `copy_attachment` | 精确 bytes 写到缺席 destination，source SHA-256 已核验 | destination absence，确认 after hash 后移除。 |
| `move_attachment` | 同卷 rename，source SHA-256 与 destination absence 已核验 | source/destination mapping + raw fallback copy；复位为 source exact bytes。 |
| `trash` | move 到仅 Bridge 拥有的 `.trash/<bridge-id>/<changeSetId>/<encoded-original-path>` staging namespace；原用户 `.trash` 必须是 protected path | namespace 内路径可知且 reversible，复位原 path 后移除 staged entry。正常 commit 后才把该条目交给保留/清理策略。 |

「managed trash」是当前 contract 需要明确的实现约束：直接 `Vault.trash(file, false)` 没有公开的反向 API/可预测目的 path，无法作为 complete rollback 的证据。若产品要求使用 Obsidian 的 opaque local trash 而不允许受控 namespace，则本研究的 complete rollback 目标不可证明，应建立阻塞决策票而不是伪造逆操作。

所有 move 都拒绝跨 volume；Microsoft 明确说跨 volume 的 `MOVEFILE_COPY_ALLOWED` 会模拟为 copy/delete，甚至 source 无法删除时仍可能成功，故不可恢复地视为单个 rename。[`MoveFileExW` flags](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)

## 6. Submission Key、record 与过期

`SubmissionRecord` 是 journal 的轻量投影：`changeSetId`、Submission Key、fingerprint、state/phase、timestamps、preview、terminal result/error、journal generation。它与 active journal 一起 durable，故请求响应丢失后 `vault_change_set_status{submissionKey}` 仍能定位同一工作。

| 时间段 | 行为 |
| --- | --- |
| `preflighting` / `queued` / `executing` / `recovering` | 永不按 TTL 删除；相同 key/fingerprint 永远返回当前 record；不同 fingerprint conflict。 |
| terminal 后的 result-retention window | 至少覆盖 MCP/HTTP 重试与人工诊断的配置窗口；相同输入返回同一 terminal result，修正计划必须使用新 key。 |
| result 到期后 | 删除大 preview/result/before-image，但保留短期 `{HMAC(key), expiry, fingerprint?}` tombstone；status 在可保留期间明确 `expired`，submit 不得把该 key 当作新工作。 |
| tombstone 到期后 | 可安全回收；status 是 `unknown`。协议要求 Agent Session 对每个新意图生成高熵新 key，禁止故意复用旧 key；此后不再承诺历史幂等。 |

这同时满足「短期 operational recovery data，不是永久 audit history」和 [Specify the Change Set contract](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/6) 的 retry 规则。retention、tombstone window、最大 active journal bytes 是配置值，必须通过 status/health 暴露且接受验收；不能静默缩短 active/recovery record。

## 7. 启动恢复与 cache readiness

### 7.1 recovery-before-writes

plugin `onload()` 的顺序是：打开 journal -> 校验 vault identity / frame checksums -> 找最后有效 generation -> 若为 `PREPARED` 且无 durable terminal，发布 `recovering` record 并独占 write gate -> classification / rollback -> raw-byte verification -> cache readiness -> 写 terminal frame -> 才启动 MCP write admission。listener 可以早起，但任何 submit 在 gate 未解除时返回 `recovery_required`（status/health/read 可按安全策略服务）。plugin unload、Vault identity 变更或 journal 无法读取也要关闭 admission；不能把内存队列当恢复 source。

如果重启时文件恰好都等于 `expectedAfterSet`，Bridge 仍不得仅凭此推定成功：没有 durable `COMMITTED` 就按恢复协议处理（通常 restore before state）。这是确保「客户端没有收到 success 就不留下未知已提交工作」的保守规则。仅在本研究第 9 节的 native durability 前提也满足时，才可把 commit frame 当为强断电确认。

### 7.2 cache-ready 是观测谓词，不是单一事件

写后 Bridge 应在 mutate **之前** 注册相关路径的事件观察，并对每个路径带 expected hash/version correlation：

1. create/modify/derived rewrite：等待 `metadataCache.changed(file)`，再读取 `getFileCache(file)` 与 Bridge 的 `Vault.read` hash；
2. move/trash：等待 `vault.on("rename")` 的 old/new path，检查 old path 不可解析、new file/path/hash 正确；不要等待不会为 rename 触发的 `changed`；
3. link graph：等待相关 `resolve` / `resolved`，并以 `getFirstLinkpathDest`、resolved/unresolved link map 或明确的 target probes 验证本 Change Set 所声明的 derived effects；
4. 所有断言在 timeout 内通过才产生 `cacheEvidence`。超时不应假装成功：仍可等待；若必须结束请求则尝试 rollback，rollback 后仍不能证明一致性则 `failed` + write gate。

因为公共 API 没有全局 cache quiescence barrier，上述是**限定 touched paths 与 expected semantic probes**的 readiness 定义，而不是声称整个 Obsidian cache 已静止。实现前必须在已安装 Obsidian release 对事件顺序实测（第 10 节）。

## 8. 外部修改与人工介入边界

公共 API 不提供排他 Vault lock；Bridge 的 FIFO 只覆盖经它写入的请求。故任何恢复/rollback 在覆盖前均要执行 compare-before-restore：当前位置/bytes/hash 必须仍是 `expectedAfterSet`（或可证明尚未应用的 before state）。

- 若某路径已是 before state，可将该恢复步骤视为已完成。
- 若仍是 expected-after state，安全地恢复 exact before image。
- 若是第三种状态、缺失但本应存在、路径被其他对象占据、parent directory 不再满足先决条件、cache 无法收敛、journal corruption、Vault identity 不同、或权限/磁盘 I/O error：**绝不覆盖**。持久化 `FAILED/restoration_incomplete`，列出 path、expected before/after hashes、observed hash、journal generation 和建议；全局拒绝新 Change Set。

此时 Primary Operator 可在 Obsidian/备份中选择保留外部修改、手动恢复 before image、或确认已达到 intended after state；随后使用一个明确的 operator recovery/ack 流程重新扫描、重建 Content Versions 与 cache，写一个带操作者动作的 terminal frame 才重新开放 writes。该人工动作不是普通 MCP retry，也不能由 Agent Session 静默触发。

同理，preflight 和 execution 之间由队列避免 Bridge-to-Bridge race；外部修改则以第二次 version/read-dependency check 尽早拒绝。外部写在 application 中间发生时保证退化为「不丢外部内容，停止求助」，而非不可信地声称 complete rollback。

## 9. 能证明什么，尚不能证明什么

| 结论 | 证据与范围 |
| --- | --- |
| 经 Bridge 写入全局 FIFO | 一个 plugin-hosted executor、单 `enqueueSeq`、直到 terminal 才释放 lease；需代码审计/并发测试证明没有旁路 mutation。 |
| 混合 Change Set 的 process-crash all-or-restore | write-ahead complete before-images、`PREPARED` sync-before-first-write、下一启动整套 restore、compare-before-restore；仅在无外部冲突且 journal 可读时。 |
| retry 幂等 | durable `{key,fingerprint,id,state}` 先于 admission；相同请求 lookup 而非 enqueue。TTL 后范围按第 6 节下降。 |
| Obsidian 后续 Bridge reads 可见 | raw reread/hash 加 per-path documented cache events/probes；不是全局 cache barrier。 |
| 多文件原子 transaction / 无条件物理断电恢复 | **不能由 Obsidian/Node API证明。** Node sync 是 OS/device-specific，Node rename 未给 durable-rename 承诺；需 native Windows prototype 或降低承诺。 |
| 对抗外部 writer 的完整回滚 | **不能。** 无 public exclusive Vault lock；检测冲突后必须 failed + human intervention。 |
| Git rollback | **明确不使用。** Git 既不包含 Obsidian cache、也不覆盖 attachments/trash/工作树并发写，且不是本产品 transaction layer。 |

## 10. 故障注入与验收矩阵

测试 harness 应可在每个标记点终止 Obsidian process、重启 plugin，并保留 journal 和 Vault volume；每次恢复后用 raw bytes、paths、hashes、Content Versions 和 cache probes 验证。不能只 mock `Vault.modify()`。

| 类别 / 注入点 | 场景 | 必须验收的结果 |
| --- | --- | --- |
| FIFO | 两个 Agent Sessions 同时提交、首项慢、第二项依赖首项 | 只有一个 `executing`；按 durable `enqueueSeq`；第二项开始前重新验证。 |
| Key binding | response 丢失后同 key/same fingerprint retry；同 key/different fingerprint | 前者同 `changeSetId`、不重复 mutation；后者 `submission_key_conflict`。 |
| preflight | stale direct target、stale read dependency、ambiguous link、protected path、journal-size limit | `rejected`，无 Vault mutation / 无 active journal。 |
| WAL points | 在 snapshot 每 frame、`PREPARED` sync 前/后、每种 operation 前/后、verify 前/后、commit sync 前/后强杀 | 无 commit frame 时 recovery 恢复所有 before bytes/paths；commit 后仅接受 verified after state；journal 可解析或拒绝写。 |
| operation mix | create + body edit + format-sensitive frontmatter + move + link/embed rewrite + binary copy/move + managed trash | success 后 exact projected tree/hashes；任一点失败后 exact logical before tree/hashes、无遗留 staging。 |
| partial I/O | disk-full、permission denied、locked file、write/rename/read/sync error | 未确认状态不 `succeeded`；能恢复则 `rolled_back`，否则 `failed` gate。 |
| crash uncertainty | mutation 已实际完成但 progress frame 未写 | 整套 before-image rollback，不依赖 progress frame。 |
| cache | create/edit/rename/derived link 的 event 乱序、延迟/timeout | `succeeded` 前对应 evidence/probe 必须完整；rename 不依赖 `changed`；timeout 不谎报 success。 |
| external writer | apply/rollback 中修改一个 direct 或 derived target、创建 destination collision | compare mismatch；不覆盖外部 bytes；`failed/restoration_incomplete`，新写被阻塞。 |
| startup | active PREPARED、COMMITTED、损坏 tail、错误 vault identity、plugin unload/reload | 先 recovery 再 admission；tail 截断可识别；身份/不可读 journal 保持 gate。 |
| Windows persistence | NTFS 同卷、目标装置/断电或 VM hard-power-off；Node-only 与 native flush prototype 对照 | 记录卷/驱动器、loss window、journal/data survivability；任何失败禁止宣称 power-loss guarantee。 |
| retention | active record、terminal 到期、tombstone 到期、磁盘配额 | active 不清；可查 terminal 正确幂等；tombstone 返 `expired`；完全回收后按协议 `unknown`。 |

## 11. 需要关闭前的决策 / 实施门槛

1. **Managed-trash 语义确认。** 接受 Bridge 管理的可逆 `.trash/<bridge-id>/<changeSetId>/...` staging namespace，或修改 contract；若强制 opaque `Vault.trash`，complete rollback 不能宣称已解决。
2. **Windows durability prototype。** 在 Primary Operator 实际 Obsidian/Electron/Node、NTFS 卷、同步/防病毒配置下验证 `FileHandle.sync` 及进程/断电注入；如要求断电级保证，研究 native `FlushFileBuffers` / `MoveFileExW(MOVEFILE_WRITE_THROUGH)` seam，不能把 Node `rename` 当作证据。
3. **外部写策略确认。** MVP 需明确「Bridge 是唯一自动 writer」的运行约束；检测到外部冲突时停写并由 Primary Operator 解锁，而不是自动覆盖。
4. **Event-order prototype。** 固定当前安装的 Obsidian release，对 create/modify/rename/link-resolution 的 cache event/probe 条件形成可重复验收基线。

这些是把本研究从设计结论提升为实现承诺所需的验收门槛，不是产品代码任务。

## 一手来源

1. [Obsidian official public API declarations: Vault mutations/process/events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7394-L7593)
2. [Obsidian official public API declarations: MetadataCache links/events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4404-L4472)
3. [Obsidian official public API declarations: FileManager rename/trash](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2895-L2920)
4. [Obsidian official plugin API README](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/README.md)
5. [Node.js official `fs`: `FileHandle.sync`/`datasync`](https://nodejs.org/docs/latest-v26.x/api/fs.html#filehandlesync)
6. [Node.js official `fs`: `fsync`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fsfsyncfd-callback), [`rename`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fspromisesrenameoldpath-newpath), [`cp`](https://nodejs.org/docs/latest-v26.x/api/fs.html#fspromisescpsrc-dest-options)
7. [Node.js immutable promises source (`binding.rename`, `flush` → `handle.sync`)](https://github.com/nodejs/node/blob/a46087d7e8e5dfaecfdff6cb146f1b5fd2dc9411/lib/internal/fs/promises.js) and [libuv immutable Windows `uv__fs_rename` / `uv__fs_fsync` source](https://github.com/libuv/libuv/blob/c0bd247782f3a7fbb22499970c2c14ac05a46f26/src/win/fs.c)
8. [Microsoft Learn: `FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
9. [Microsoft Learn: `MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
