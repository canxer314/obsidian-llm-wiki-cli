import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  capturePath,
  initializeJournal,
  readLatestFrame,
  renameSynced,
  restorePath,
  writeFrame,
  writeSynced,
} from "./journal.mjs";

const root = process.argv[2];
const crashAt = process.argv[3] ?? "none";
const vaultIdentity = process.argv[4];
const mutationKind = process.argv.find((arg) => arg.startsWith("--kind="))?.slice(7) ?? "modify-markdown";
const journalDir = join(root, ".journal");
const marker = join(root, "child-events.jsonl");

async function event(kind, detail = {}) {
  await appendFile(marker, JSON.stringify({ at: Date.now(), kind, ...detail }) + "\n", "utf8");
}

function crash(point) {
  if (crashAt === point) process.kill(process.pid, "SIGKILL");
}

async function footprint(path, afterBytes) {
  const before = await capturePath(path);
  const after = afterBytes === null
    ? { exists: false, bytes: null, sha256: null }
    : await stateForBytes(afterBytes);
  return { path, before, after };
}

async function stateForBytes(bytes) {
  const temp = join(root, `.state-${process.pid}-${Math.floor(performance.now())}`);
  await writeSynced(temp, bytes);
  const state = await capturePath(temp);
  await restorePath(temp, { exists: false, bytes: null, sha256: null }, state);
  return state;
}

async function buildScenario() {
  const markdownBefore = Buffer.from("before\r\n[[原链接]]\r\n", "utf8");
  const markdownAfter = Buffer.from("after\r\n[[目标链接]]\r\n", "utf8");

  if (mutationKind === "create-markdown") {
    const target = join(root, "创建.md");
    return {
      footprints: [await footprint(target, markdownAfter)],
      apply: () => writeSynced(target, markdownAfter),
    };
  }

  if (["modify-markdown", "frontmatter-rewrite", "derived-link-rewrite"].includes(mutationKind)) {
    const target = join(root, `${mutationKind}.md`);
    const before = mutationKind === "frontmatter-rewrite"
      ? Buffer.from("---\r\n状态: 旧\r\n---\r\n正文\r\n", "utf8")
      : markdownBefore;
    const after = mutationKind === "frontmatter-rewrite"
      ? Buffer.from("---\r\n状态: 新\r\n---\r\n正文\r\n", "utf8")
      : markdownAfter;
    await writeSynced(target, before);
    return {
      footprints: [await footprint(target, after)],
      apply: () => writeSynced(target, after),
    };
  }

  if (mutationKind === "attachment-write") {
    const target = join(root, "附件.bin");
    const before = Buffer.from([0, 1, 2, 3, 255, 13, 10]);
    const after = Buffer.from([255, 254, 0, 128, 64, 13, 10]);
    await writeSynced(target, before);
    return {
      footprints: [await footprint(target, after)],
      apply: () => writeSynced(target, after),
    };
  }

  if (["same-volume-move", "managed-trash"].includes(mutationKind)) {
    const source = join(root, "移动源.md");
    const destination = mutationKind === "managed-trash"
      ? join(root, ".managed-trash", "移动源.md")
      : join(root, "移动目标.md");
    await writeSynced(source, markdownBefore);
    return {
      footprints: [
        await footprint(source, null),
        await footprint(destination, markdownBefore),
      ],
      apply: () => renameSynced(source, destination),
    };
  }

  throw new Error(`unknown_mutation_kind:${mutationKind}`);
}

await mkdir(root, { recursive: true });
if (process.argv.includes("--recover")) {
  const { frame, errors } = await readLatestFrame(journalDir, vaultIdentity);
  await event("recovery-scan", { frame: frame?.phase ?? null, errors });
  if (frame?.phase === "PREPARED") {
    for (const mutation of frame.mutations) {
      await restorePath(mutation.path, mutation.before, mutation.after);
    }
    await writeFrame(journalDir, { ...frame, phase: "ROLLED_BACK", sequence: frame.sequence + 1 });
    await event("recovered", { phase: "ROLLED_BACK" });
  }
  process.exit(0);
}

await writeFile(marker, "", { encoding: "utf8", flag: "wx" });
await initializeJournal(journalDir);
const scenario = await buildScenario();
const base = {
  vaultIdentity,
  changeSetId: `prototype-${mutationKind}`,
  mutationKind,
  mutations: scenario.footprints,
};

await writeFrame(journalDir, { ...base, phase: "EMPTY", sequence: 0 });
await event("empty-synced", { mutationKind });
crash("before-prepared");

await writeFrame(journalDir, { ...base, phase: "PREPARED", sequence: 1 });
await event("prepared-synced", { mutationKind });
crash("after-prepared");

await scenario.apply();
await event("mutation-applied", { mutationKind });
crash("after-mutation");

const observed = [];
for (const mutation of scenario.footprints) {
  const current = await capturePath(mutation.path);
  if (current.exists !== mutation.after.exists || current.sha256 !== mutation.after.sha256) {
    throw new Error(`raw_reread_hash_mismatch:${mutation.path}`);
  }
  observed.push({ path: mutation.path, exists: current.exists, sha256: current.sha256 });
}
await event("raw-verified", { mutationKind, observed });
crash("after-raw-verify");

await writeFrame(journalDir, { ...base, phase: "COMMITTED", sequence: 2, rawEvidence: observed });
await event("committed-synced", { mutationKind });
crash("after-committed");
