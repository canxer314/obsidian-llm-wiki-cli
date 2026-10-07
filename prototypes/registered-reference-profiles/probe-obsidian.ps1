$ErrorActionPreference = "Stop"

$vaultName = "ThinkFlywheelVault"
$outputPath = Join-Path $PSScriptRoot "runtime-observation.json"

$probe = @'
(async () => {
  const rootPath = "_wayfinder-reference-profile-prototype";
  const sourcePath = `${rootPath}/source.md`;
  const targetPath = `${rootPath}/targets/唯一 目标.md`;
  const movedTargetPath = `${rootPath}/moved/唯一 目标.md`;
  const attachmentPath = `${rootPath}/attachments/图 像 #1.png`;
  const movedAttachmentPath = `${rootPath}/moved/图 像 #1.png`;

  if (app.vault.getAbstractFileByPath(rootPath)) {
    throw new Error(`${rootPath} already exists; refusing to overwrite it`);
  }

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitForCache = async (path) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file && app.metadataCache.getFileCache(file)) return file;
      await sleep(50);
    }
    throw new Error(`Metadata cache timeout for ${path}`);
  };
  const compactPos = (pos) => pos ? {
    start: pos.start,
    end: pos.end,
  } : null;
  const compactLink = (link) => ({
    link: link.link,
    original: link.original,
    displayText: link.displayText,
    position: compactPos(link.position),
  });
  const compactCache = (cache) => ({
    links: (cache.links ?? []).map(compactLink),
    embeds: (cache.embeds ?? []).map(compactLink),
    frontmatterLinks: (cache.frontmatterLinks ?? []).map(compactLink),
    referenceLinks: (cache.referenceLinks ?? []).map(compactLink),
    headings: (cache.headings ?? []).map((heading) => ({
      heading: heading.heading,
      level: heading.level,
      position: compactPos(heading.position),
    })),
    blocks: Object.fromEntries(Object.entries(cache.blocks ?? {}).map(([id, block]) => [id, {
      id: block.id,
      position: compactPos(block.position),
    }])),
  });
  const resolve = (linkpath) => app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
  const sampleResolutions = () => Object.fromEntries([
    "targets/唯一 目标",
    "targets/唯一 目标.md",
    "唯一 目标",
    "同名",
    "attachments/图 像 #1.png",
    "attachments/图 像 %231.png",
    "attachments/图%20像%20%231.png",
    "attachments/图 像 ",
    "图 像 #1.png",
  ].map((linkpath) => [linkpath, resolve(linkpath)]));

  const source = `---
related: "[[targets/唯一 目标|属性别名]]"
related_heading: "[[targets/唯一 目标#章节]]"
related_list:
  - "[[targets/唯一 目标]]"
  - "[[attachments/图 像 #1.png]]"
  - "[[attachments/图 像 %231.png]]"
markdown_related: "[属性文本](targets/唯一%20目标.md#章节)"
attachment: "[[attachments/图 像 #1.png]]"
attachment_encoded: "[[attachments/图 像 %231.png]]"
---

[[targets/唯一 目标#章节|维基别名]]
![[attachments/图 像 #1.png|320]]
![[attachments/图 像 %231.png|321]]
[行内](targets/唯一%20目标.md#章节 "行内标题")
![图片](<attachments/图 像 #1.png> "图片标题")
![编码图片](attachments/图%20像%20%231.png "编码标题")
[参考链接][唯一-id]

[唯一-id]: <targets/唯一 目标.md#章节> "参考标题"
`;
  const target = `# 章节

第一处。

# 重复

第一处重复。

# 重复

第二处重复。

稳定块。 ^stable-block
`;

  const observation = {
    probeVersion: 1,
    runtime: {
      obsidianVersion: app.vault.getConfig?.("version") ?? null,
      appVersion: app.version ?? null,
      vaultName: app.vault.getName(),
      platform: navigator.platform,
      automaticLinkUpdatePreference: app.vault.getConfig?.("alwaysUpdateLinks") ?? null,
    },
    fixture: {
      rootPath,
      sourcePath,
      targetPath,
      attachmentPath,
      source,
      target,
    },
  };

  try {
    await app.vault.createFolder(rootPath);
    await app.vault.createFolder(`${rootPath}/targets`);
    await app.vault.createFolder(`${rootPath}/duplicates-a`);
    await app.vault.createFolder(`${rootPath}/duplicates-b`);
    await app.vault.createFolder(`${rootPath}/attachments`);
    await app.vault.createFolder(`${rootPath}/moved`);
    await app.vault.create(targetPath, target);
    await app.vault.create(`${rootPath}/duplicates-a/同名.md`, "# 甲\n");
    await app.vault.create(`${rootPath}/duplicates-b/同名.md`, "# 乙\n");
    await app.vault.createBinary(attachmentPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer);
    await app.vault.create(sourcePath, source);

    const sourceFile = await waitForCache(sourcePath);
    const targetFile = await waitForCache(targetPath);
    observation.beforeMove = {
      sourceRaw: await app.vault.read(sourceFile),
      sourceCache: compactCache(app.metadataCache.getFileCache(sourceFile)),
      targetCache: compactCache(app.metadataCache.getFileCache(targetFile)),
      resolvedLinks: app.metadataCache.resolvedLinks[sourcePath] ?? {},
      unresolvedLinks: app.metadataCache.unresolvedLinks[sourcePath] ?? {},
      resolutions: sampleResolutions(),
    };

    await app.vault.rename(targetFile, movedTargetPath);
    const attachmentFile = app.vault.getAbstractFileByPath(attachmentPath);
    await app.vault.rename(attachmentFile, movedAttachmentPath);
    await sleep(500);

    const movedSourceFile = await waitForCache(sourcePath);
    observation.afterMove = {
      sourceRaw: await app.vault.read(movedSourceFile),
      sourceCache: compactCache(app.metadataCache.getFileCache(movedSourceFile)),
      resolvedLinks: app.metadataCache.resolvedLinks[sourcePath] ?? {},
      unresolvedLinks: app.metadataCache.unresolvedLinks[sourcePath] ?? {},
      oldResolutions: sampleResolutions(),
      newResolutions: {
        "moved/唯一 目标": resolve("moved/唯一 目标"),
        "moved/唯一 目标.md": resolve("moved/唯一 目标.md"),
        "moved/图 像 #1.png": resolve("moved/图 像 #1.png"),
      },
    };

    observation.inferences = {
      fixtureCorpusSha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(observation.fixture))))).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      sourceChangedByVaultRename: observation.beforeMove.sourceRaw !== observation.afterMove.sourceRaw,
      cacheCategoriesPresent: Object.fromEntries(
        ["links", "embeds", "frontmatterLinks", "referenceLinks"].map((category) => [
          category,
          observation.beforeMove.sourceCache[category].length,
        ]),
      ),
      duplicateBasenameHostWinner: observation.beforeMove.resolutions["同名"],
      duplicateHeadingCount: observation.beforeMove.targetCache.headings.filter((heading) => heading.heading === "重复").length,
      blockIds: Object.keys(observation.beforeMove.targetCache.blocks),
    };

    const bytes = new TextEncoder().encode(JSON.stringify(observation));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  } finally {
    const root = app.vault.getAbstractFileByPath(rootPath);
    if (root) await app.vault.delete(root, true);
  }
})()
'@

$result = & obsidian "vault=$vaultName" eval "code=$probe"
if ($LASTEXITCODE -ne 0) {
  throw "Obsidian runtime probe failed: $result"
}

$encodedLine = $result | Where-Object { $_ -match '^=> ' } | Select-Object -Last 1
if (-not $encodedLine) {
  throw "Obsidian CLI returned no encoded result: $result"
}

$encoded = $encodedLine -replace '^=>\s*', ''
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
$observation = $json | ConvertFrom-Json
$observation.runtime.obsidianVersion = (& obsidian "vault=$vaultName" version).Trim()
$observation | ConvertTo-Json -Depth 30 | Set-Content -Path $outputPath -Encoding utf8

Write-Output "Runtime observation written to $outputPath"
