import { evaluateSample, MANIFEST_VERSION } from "./profiles.mjs";

const samples = [
  {
    name: "Wikilink with alias and heading",
    profileId: "wikilink",
    rawToken: "[[资料/唯一目标#章节|显示文字]]",
    candidates: ["资料/唯一目标.md"],
    hostDestination: "资料/唯一目标.md",
    runtimeObserved: true,
    fragmentKind: "heading",
    fragmentOccurrences: 1,
    newTargetPath: "归档/唯一目标.md",
  },
  {
    name: "Literal hash attachment is rejected by host graph",
    profileId: "wikilinkEmbed",
    rawToken: "![[附件/图 像 #1.png|320]]",
    candidates: [],
    hostDestination: null,
    runtimeObserved: true,
    fragmentKind: "heading",
    fragmentOccurrences: 0,
    newTargetPath: "归档附件/图 像 #1.png",
  },
  {
    name: "Markdown inline with escaped destination and title",
    profileId: "markdownInline",
    rawToken: "[显示](资料/唯一%20目标.md#章节 \"标题\")",
    candidates: ["资料/唯一 目标.md"],
    hostDestination: "资料/唯一 目标.md",
    runtimeObserved: true,
    fragmentKind: "heading",
    fragmentOccurrences: 1,
    newTargetPath: "归档/唯一 目标.md",
  },
  {
    name: "Markdown embed with angle destination",
    profileId: "markdownEmbed",
    rawToken: "![alt](<附件/图 像 1.png> \"预览\")",
    candidates: ["附件/图 像 1.png"],
    hostDestination: "附件/图 像 1.png",
    runtimeObserved: true,
    fragmentKind: null,
    fragmentOccurrences: 0,
    newTargetPath: "归档附件/图 像 1.png",
  },
  {
    name: "Duplicate basename is rejected",
    profileId: "wikilink",
    rawToken: "[[同名]]",
    candidates: ["甲/同名.md", "乙/同名.md"],
    hostDestination: "甲/同名.md",
    runtimeObserved: true,
    fragmentKind: null,
    fragmentOccurrences: 0,
    newTargetPath: "归档/同名.md",
  },
  {
    name: "Duplicate heading is rejected",
    profileId: "wikilink",
    rawToken: "[[资料/唯一目标#重复]]",
    candidates: ["资料/唯一目标.md"],
    hostDestination: "资料/唯一目标.md",
    runtimeObserved: true,
    fragmentKind: "heading",
    fragmentOccurrences: 2,
    newTargetPath: "归档/唯一目标.md",
  },
  {
    name: "Block fragment remains renderable",
    profileId: "wikilink",
    rawToken: "[[资料/唯一目标#^稳定块]]",
    candidates: ["资料/唯一目标.md"],
    hostDestination: "资料/唯一目标.md",
    runtimeObserved: true,
    fragmentKind: "block",
    fragmentOccurrences: 1,
    newTargetPath: "归档/唯一目标.md",
  },
  {
    name: "Frontmatter wikilink requires category evidence",
    profileId: "frontmatterWikilink",
    rawToken: "[[资料/唯一目标|属性别名]]",
    candidates: ["资料/唯一目标.md"],
    hostDestination: "资料/唯一目标.md",
    runtimeObserved: false,
    fragmentKind: null,
    fragmentOccurrences: 0,
    newTargetPath: "归档/唯一目标.md",
  },
  {
    name: "Reference-style use requires definition pairing",
    profileId: "markdownReferenceUse",
    rawToken: "[显示][目标-id]",
    candidates: ["资料/唯一目标.md"],
    hostDestination: "资料/唯一目标.md",
    runtimeObserved: true,
    fragmentKind: null,
    fragmentOccurrences: 0,
    newTargetPath: "归档/唯一目标.md",
  },
];

let index = 0;
let moved = false;
let runtimeOverride = null;

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

function currentSample() {
  const sample = { ...samples[index] };
  if (runtimeOverride !== null) sample.runtimeObserved = runtimeOverride;
  return sample;
}

function render() {
  console.clear();
  const sample = currentSample();
  const state = evaluateSample(sample, moved);
  console.log(`${bold}PROTOTYPE — registered reference profiles${reset}`);
  console.log(`${dim}${index + 1}/${samples.length} · ${MANIFEST_VERSION}${reset}\n`);
  console.log(`${bold}Case${reset}: ${sample.name}`);
  console.log(`${bold}Input${reset}: ${sample.rawToken}`);
  console.log(`${bold}Runtime evidence${reset}: ${sample.runtimeObserved}`);
  console.log(`${bold}Bridge candidates${reset}: ${JSON.stringify(sample.candidates)}`);
  console.log(`${bold}Host destination${reset}: ${sample.hostDestination ?? "null"}`);
  console.log(`${bold}Moved${reset}: ${moved}`);
  console.log(`\n${bold}Full state${reset}`);
  console.log(JSON.stringify(state, null, 2));
  console.log(`\n${bold}[n]${reset} ${dim}next${reset}  ${bold}[p]${reset} ${dim}previous${reset}  ${bold}[m]${reset} ${dim}toggle move${reset}  ${bold}[r]${reset} ${dim}toggle runtime evidence${reset}  ${bold}[q]${reset} ${dim}quit${reset}`);
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (key) => {
  if (key === "q" || key === "") process.exit(0);
  if (key === "n") index = (index + 1) % samples.length;
  if (key === "p") index = (index - 1 + samples.length) % samples.length;
  if (key === "m") moved = !moved;
  if (key === "r") runtimeOverride = !(runtimeOverride ?? currentSample().runtimeObserved);
  render();
});

render();
