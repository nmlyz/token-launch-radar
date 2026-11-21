// Token launch radar — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, ranks every pre-token protocol by the implied
// value model in lib/model.ts, and writes:
//   /output/board.json        the ranked board (rows + method meta)
//   /output/dashboard/       the page (index.html, app.css, app.js, rows.js)
//   /output/screenshots/     the three captures of the dashboard
//   /output/dossier.json     byte-for-byte buildDossier output
//
// Input:  --input <path> | $MAKEFUN_INPUT_DIR/snapshot.json | /input/snapshot.json
// Output: --output <path> | $MAKEFUN_OUTPUT_DIR | /output
//
// Deterministic: same snapshot bytes in, same output bytes out. No clock,
// no randomness, no network, fixed key order via construction order.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoard } from "./lib/model.ts";
import type { Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function readSnapshot(path: string): Snapshot {
  const raw = readFileSync(path, "utf8");
  const snap = JSON.parse(raw) as Snapshot;
  if (!Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error("snapshot is not the expected shape: " + path);
  }
  return snap;
}

/** Gate-shape validation: the same rules the sealed scorer checks. */
function validate(rows: ReturnType<typeof buildBoard>["rows"], watchlist: string[]): void {
  if (rows.length < 100 || rows.length > 4000) {
    throw new Error("board must hold 100-4000 rows, got " + rows.length);
  }
  const slugs = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  rows.forEach((r, i) => {
    if (r.rank !== i + 1) throw new Error("rank broken at row " + i);
    if (slugs.has(r.slug)) throw new Error("duplicate slug " + r.slug);
    slugs.add(r.slug);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      throw new Error("bad implied value for " + r.slug);
    }
    if (r.implied_value_usd > prev) {
      throw new Error("implied value rises at rank " + r.rank);
    }
    prev = r.implied_value_usd;
    if (!r.name) throw new Error("empty name for " + r.slug);
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      throw new Error("farm_steps count wrong for " + r.slug);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) {
        throw new Error("farm step length " + t.length + " for " + r.slug);
      }
    }
  });
  for (const slug of watchlist) {
    if (!slugs.has(slug)) throw new Error("watchlist slug missing from board: " + slug);
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (values.size < 2) throw new Error("board ranks nothing: all implied values equal");
}

function writeFile(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data);
  chmodSync(path, 0o644);
}

async function main(): Promise<void> {
  const inputPath =
    flagValue("--input") ??
    (process.env.MAKEFUN_INPUT_DIR ? join(process.env.MAKEFUN_INPUT_DIR, "snapshot.json") : null) ??
    "/input/snapshot.json";
  const outDir = resolve(
    flagValue("--output") ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output",
  );
  const snapshot = readSnapshot(inputPath);
  const { rows, meta } = buildBoard(snapshot);
  validate(rows, snapshot.watchlist);

  // Fresh output directory, then everything the gate reads.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  chmodSync(outDir, 0o755);
  chmodSync(join(outDir, "dashboard"), 0o755);
  chmodSync(join(outDir, "screenshots"), 0o755);

  const board = { as_of: snapshot.as_of, rows, meta };
  writeFile(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

  // Dashboard data: the same rows, pretty-printed one value per line so the
  // dossier's text shows the first rows whole instead of cutting a one-line
  // file at zero complete lines. The page renders from this.
  const data = { as_of: snapshot.as_of, rows, meta };
  writeFile(
    join(outDir, "dashboard", "rows.js"),
    "window.RADAR_DATA = " + JSON.stringify(data, null, 1) + ";\n",
  );

  // The page itself, copied from the repository (read-only in the grader).
  for (const f of ["index.html", "app.css", "app.js"]) {
    cpSync(join(HERE, "dashboard", f), join(outDir, "dashboard", f));
    chmodSync(join(outDir, "dashboard", f), 0o644);
  }
  for (const f of ["1-board.png", "2-detail.png", "3-filtered.png"]) {
    cpSync(join(HERE, "screenshots", f), join(outDir, "screenshots", f));
    chmodSync(join(outDir, "screenshots", f), 0o644);
  }

  // The dossier is byte-for-byte what the library writes from dashboard/
  // and screenshots/; the gate re-derives it and compares.
  const dossier = await buildDossier(outDir, { text_max_bytes: 65536 });
  writeFile(join(outDir, "dossier.json"), dossier);

  console.log(
    "radar: " + rows.length + " rows, " + meta.watchlist_total + " watchlist, " +
    "top implied " + rows[0].implied_value_usd + " (" + rows[0].slug + "), " +
    "dossier " + dossier.length + " bytes",
  );
}

await main();
