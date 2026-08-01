(async () => {
  const FIXTURE_DIR = "__WAYFINDER_RAW_BYTE_PROTOTYPE__";
  const FIXTURE_PATH = `${FIXTURE_DIR}/source.md`;
  const RESULT_PATH = `${FIXTURE_DIR}/last-result.json`;
  const TOKEN = "[[目标笔记|别名😀]]";
  const REPLACEMENT = "[[重命名目标|别名😀]]";
  const adapter = app.vault.adapter;

  const utf8Offset = (text, utf16Offset) => Buffer.byteLength(text.slice(0, utf16Offset), "utf8");
  const lineStart = (text, targetLine) => {
    let line = 0;
    let offset = 0;
    while (line < targetLine && offset < text.length) {
      const next = text.indexOf("\n", offset);
      if (next < 0) return -1;
      offset = next + 1;
      line += 1;
    }
    return line === targetLine ? offset : -1;
  };
  const waitForCache = (file) => new Promise((resolve, reject) => {
    let timer;
    let ref;
    const finish = (value, error) => {
      if (timer) clearTimeout(timer);
      if (ref) app.metadataCache.offref(ref);
      error ? reject(error) : resolve(value);
    };
    const ready = () => {
      const cache = app.metadataCache.getFileCache(file);
      if ((cache?.links?.length ?? 0) >= 2) {
        finish(cache);
        return true;
      }
      return false;
    };
    if (ready()) return;
    ref = app.metadataCache.on("changed", (changed) => changed.path === file.path && ready());
    timer = setTimeout(() => finish(null, new Error("Timed out waiting for two cached links")), 10000);
  });
  const locateAndVerify = (raw, decodedRaw, link) => {
    const bomShift = decodedRaw.charCodeAt(0) === 0xfeff ? 1 : 0;
    const hostStart = link.position.start;
    const hostEnd = link.position.end;
    const starts = new Set([hostStart.offset, hostStart.offset + bomShift]);
    const startOfLine = lineStart(decodedRaw, hostStart.line);
    if (startOfLine >= 0) {
      starts.add(startOfLine + hostStart.col);
      starts.add(startOfLine + hostStart.col + (hostStart.line === 0 ? bomShift : 0));
    }
    const ends = new Set([hostEnd.offset, hostEnd.offset + bomShift]);
    const endOfLine = lineStart(decodedRaw, hostEnd.line);
    if (endOfLine >= 0) {
      ends.add(endOfLine + hostEnd.col);
      ends.add(endOfLine + hostEnd.col + (hostEnd.line === 0 ? bomShift : 0));
    }
    for (const start of starts) ends.add(start + link.original.length);

    const expectedBytes = Buffer.from(link.original, "utf8");
    const candidates = [];
    for (const start of starts) {
      for (const end of ends) {
        if (start < 0 || end < start || decodedRaw.slice(start, end) !== link.original) continue;
        const byteStart = utf8Offset(decodedRaw, start);
        const byteEnd = utf8Offset(decodedRaw, end);
        if (!raw.subarray(byteStart, byteEnd).equals(expectedBytes)) continue;
        const key = `${byteStart}:${byteEnd}`;
        if (!candidates.some((candidate) => candidate.key === key)) {
          candidates.push({ key, utf16Span: [start, end], utf8Span: [byteStart, byteEnd] });
        }
      }
    }
    return {
      cached: link,
      candidateCount: candidates.length,
      mapping: candidates.length === 1 ? candidates[0] : null,
      verified: candidates.length === 1,
    };
  };

  if (await adapter.exists(FIXTURE_DIR)) throw new Error(`${FIXTURE_DIR} already exists; refusing to overwrite it`);
  await app.vault.createFolder(FIXTURE_DIR);
  const fixtureText = `﻿---\r\ntitle: 原始字节😀\r\n---\r\n前缀😀 ${TOKEN} 中间中文 ${TOKEN} 后缀\r\n`;
  const fixtureBytes = Buffer.from(fixtureText, "utf8");
  const fixtureArrayBuffer = fixtureBytes.buffer.slice(fixtureBytes.byteOffset, fixtureBytes.byteOffset + fixtureBytes.byteLength);
  const file = await app.vault.createBinary(FIXTURE_PATH, fixtureArrayBuffer);
  const cache = await waitForCache(file);
  const rawBefore = Buffer.from(await adapter.readBinary(FIXTURE_PATH));
  const decodedRaw = rawBefore.toString("utf8");
  const vaultText = await app.vault.read(file);
  const links = cache.links.map((link) => locateAndVerify(rawBefore, decodedRaw, link));

  if (links.length !== 2 || links.some((link) => !link.verified)) {
    throw new Error(`Unable to establish two unique verified spans: ${JSON.stringify(links)}`);
  }

  const secondSpan = links[1].mapping.utf8Span;
  const replacementBytes = Buffer.from(REPLACEMENT, "utf8");
  const rawAfter = Buffer.concat([
    rawBefore.subarray(0, secondSpan[0]),
    replacementBytes,
    rawBefore.subarray(secondSpan[1]),
  ]);
  const rawAfterArrayBuffer = rawAfter.buffer.slice(rawAfter.byteOffset, rawAfter.byteOffset + rawAfter.byteLength);
  await adapter.writeBinary(FIXTURE_PATH, rawAfterArrayBuffer);
  const reread = Buffer.from(await adapter.readBinary(FIXTURE_PATH));
  const prefix = rawBefore.subarray(0, secondSpan[0]);
  const suffix = rawBefore.subarray(secondSpan[1]);

  const result = {
    prototype: true,
    runtime: {
      cliReportedObsidian: "1.13.4",
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    },
    capabilities: {
      adapterConstructorMinifiedName: adapter.constructor.name,
      readBinary: typeof adapter.readBinary,
      writeBinary: typeof adapter.writeBinary,
      createBinary: typeof app.vault.createBinary,
      vaultRead: typeof app.vault.read,
    },
    fixture: {
      byteLength: rawBefore.length,
      utf16Length: decodedRaw.length,
      bomHex: rawBefore.subarray(0, 3).toString("hex"),
      crlfCount: (decodedRaw.match(/\r\n/g) ?? []).length,
      loneLfCount: (decodedRaw.replace(/\r\n/g, "").match(/\n/g) ?? []).length,
      includesCjk: /[㐀-鿿]/u.test(decodedRaw),
      includesAstralEmoji: decodedRaw.includes("😀"),
      binaryCreateExact: rawBefore.equals(fixtureBytes),
      vaultTextEqualsRawDecode: vaultText === decodedRaw,
      vaultTextStripsOnlyBom: vaultText === decodedRaw.slice(1),
    },
    links,
    rewrite: {
      targetOccurrence: 2,
      replacement: REPLACEMENT,
      firstOccurrenceUntouched: reread.includes(Buffer.from(TOKEN, "utf8")),
      exactPrefixPreserved: reread.subarray(0, prefix.length).equals(prefix),
      exactSuffixPreserved: reread.subarray(reread.length - suffix.length).equals(suffix),
      bomPreserved: reread.subarray(0, 3).toString("hex") === "efbbbf",
      crlfCountPreserved: (reread.toString("utf8").match(/\r\n/g) ?? []).length === 4,
      binaryWriteExact: reread.equals(rawAfter),
    },
  };
  result.passed =
    result.fixture.bomHex === "efbbbf" &&
    result.fixture.crlfCount === 4 &&
    result.fixture.loneLfCount === 0 &&
    result.fixture.binaryCreateExact &&
    result.fixture.vaultTextStripsOnlyBom &&
    links.length === 2 &&
    links.every((link) => link.verified) &&
    Object.values(result.rewrite).filter((value) => typeof value === "boolean").every(Boolean);

  await adapter.write(RESULT_PATH, JSON.stringify(result, null, 2));
  return result;
})()
