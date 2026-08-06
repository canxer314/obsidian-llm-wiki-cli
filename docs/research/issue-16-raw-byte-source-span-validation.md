# Issue #16：raw-byte source-span 对 frontmatter/reference-style 推论的核验

**核验对象：** `prototype/raw-byte-source-span`（`11e1ffb`）与已存在的 registered-reference prototype 的决议/运行时 artifact。  
**范围限制：** 未重新查询 Obsidian 官方 API，也未重新读取或修改 GitHub Issue/PR；未修改产品代码或 GitHub。

## 结论

`11e1ffb` 为「带 `MetadataCache` position 的正文 wikilink」提供了一个有效的、运行时复现的 raw-byte 映射证据：在 UTF-8 BOM、CRLF、CJK、astral emoji 以及两个完全相同的正文 wikilink 同时存在时，两个 cache entry 都各自映射到唯一、经原始 UTF-8 bytes 验证的 span，并且只改写第二项时保留第一项、前后缀、BOM 和 CRLF。

但它**没有验证** Issue #16 中最关键的两项条件 profile：无 `position` 的 `frontmatterLinks`，以及缺 `original`/样式的 `referenceLinks` definition。因此不能把本分支的通过结果外推为「frontmatter/reference-style 已可安全定位」；同样，不能反过来仅从 `frontmatterLinks.position === null` 推出 `source_span_not_unique`、`reference_rewrite_unsupported` 或 profile 必须 unsupported。

在冻结同一份 source raw bytes 的前提下，本次没有找到一个被证据证明「registered grammar + Exact Read + raw-byte spans 必然无法安全定位」的具体 frontmatter/reference-style 输入。**缺少 cache `Pos` 不足以推出 unsupported。** 正确的下一步是为两类 profile 添加原始字节 fixture 和一对一的 raw grammar 验证，而不是新增 unsupported taxonomy。

当前唯一明确的安全缺口是**Content Version race 尚未测试/实现为前置条件**。这不是缺 `Pos` 导致的静态 source-span 反例，而是 cache observation 和 Exact Read 不属同一内容版本时，任何基于二者配对的实现都不能安全提交写入。

## 已读 artifact 与其实际证明范围

| 证据 | 实际证明 | 没有证明 |
| --- | --- | --- |
| `prototypes/raw-byte-source-span-prototype/validation-eval.js` | 使用 `adapter.readBinary` / `writeBinary` / `Vault.createBinary` 维持 fixture bytes；`Vault.read()` 会剥去 BOM；有 position 和 `original` 的 `cache.links` 能由 UTF-16 host coordinates 转为唯一、byte-verified UTF-8 spans。 | frontmatter 无 position 时如何枚举/配对；reference definition 缺 `original` 时如何解析样式及 byte-verify。 |
| `prototypes/raw-byte-source-span-prototype/last-result.txt` | 历史运行结果显示两个 cache links 的 UTF-8 spans 为 `49:76` 与 `90:117`，都 `candidateCount: 1`。 | 这不是 frontmatter/reference-style fixture。 |
| `prototypes/raw-byte-source-span-prototype/README.md` | 明确把分支定位为 diagnostic prototype，并将其边界表述为「MetadataCache source locations」到 raw spans。 | README 的一般性表述不能扩大测试类别；实际 code 只读取 `cache.links`。 |
| `prototypes/registered-reference-profiles/DECISION.md` | 将 frontmatter/reference-style registration 明确写成以 runtime observation 与 raw-byte adapter proof 为条件的 profile；未知 YAML shape、unpaired/multiply-defined labels 需要拒绝。 | 尚无针对两类 profile 的 raw-byte acceptance fixture，故条件尚未满足。 |
| `prototypes/registered-reference-profiles/profiles.mjs` | 纯 parser 能处理 wikilink/inline 的 style slices；`markdownReferenceUse` 直接返回 `reference_definition_requires_runtime_pairing`。 | 并未实现 reference definition pairing/rewriting，也未实现 YAML raw grammar。 |

因此，「frontmatter cache 没有 `Pos`，所以无法安全绑定 raw span」是**观察到正确、逻辑推论未成立**；raw-byte prototype 仅为有 `Pos` 的正文链接提供正面机制证据，尚不能把条件 profile 宣布为已注册。

## 已运行的已有验证

在 Obsidian renderer context 中，以分支 `11e1ffb` 的原样 `validation-eval.js` 执行现有运行时 fixture。输出 `passed: true`，环境为 Obsidian CLI `1.13.4`、Electron `39.6.0`、Node `22.22.0`、Windows。

通过断言包括：

- fixture `binaryCreateExact: true`，BOM `efbbbf`，4 个 CRLF、0 个 lone LF；
- `Vault.read()` 不等于 raw decode、但等于去 BOM 后的 decode；
- 两个相同 `[[目标笔记|别名😀]]` 均各有一个 byte-verified mapping；
- 第二项改写后 `firstOccurrenceUntouched`、exact prefix/suffix、BOM、CRLF 与 binary write 均为 true。

执行的是 fixture evaluator 本身而非 `run.ps1` wrapper；wrapper 的附加职责是将输出写入分支 artifact 并在 `finally` 删除隔离 fixture。因 evaluator 本身不含 `finally`，本次留下 `C:\Obsidian\ThinkFlywheelVault\__WAYFINDER_RAW_BYTE_PROTOTYPE__\source.md` 和 `last-result.json`。随后依照已有 runner 的已知 cleanup 尝试删除时，被权限策略以「用户仅授权写报告」拒绝；未绕过该拒绝。它们是本次 evaluator 创建的已知隔离 fixture，需用户明确授权后由 runner/操作者清理。

## 对 handoff 第 100–109 行 fixture 要求的逐项对照

| 要求 | 覆盖状态 | 证据与缺口 |
| --- | --- | --- |
| 相同 frontmatter reference 出现一次和多次 | 未覆盖 | raw-byte fixture 的 frontmatter 只有 `title`，两次相同 token 都在正文 `cache.links`。registered-runtime artifact 虽含重复的 frontmatter spelling，但没有 source-span rewrite/assertion。 |
| 同一目标使用不同 YAML quoting/list style | 部分观察，未作定位验证 | runtime observation 含双引号 scalar 与 block list；未覆盖 plain/single-quote/flow collection/block scalar 等，也没有 raw-byte span 判定。 |
| 正文中相同字面文本但不是 registered reference | 未覆盖 | 两处相同正文文本均为 cache-recognised wikilink；没有 prose/code/YAML string 的负例。 |
| reference-style 多个 usages 共用一个 definition | 未覆盖 | observation 只有一个 use 和一个 definition；纯 parser 仍拒绝 definition pairing。 |
| 重复或 shadow definition | 未覆盖 | DECISION 已要求 multiply-defined label 拒绝，但没有 fixture、cache-to-raw pairing 或 byte-preservation test。 |
| CRLF、UTF-8 BOM、非 ASCII path | 部分覆盖 | BOM、纯 CRLF、CJK 和 emoji 均通过 raw-byte test；source filename 是 ASCII `source.md`，没有 non-ASCII source path。Unicode token/target text 不能替代该路径 case。且测试仍只覆盖正文 `links`。 |
| cache query 到 Exact Read 间 source 改变 | 未覆盖 | `waitForCache` 只等到 `links.length >= 2`，随后直接 `readBinary`；无受控编辑、无 source Content Version/digest precondition、无 retry/fail-closed assertion。 |

## frontmatter/reference-style 的安全判定

### Frontmatter

`runtime-observation.json` 的 `frontmatterLinks` 确实记录 `position: null`，并携带 `original`；这只能说明 cache entry 不能作为 source locator。若实现先对冻结 raw frontmatter 做受限 YAML grammar 扫描，再对每个 registered token 验证 token bytes、解析其 destination 并按 source path 解析目标，则它可以枚举全部相同 token，而无需把「第 N 个 cache entry」脆弱地对应到「第 N 个 raw occurrence」。同一 token 多次出现时，针对同一 move rewrite 所有经过解析和 resolution 验证的 occurrences 是可定义的；它不是 `replace_exact` 的单 occurrence 合同。

应维持已有限制：未在 profile grammar 中定义的 YAML shape 不是「定位失败」，而是 `frontmatter_shape_unsupported` 的明确 profile 边界。要将已观察的 scalar/list shape 加入 profile，仍需补上上述 byte fixture。

### Reference-style

artifact 显示 `referenceLinks` 给出 definition 的 position，但没有 `original` 或 title style；这要求从冻结 raw source 根据 reference-definition grammar 解析 definition、取 destination component 并 byte-verify，而不是把 cache field 缺失解读为不可定位。多个 usages 共用 definition 时，move closure 应改写一次 definition；不是一次改写每个 usage。

重复/shadow label 是不同的问题：应先由 raw grammar 发现并明确 reject `reference_definition_unpaired`/multiply-defined label（或者先有安装 runtime 的已验证语义再注册），而不是把不清楚的 label semantic 伪装成 universal source-span failure。

### Content Version race：具体的未覆盖危险序列

以下不是冻结输入无法定位的证明，却是本分支尚未防住的实际状态序列：

```markdown
# C0：cache query 时
---
related:
  - "[[A]]"
  - "[[B]]"
---

# C1：Exact Read 前另一写入将两个 scalar 调换
---
related:
  - "[[B]]"
  - "[[A]]"
---
```

如果实现将 C0 的无 position cache array 与 C1 的 raw occurrences 按顺序 zip，会把 stale `A` 绑定到当前的 `B` span。对于 reference definitions，调换相同 label 的 shadow definitions 也存在同类 cache/raw 脱节。安全算法不应依赖这种 zip；更根本地，必须使 cache observation、Exact Read 和后续 write 使用同一个 source Content Version（或等价 bytes digest/compare-and-swap），版本不同即重新查询或拒绝 Change Set。本分支没有这个 gate，故它不能作为 race safety evidence。

## 建议的最小接受门槛

在宣称两个条件 profile 可 rewrite 之前，新增而非泛化现有 fixture：

1. BOM + CRLF + non-ASCII **source path** 的 frontmatter fixture，覆盖相同 spelling 的一次/多次、double/single/plain quotes、block/flow list，并包含正文 lookalike 负例；对每一个 raw span 的 destination rewrite 验证 byte preservation。
2. 一个 reference-style fixture，含多个 usages 共用一个 definition；另以重复与 shadow definitions 验证确定性 reject，不产生写入。
3. 在取得 cache 后、Exact Read 前受控改写 source；assert Content Version mismatch 使 Change Set fail closed/retry，绝不按 array order 配对。

在这些通过前，保持 decision 的「conditional」措辞是合适的；不应因无 `Pos` 新增 `reference_rewrite_unsupported`，也不应把 raw-byte branch 的正文成功当作 frontmatter/reference-style 的 registration proof。
