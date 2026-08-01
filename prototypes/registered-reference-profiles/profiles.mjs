export const MANIFEST_VERSION = "obsidian-1.13.4/windows-v1";

export const profiles = Object.freeze({
  wikilink: {
    categories: ["links"],
    wrappers: ["[[", "]]"],
    supportsAlias: true,
    supportsTitle: false,
    supportsFragment: true,
  },
  wikilinkEmbed: {
    categories: ["embeds"],
    wrappers: ["![[", "]]"],
    supportsAlias: true,
    supportsTitle: false,
    supportsFragment: true,
  },
  markdownInline: {
    categories: ["links"],
    wrappers: ["](", ")"],
    supportsAlias: true,
    supportsTitle: true,
    supportsFragment: true,
  },
  markdownEmbed: {
    categories: ["embeds"],
    wrappers: ["![", ")"],
    supportsAlias: true,
    supportsTitle: true,
    supportsFragment: true,
  },
  frontmatterWikilink: {
    categories: ["frontmatterLinks"],
    wrappers: ["[[", "]]"],
    supportsAlias: true,
    supportsTitle: false,
    supportsFragment: true,
  },
  markdownReferenceUse: {
    categories: ["referenceLinks"],
    wrappers: ["][", "]"],
    supportsAlias: true,
    supportsTitle: true,
    supportsFragment: true,
  },
});

function splitFragment(destination) {
  const blockIndex = destination.lastIndexOf("#^");
  if (blockIndex >= 0) {
    return {
      fileLinkpath: destination.slice(0, blockIndex),
      fragment: destination.slice(blockIndex),
      fragmentKind: "block",
    };
  }

  const headingIndex = destination.indexOf("#");
  if (headingIndex >= 0) {
    return {
      fileLinkpath: destination.slice(0, headingIndex),
      fragment: destination.slice(headingIndex),
      fragmentKind: "heading",
    };
  }

  return { fileLinkpath: destination, fragment: "", fragmentKind: null };
}

function parseMarkdownDestination(rawDestination) {
  if (rawDestination.startsWith("<")) {
    const close = rawDestination.indexOf(">");
    if (close < 0) return null;
    return {
      destination: rawDestination.slice(1, close),
      destinationStart: 1,
      destinationEnd: close,
      titleSuffix: rawDestination.slice(close + 1),
      angleWrapped: true,
    };
  }

  const title = rawDestination.match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/u);
  const destination = title ? title[1] : rawDestination;
  return {
    destination,
    destinationStart: 0,
    destinationEnd: destination.length,
    titleSuffix: title?.[2] ?? "",
    angleWrapped: false,
  };
}

export function parseReference(sample) {
  const { profileId, rawToken } = sample;
  const profile = profiles[profileId];
  if (!profile) return { status: "unsupported_rejected", reason: "profile_not_registered" };

  let destination;
  let destinationStart;
  let destinationEnd;
  let style;

  if (profileId === "wikilink" || profileId === "wikilinkEmbed" || profileId === "frontmatterWikilink") {
    const prefixLength = rawToken.startsWith("![[") ? 3 : 2;
    if (!rawToken.endsWith("]]")) {
      return { status: "unsupported_rejected", reason: "malformed_wikilink" };
    }
    const inner = rawToken.slice(prefixLength, -2);
    const aliasIndex = inner.indexOf("|");
    destination = aliasIndex < 0 ? inner : inner.slice(0, aliasIndex);
    destinationStart = prefixLength;
    destinationEnd = prefixLength + destination.length;
    style = {
      prefix: rawToken.slice(0, destinationStart),
      suffix: rawToken.slice(destinationEnd),
      angleWrapped: false,
      titleSuffix: "",
    };
  } else if (profileId === "markdownInline" || profileId === "markdownEmbed") {
    const open = rawToken.indexOf("](");
    if (open < 0 || !rawToken.endsWith(")")) {
      return { status: "unsupported_rejected", reason: "malformed_markdown_inline" };
    }
    const rawDestination = rawToken.slice(open + 2, -1);
    const parsed = parseMarkdownDestination(rawDestination);
    if (!parsed) return { status: "unsupported_rejected", reason: "malformed_angle_destination" };
    destination = parsed.destination;
    destinationStart = open + 2 + parsed.destinationStart;
    destinationEnd = open + 2 + parsed.destinationEnd;
    style = {
      prefix: rawToken.slice(0, destinationStart),
      suffix: rawToken.slice(destinationEnd),
      angleWrapped: parsed.angleWrapped,
      titleSuffix: parsed.titleSuffix,
    };
  } else {
    return {
      status: "unsupported_rejected",
      reason: "reference_definition_requires_runtime_pairing",
      profileId,
      rawToken,
    };
  }

  const link = splitFragment(destination);
  return {
    status: "registered",
    profileId,
    profileVersion: MANIFEST_VERSION,
    rawToken,
    destinationStart,
    destinationEnd,
    rawDestination: destination,
    ...link,
    style,
  };
}

export function decideResolution(intent, sample) {
  if (intent.status !== "registered") return intent;
  if (!sample.runtimeObserved) {
    return { ...intent, status: "unsupported_rejected", reason: "runtime_evidence_missing" };
  }
  if (sample.fragmentKind === "heading" && sample.fragmentOccurrences > 1) {
    return { ...intent, status: "ambiguous_rejected", reason: "duplicate_heading_fragment" };
  }
  if (sample.candidates.length !== 1) {
    return {
      ...intent,
      status: "ambiguous_rejected",
      reason: sample.candidates.length ? "multiple_candidates" : "target_not_found",
      candidates: sample.candidates,
    };
  }
  if (sample.hostDestination !== sample.candidates[0]) {
    return {
      ...intent,
      status: "ambiguous_rejected",
      reason: "host_candidate_disagreement",
      candidates: sample.candidates,
      hostDestination: sample.hostDestination,
    };
  }
  return {
    ...intent,
    status: "unique_host_agreement",
    canonicalTargetPath: sample.candidates[0],
  };
}

function encodeLike(source, destination) {
  if (/%[0-9A-Fa-f]{2}/u.test(source)) {
    return encodeURI(destination).replace(/#/gu, "%23");
  }
  return destination;
}

export function renderMove(intent, newTargetPath) {
  if (intent.status !== "unique_host_agreement") {
    return { ...intent, renderedReplacement: null, renderStatus: "rejected" };
  }

  const hadMarkdownExtension = /\.md$/iu.test(intent.fileLinkpath);
  const nextFile = hadMarkdownExtension
    ? newTargetPath
    : newTargetPath.replace(/\.md$/iu, "");
  const renderedDestination = encodeLike(intent.fileLinkpath, nextFile) + intent.fragment;

  return {
    ...intent,
    newTargetPath,
    renderedDestination,
    renderedReplacement:
      intent.style.prefix + renderedDestination + intent.style.suffix,
    renderStatus: "style_preserved",
  };
}

export function evaluateSample(sample, moved = false) {
  const intent = parseReference(sample);
  const resolution = decideResolution(intent, sample);
  return moved ? renderMove(resolution, sample.newTargetPath) : resolution;
}
