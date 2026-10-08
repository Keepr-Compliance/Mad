#!/usr/bin/env node
/**
 * BACKLOG-3803: third-party notices for components Keepr ships that are NOT npm
 * dependencies (the iPhone tools for Windows, their DLLs, Electron/Chromium, the
 * Apple driver installer, vendored code).
 *
 * The data lives in resources/third-party/components.json. This script renders
 * THIRD_PARTY_NOTICES.md (notices, linking the licence files) and
 * THIRD_PARTY_NOTICES.txt (the same notices followed by every licence text — the
 * file the app opens from Settings > About).
 *
 *   node scripts/third-party/generate-notices.js --write   regenerate both files
 *   node scripts/third-party/generate-notices.js --check   verify, exit 1 on drift
 *
 * --check also verifies that every .exe/.dll in the tools folder belongs to
 * exactly one component, that every listed file exists, and that every licence
 * text exists with the recorded sha256. Options for tests:
 *   --root <dir>       the third-party folder (default resources/third-party)
 *   --tools-dir <dir>  the tools folder (default: components.json toolsDir)
 *   --repo <dir>       repo root for "external" licence files (default: cwd of this repo)
 *
 * BACKLOG-3769 replaces the tools with self-built ones: update components.json
 * and run --write. Nothing else here should need to change.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PE_EXTENSIONS = new Set([".exe", ".dll"]);

/** Licence texts are hashed with CRLF normalised to LF, so a Windows checkout cannot fake drift. */
function normalisedSha256(buf) {
  const text = buf.toString("utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function normaliseEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function platformsOf(component, bundles) {
  if (component.platforms) return component.platforms;
  if (component.bundle && bundles[component.bundle] && bundles[component.bundle].platforms) {
    return bundles[component.bundle].platforms;
  }
  return ["win", "mac"];
}

const PLATFORM_LABEL = { win: "Windows", mac: "macOS" };

function render(data, { withTexts = false, readLicence } = {}) {
  const out = [];
  const bundles = data.bundles || {};
  const L = data.licenses;

  out.push("# Third-party notices for " + data.product);
  out.push("");
  out.push(
    data.product +
      " includes the third-party software listed below. This file covers components bundled outside the npm dependency tree: " +
      "the iPhone tools for Windows and the libraries they contain, and the Electron and Chromium licence files. " +
      "The licences of the npm packages Keepr is built from are not listed in this file. " +
      "Each component remains under its own licence. " +
      "Nothing in Keepr's own terms restricts the rights these licences give you.",
  );
  out.push("");
  out.push("This file is generated from components.json. Do not edit it by hand.");
  out.push("");

  out.push("## Source code and your rights under the LGPL and GPL");
  out.push("");
  out.push(
    "Several components below are licensed under the GNU Lesser General Public License (LGPL) or the GNU General Public License (GPL). " +
      "Keepr does not modify them. Keepr starts the iPhone tools for Windows as separate programs; it does not link them into Keepr itself.",
  );
  out.push("");
  for (const [, b] of Object.entries(bundles)) {
    out.push(
      `- The files in the iPhone tools folder are unmodified copies of the ${b.name} ${b.version} release (${b.releaseUrl}, asset ${b.asset}, sha256 ${b.assetSha256}).`,
    );
  }
  out.push(
    "- Under each component below, the source line names where its source can be found. For components marked with a pinned commit, that is the repository and commit. For the libraries built by the vcpkg package manager (libiconv, libusb, libusb-win32, readline, getopt-win32 and the other libraries in that group), it is the upstream project at the identified version; the exact build recipe used for those binaries is not recorded.",
  );
  out.push(
    "- You may replace any LGPL-licensed library in that folder with your own modified version built from that source. Keepr loads whatever is in the folder.",
  );
  out.push("");
  const shipped = data.toolsDirShippedAs || {};
  if (Object.keys(shipped).length) {
    out.push("Where the iPhone tools folder is on your computer:");
    out.push("");
    for (const [p, where] of Object.entries(shipped)) {
      out.push(`- ${PLATFORM_LABEL[p] || p}: ${where}`);
    }
    out.push("");
  }

  out.push("## Summary");
  out.push("");
  out.push("| Component | Version | Licence | Platforms |");
  out.push("|---|---|---|---|");
  for (const c of data.components) {
    const plats = platformsOf(c, bundles).map((p) => PLATFORM_LABEL[p] || p).join(", ");
    out.push(`| ${c.name} | ${c.version} | ${c.licenseExpression} | ${plats} |`);
  }
  out.push("");

  out.push("## Components");
  out.push("");
  for (const c of data.components) {
    out.push(`### ${c.name}`);
    out.push("");
    out.push(`- Version: ${c.version} (${c.versionEvidence})`);
    out.push(`- Licence: ${c.licenseExpression}${c.licenseEvidence ? ` (${c.licenseEvidence})` : ""}`);
    out.push(`- Copyright: ${c.copyright}`);
    if (c.homepage) out.push(`- Project: ${c.homepage}`);
    if (c.source) {
      const s = c.source;
      const parts = [s.url];
      if (s.commit) parts.push(`commit ${s.commit}`);
      if (s.commitDate) parts.push(`dated ${s.commitDate}`);
      out.push(`- ${s.commit ? "Source code (pinned commit)" : "Upstream project"}: ${parts.join(", ")}`);
      if (s.note) out.push(`  (${s.note})`);
    }
    if (c.bundle && bundles[c.bundle]) out.push(`- Shipped as part of: ${bundles[c.bundle].name} ${bundles[c.bundle].version}`);
    if (c.files && c.files.length) out.push(`- Files: ${c.files.join(", ")}`);
    if (c.usedByKeepr && c.usedByKeepr.length) out.push(`- Run by Keepr: ${c.usedByKeepr.join(", ")}`);
    if (c.shippedAt) out.push(`- Location: ${c.shippedAt}`);
    if (c.attributionOnly) {
      out.push("- Licence text: not reproduced (proprietary; attribution only)");
    } else {
      const refs = c.licenses.map((k) => {
        const e = L[k];
        if (!e) return `UNDEFINED LICENCE ${k}`;
        if (e.file) return withTexts ? `${e.title} (full text at the end of this file)` : `[${e.title}](${e.file})`;
        const where = Object.entries(e.shipped || {})
          .map(([p, w]) => `${PLATFORM_LABEL[p] || p}: ${w}`)
          .join("; ");
        return `${e.title} (${where})`;
      });
      out.push(`- Licence text: ${refs.join("; ")}`);
    }
    if (c.notes) out.push(`- Note: ${c.notes}`);
    out.push("");
  }

  out.push("## Licence texts");
  out.push("");
  out.push("Each file is copied verbatim from the upstream source shown.");
  out.push("");
  const fileLicences = Object.entries(L).filter(([, e]) => e.file);
  for (const [, e] of fileLicences) {
    const extra = e.excerpt ? ` (${e.excerpt})` : "";
    out.push(`- ${e.file}: ${e.title}. From ${e.fetchedFrom}${extra}`);
  }
  out.push("");

  if (withTexts) {
    for (const [, e] of fileLicences) {
      out.push("=".repeat(78));
      out.push(`${e.title}`);
      out.push(`(${e.file}; from ${e.fetchedFrom})`);
      out.push("=".repeat(78));
      out.push("");
      out.push(normaliseEol(readLicence(e.file)).replace(/\n+$/, ""));
      out.push("");
    }
  }

  return out.join("\n") + "\n";
}

function parseArgs(argv) {
  const args = { mode: null, root: path.join(REPO_ROOT, "resources", "third-party"), toolsDir: null, repo: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write" || a === "--check") args.mode = a.slice(2);
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--tools-dir") args.toolsDir = path.resolve(argv[++i]);
    else if (a === "--repo") args.repo = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.mode) throw new Error("pass --write or --check");
  return args;
}

function load(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "components.json"), "utf8"));
}

function outputs(data, root) {
  const readLicence = (rel) => {
    const p = path.join(root, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : `MISSING LICENCE FILE ${rel}`;
  };
  return {
    "THIRD_PARTY_NOTICES.md": render(data, { withTexts: false }),
    "THIRD_PARTY_NOTICES.txt": render(data, { withTexts: true, readLicence }),
  };
}

/** Returns a list of problems; empty means consistent. */
function check({ root, toolsDir, repo }) {
  const problems = [];
  const data = load(root);
  const L = data.licenses || {};
  const tools = toolsDir || path.join(repo, data.toolsDir);

  // 1. Licences: every named licence exists; file texts match their recorded hash.
  for (const c of data.components) {
    if (!c.attributionOnly && (!c.licenses || c.licenses.length === 0)) {
      problems.push(`component ${c.id}: no licence named and not marked attributionOnly`);
    }
    for (const k of c.licenses || []) {
      if (!L[k]) problems.push(`component ${c.id}: licence "${k}" is not defined in licenses`);
    }
  }
  for (const [k, e] of Object.entries(L)) {
    if (e.file) {
      const p = path.join(root, e.file);
      if (!fs.existsSync(p)) {
        problems.push(`licence ${k}: file ${e.file} is missing`);
        continue;
      }
      const got = normalisedSha256(fs.readFileSync(p));
      if (got !== e.sha256) problems.push(`licence ${k}: ${e.file} sha256 ${got} != recorded ${e.sha256}`);
    } else if (e.external) {
      // The Electron licence files only exist after electron's postinstall has downloaded the
      // binary. CI installs with --ignore-scripts, so skip those two files there. electron-builder
      // only warns when an extraResources source is missing; the release workflow enforces their
      // presence in the packaged app (scripts/ci/check-packaged-notices.mjs).
      const electronDist = "node_modules/electron/dist/";
      const notDownloaded = e.external.startsWith(electronDist) && !fs.existsSync(path.join(repo, electronDist));
      if (!notDownloaded && !fs.existsSync(path.join(repo, e.external))) problems.push(`licence ${k}: external file ${e.external} is missing`);
    } else {
      problems.push(`licence ${k}: has neither file nor external`);
    }
  }

  // 2. Inventory: every PE file in the tools folder belongs to exactly one component, and back.
  const owners = new Map();
  for (const c of data.components) {
    if (!c.bundle) continue;
    for (const f of c.files || []) {
      if (owners.has(f)) problems.push(`file ${f} is listed by both ${owners.get(f)} and ${c.id}`);
      owners.set(f, c.id);
    }
  }
  if (!fs.existsSync(tools)) {
    problems.push(`tools folder ${tools} does not exist`);
  } else {
    const present = fs
      .readdirSync(tools)
      .filter((f) => PE_EXTENSIONS.has(path.extname(f).toLowerCase()));
    for (const f of present) {
      if (!owners.has(f)) problems.push(`unlisted file in tools folder: ${f} (add it to a component in components.json)`);
    }
    const presentSet = new Set(present);
    for (const [f, id] of owners) {
      if (!presentSet.has(f)) problems.push(`component ${id} lists ${f}, which is not in the tools folder`);
    }
  }

  // 3. Generated files match the data.
  for (const [name, expected] of Object.entries(outputs(data, root))) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) {
      problems.push(`${name} is missing; run node scripts/third-party/generate-notices.js --write`);
    } else if (normaliseEol(fs.readFileSync(p, "utf8")) !== expected) {
      problems.push(`${name} is out of date with components.json; run node scripts/third-party/generate-notices.js --write`);
    }
  }
  return problems;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "write") {
    const data = load(args.root);
    const missing = Object.values(data.licenses || {}).filter((e) => e.file && !fs.existsSync(path.join(args.root, e.file)));
    if (missing.length) throw new Error(`missing licence files: ${missing.map((e) => e.file).join(", ")}`);
    for (const [name, text] of Object.entries(outputs(data, args.root))) {
      fs.writeFileSync(path.join(args.root, name), text);
      console.log(`wrote ${path.relative(process.cwd(), path.join(args.root, name))}`);
    }
    return 0;
  }
  const problems = check(args);
  if (problems.length) {
    for (const p of problems) console.error(`THIRD_PARTY_NOTICES: ${p}`);
    return 1;
  }
  console.log("THIRD_PARTY_NOTICES: OK");
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(2);
  }
}

module.exports = { render, check, normalisedSha256 };
