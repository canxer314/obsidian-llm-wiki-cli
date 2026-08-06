# Issue #16 运行时验证：Obsidian 引用状态、probe 与决议边界

**研究日期：** 2026-08-06

**对应票：** [Issue #16 — Specify registered reference grammar and renderer profiles](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/16)

**审阅对象：** [PR #19](https://github.com/canxer314/obsidian-llm-wiki-cli/pull/19)（提交 `0f7ea77c516bb4fd10dea73513c20e07b1914dfc`）及其 `DECISION.md`、`runtime-observation.json`、`probe-obsidian.ps1`、`profiles.mjs`、`tui.mjs`；[Issue #12](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12)；分支 `prototype/raw-byte-source-span`。

## 结论

Issue #16 的主要运行时 snapshot 并非虚构，但 resolution 对其中若干事实作了过强推论：

1. **同 basename 场景属于 B：observation 正确，inference 错误。** 当前 Obsidian 1.13.4 中，`getFirstLinkpathDest`、`resolvedLinks`、Outgoing links UI、点击导航与 Backlinks UI 全部把 `[[同名]]` 解释为同一个 A 目标。Vault Operation Bridge 不应仅因还存在 B 候选就建立第二套解释并拒绝该引用。
2. **Frontmatter/reference-style 的 cache 结构 observation 正确，但“不支持安全重写”的 inference 未被证明。** 缺 `Pos` 或缺 `original` 只要求 Exact Read + registered grammar + byte-verified spans；raw-byte prototype 已证明 BOM、CRLF、Unicode 和重复链接文本可以安全区分与局部重写。
3. **literal `#` attachment 的当前运行时限制得到 UI 支持。** direct lookup 能找到完整文件，但 graph 与 Outgoing UI 把 linkpath 截在 `#` 前，编辑器显示找不到。它足以限制 `obsidian-1.13.4/windows-v1` profile，不足以声称跨版本永久 grammar。
4. **move 结论测错了接口范围。** PR probe 调用 `Vault.rename()`；官方明确把依 preference 更新 links 的能力放在 `FileManager.renameFile()`。历史“源码没变”可以是正确的 `Vault.rename` observation，却不能证明 automatic-link-update UI/FileManager 行为。
5. **Issue #12 目前不需要引用重写类核心 error code。** `reference_target_ambiguous` 已被当前 UI 证据否定；`reference_rewrite_unsupported` 没有具体、不可由 Exact Read + grammar + raw spans 解决的失败输入。

## 1. 证据边界

| 标签 | 含义 | 本次证据 |
| --- | --- | --- |
| **P（primary）** | Obsidian 官方帮助或官方 `obsidian-api` 声明。 | 有 |
| **O（observation）** | PR #19 历史 JSON 或本次 app/cache/CLI 读数。 | 有 |
| **U（UI）** | 实际 Obsidian 编辑器、Outgoing links、Backlinks DOM 和点击导航。 | 有；由 CLI 驱动当前 UI 并读取 DOM，仍建议 Primary Operator 目视复核 |
| **I（inference）** | 从 P/O/U 推出的 Bridge 规则、renderer/profile 或 error code。 | 逐项审计 |

本报告采用 `CONTEXT.md` 的固定含义：**Vault Operation Bridge** 服务 Primary Operator 当前 Obsidian 所解释的 ThinkFlywheel Vault；**Exact Read** 与 **Content Version** 指精确 source 状态，不是 metadata cache 的别名。

## 2. 当前环境与复现方法

本次基线：

- Obsidian `1.13.4 (installer 1.12.4)`；
- Windows；ThinkFlywheelVault；
- `alwaysUpdateLinks=true`；
- 当前启用 13 个社区插件，因此“版本一致”不等于插件环境受控；
- 原始 fixture `_wayfinder-reference-profile-prototype/` 和 UI fixture `_wayfinder-reference-profile-ui-probe/` 在执行前均不存在，执行后均已删除并再次确认不存在。

先审阅原始 probe，确认它：

- 创建前拒绝覆盖已有 `_wayfinder-reference-profile-prototype/`；
- 所有 create/rename 都限制在该目录；
- JavaScript `finally` 尝试递归删除该目录。

随后运行原始 probe。调用 120 秒内未返回，外层命令被终止；fixture 留在 Vault。残留快照显示 source/target file cache 已产生，但 source 尚无 `resolvedLinks` 或 `unresolvedLinks` 条目，且目标还未 move。手工删除本次明确由 probe 创建的专用根目录后，再次确认不存在。

这次失败不能证明 Obsidian graph 卡住，因为后续最小 fixture 的 graph 很快收敛；它至少证明两点：

1. `waitForCache` 只等待 `getFileCache(file)`，不等价于 link graph 收敛；
2. 外层 CLI 被终止时，应用内 JavaScript `finally` 不保证已经完成，故“任何失败均清理”是过强安全声明。

## 3. 一手 API 资料支持的范围

### 3.1 Link resolution 与 metadata cache

官方把 `MetadataCache.getFirstLinkpathDest(linkpath, sourcePath)` 定义为取得 linkpath 的 **best match**，返回一个 `TFile` 或 `null`；它不公开候选集合、唯一性证明或 best-match 排序规则。[官方 `MetadataCache` 声明](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4404-L4471)

官方 cache 类型也支持历史 JSON 记录的结构：

- 普通 link/embed 是含 `original` 与 `position` 的 `ReferenceCache`；
- `FrontmatterLinkCache` 没有 position；
- `ReferenceLinkCache` 只有 `id`、`link` 与 `position`，没有普通 reference 的完整 `original`/title-style。

来源：[官方 cache 类型](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L1402-L1464) 与 [reference 类型](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L5319-L5360)。这些字段可作为“Obsidian 识别过什么”的输入，不能单独证明 source byte span、definition/usages 配对或 UI 目标。

官方事件提供 `changed`、`resolve`、`resolved`；`resolve` 表示一个文件已经写入 `resolvedLinks`/`unresolvedLinks`，`resolved` 表示所有文件完成 resolution。[官方 MetadataCache events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4446-L4471) PR probe 没有等待或记录这些事件。

### 3.2 `Vault.rename` 与 `FileManager.renameFile`

官方 `Vault.rename()` 文档明确提示：若需要按用户偏好自动更新 links，应使用 `FileManager.renameFile()`；后者才承诺安全 rename/move 并依据 preference 更新 links。[`Vault.rename`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7466-L7474) [官方 `FileManager.renameFile`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2895-L2902)

因此 PR 的 move observation 只回答“直接调用 Vault API rename 会怎样”，没有回答 Primary Operator 在 UI 中移动文件或 `FileManager.renameFile` 会怎样。

## 4. 十项观察逐项判定

| # | 场景 | 本次观察 | 判定 | 可支持的推论 |
| --- | --- | --- | --- | --- |
| 1 | `getFirstLinkpathDest("同名")` | 历史与当前均选择 `a/同名.md`。 | **B** | host 会选择 best match；不能据此要求 Bridge 独立候选唯一。 |
| 2 | UI 正链/反链/导航 | 当前 Outgoing UI 显示 `同名` → `.../a`；点击打开 A；A Backlinks=1，B=0；`resolvedLinks` 也指向 A。 | **B** | 当前 UI 与 API 一致，resolution 的 duplicate-basename rejection 被具体反证。 |
| 3 | cache 分类结构 | `links`、`embeds`、`frontmatterLinks`、`referenceLinks` 历史结构与官方类型一致；本次残留 cache 也复现字段结构。 | **C（仅结构）** | 可用于 registered inventory；不自动提供 raw spans 或 UI 等价合同。 |
| 4 | Frontmatter 无 `Pos` | 仍成立；但 raw-byte prototype 证明 host locator 可转成独立 byte-verified span，重复文本不是自动失败。 | **B** | 需要 parser/Exact Read；不能推出 `reference_rewrite_unsupported`。 |
| 5 | Reference-style 仅 definition position | 历史 observation 与官方类型一致。PR 没测试 shared usages、duplicate/shadow definitions 或完整 source grammar。 | **B / 未完成** | 需要独立 definition/use parser；尚无不可安全定位反例。 |
| 6 | heading/block/occurrence | duplicate headings=2、ASCII `stable-block` 在 cache 中是正确 O；Unicode block 与 section occurrence 未进入 runtime/UI fixture。 | **结构 C；renderer I 未验证** | cache inventory 限制 target validation；不能据此完整划定 renderer profile。 |
| 7 | literal `#` attachment | direct lookup 找到完整文件；graph/Outgoing UI 截为 `attachments/图 像 ` 并 unresolved；编辑器显示找不到。 | **C（当前 profile）** | 1.13.4 profile 应 fail closed，不猜 escape；需版本化，不推广为通用语法。 |
| 8 | Vault API move 后源码 | 历史 JSON 记录 `Vault.rename` 后文本未变；当前完整 probe 未能走到 move。接口本身不负责 preference-controlled link update。 | **O 可成立，I 错误** | 显式 Change Set 可作为产品策略；不能用该 probe 描述 UI/FileManager。 |
| 9 | cache/graph 收敛 | 原 probe before 只等 file cache；after 固定 sleep 500 ms。本次实际捕获 file cache 已有而 graph map 尚无 entry。 | **A（对“已等待收敛”的隐含前提）** | 历史 JSON 是 snapshot，不能靠脚本结构证明稳定态。 |
| 10 | 版本/插件/设置 | Obsidian 与偏好和历史一致；插件 inventory 未被历史 artifact 记录或隔离。 | **未完成** | 可报告“相同 app version 下部分可复现”，不能声称环境完全相同。 |

## 5. UI 证据详情

最小 fixture：

```text
_wayfinder-reference-profile-ui-probe/
├── a/同名.md
├── b/同名.md
├── attachments/图 像 #1.png
└── source.md
```

`source.md`：

```markdown
[[同名]]
![[attachments/图 像 #1.png]]
```

同一 source Content Version 下取得：

1. **Source：** 上述两行没有 mutation；
2. **Cache/graph：** `resolvedLinks[source] = {a/同名.md: 1}`，`unresolvedLinks[source] = {"attachments/图 像 ": 1}`；
3. **Outgoing UI：** “当前笔记中的链接 2”，内容为 `同名` + subtext `_wayfinder-reference-profile-ui-probe/a`，以及 unresolved `attachments/图 像 `；
4. **导航：** 在 Outgoing UI 对 `同名` 触发真实 click 后，active file 是 `a/同名.md`；
5. **Backlinks UI：** A 显示“链接当前文件 1”，B 显示“链接当前文件 0”；
6. **编辑器：** `同名` 渲染为链接，attachment 显示“找不到 ‘attachments/图 像 #1.png’”。

这些 U 证据已经回答 duplicate basename 的产品问题。仍建议 Primary Operator 对相同截图/状态作目视确认，因为 DOM 驱动不能代替操作者对界面的最终验收。

## 6. Raw-byte source-span 证据

`prototype/raw-byte-source-span` 的现有 runtime 结果与本次复跑报告证明：

- `adapter.readBinary` / `writeBinary` / `Vault.createBinary` 能保持精确 bytes；
- `Vault.read()` 会剥离 UTF-8 BOM，因此不能作为 Exact Read 的 byte source；
- fixture 同时覆盖 UTF-8 BOM、CRLF、CJK、astral emoji 和两个完全相同的 wikilink spelling；
- 两个 cache position 各自映射成唯一、byte-verified UTF-8 span；
- 只重写第二个 occurrence 后，第一处、prefix、suffix、BOM 与 CRLF 全部保持。

这具体否定“重复 reference text 自动导致 source span 不唯一”。它尚未完成 handoff 所列 frontmatter/reference-style corpus：

- 相同 frontmatter reference 单次/多次；
- YAML quoting/list variants 与正文同字面非引用；
- 多 usages 共用 definition；
- duplicate/shadow definition；
- cache query 与 Exact Read 间 Content Version 改变。

正确结论是“这些 grammar fixture 仍需验证”，不是“cache 缺 `Pos` 已证明不能安全重写”。

## 7. Issue #12 taxonomy

按三个删减问题：

| 候选 code | Claude Code 会采取不同动作吗？ | 没有它会导致错误副作用吗？ | 是否只是 debug details？ | 结论 |
| --- | --- | --- | --- | --- |
| `reference_target_ambiguous` | 当前 UI 已明确选择 A，不应改成拒绝。 | 反而可能错误阻止与 UI 一致的 move。 | 额外 basename candidates 可作 diagnostics。 | **删除/不保留** |
| `reference_rewrite_unsupported` | 尚无不可由 Exact Read + grammar + spans 解决的具体输入。 | 未被证明。 | cache 字段不足属于 parser diagnostics。 | **暂不保留** |
| `source_span_not_unique` / `reference_definition_unpaired` | 未来遇到具体 fail-closed 输入时可能影响动作。 | 目前 corpus 未给出该输入。 | 当前应留在 profile/parser 内部。 | **不是当前 core taxonomy** |

这不重开 Issue #12 已收敛的 `expectedContentVersion`、`replace_exact` 唯一匹配、`exact_match_count_mismatch` 与 `actualOccurrences`。

## 8. 对 Issue #16 resolution 的建议修正

不修改 GitHub issue 的前提下，本次证据支持未来将 resolution 改写为：

1. Obsidian 当前 UI/graph 对 registered reference 的解释是目标权威；Bridge 通过 Obsidian backlinks/outgoing/resolution 接口取得该状态。
2. 独立 candidate 枚举只用于 diagnostics、renderer 的“新 spelling 是否仍指向原目标”验证，以及发现 host/UI 不一致后的调查；它不能因第二个 basename 存在而推翻当前 UI 目标。
3. profile registration 分离三项能力：runtime target interpretation、source grammar/span location、renderer style preservation。某一 cache 字段不足不能自动变成产品级 rewrite error。
4. cache observation、Exact Read 和 write 必须属于同一 source Content Version（或等价 bytes digest/CAS）；版本不同即重新查询或拒绝 Change Set，不能把旧 cache array 与新 raw occurrences 按顺序 zip。
5. move acceptance corpus 分开测试 `Vault.rename`、`FileManager.renameFile` 与 UI move，并对 `alwaysUpdateLinks` true/false 分别记录 source bytes、graph 与 UI。
6. graph 验收必须等待 `resolve`/`resolved` 或明确的 per-source 收敛谓词；固定 sleep 只能作 timeout，不能作成功证明。

## 9. 尚需 Primary Operator 完成的 HITL 检查

本次已用 UI DOM 与 click 自动取得证据，但下列项目仍需人工目视签字，避免自动化循环证明自身：

- [ ] 目视确认 `source.md` 中点击 `[[同名]]` 打开 A，而非 B；
- [ ] 目视确认 Outgoing links 显示 A；
- [ ] 目视确认 A Backlinks 有 source、B 没有；
- [ ] 点击刷新/重载 cache 后重复上述三项，记录是否变化；
- [ ] 对 duplicate heading、ASCII/Unicode block 分别点击并记录导航位置；
- [ ] 对 literal `#` attachment 记录编辑器、Outgoing、Backlinks 与导航结果；
- [ ] 分别用 UI move / `FileManager.renameFile` 与 `Vault.rename`，在 preference true/false 下记录 Exact Read bytes 和 UI。

## 10. 安全与残留说明

本次主验证创建的 `_wayfinder-reference-profile-prototype/` 与 `_wayfinder-reference-profile-ui-probe/` 均已删除并确认不存在。

独立 raw-byte 验证在 `__WAYFINDER_RAW_BYTE_PROTOTYPE__/` 留下 `source.md` 与 `last-result.json`；其执行会话的清理动作被权限策略拒绝。主会话没有代为删除，以免绕过已拒绝权限。它们是已知测试 fixture，不是本报告的产品输入；Primary Operator 应在确认后删除或移入 Obsidian trash。

## 一手来源与 artifacts

1. [Obsidian 官方链接帮助](https://obsidian.md/help/links)。
2. [Obsidian 官方 `MetadataCache` 声明](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L4404-L4471)。
3. [Obsidian 官方 cache/reference 类型](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L1402-L1464)。
4. [Obsidian 官方 `Vault` mutation/events](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L7410-L7592)。
5. [Obsidian 官方 `FileManager.renameFile`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2895-L2902)。
6. [Issue #16](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/16) 与 [resolution](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/16#issuecomment-5152196482)。
7. [PR #19](https://github.com/canxer314/obsidian-llm-wiki-cli/pull/19)：[DECISION](https://github.com/canxer314/obsidian-llm-wiki-cli/blob/0f7ea77c516bb4fd10dea73513c20e07b1914dfc/prototypes/registered-reference-profiles/DECISION.md)、[observation](https://github.com/canxer314/obsidian-llm-wiki-cli/blob/0f7ea77c516bb4fd10dea73513c20e07b1914dfc/prototypes/registered-reference-profiles/runtime-observation.json)、[probe](https://github.com/canxer314/obsidian-llm-wiki-cli/blob/0f7ea77c516bb4fd10dea73513c20e07b1914dfc/prototypes/registered-reference-profiles/probe-obsidian.ps1)、[TUI](https://github.com/canxer314/obsidian-llm-wiki-cli/blob/0f7ea77c516bb4fd10dea73513c20e07b1914dfc/prototypes/registered-reference-profiles/tui.mjs)。
8. [`prototype/raw-byte-source-span`](https://github.com/canxer314/obsidian-llm-wiki-cli/tree/prototype/raw-byte-source-span/prototypes/raw-byte-source-span-prototype)。本次独立复核详见 [`issue-16-raw-byte-source-span-validation.md`](issue-16-raw-byte-source-span-validation.md)。
9. [Issue #12](https://github.com/canxer314/obsidian-llm-wiki-cli/issues/12)。
