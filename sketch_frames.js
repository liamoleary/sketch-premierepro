#!/usr/bin/env node
/*
 * sketch_frames.js — Phase 2 of the Nano Banana V1->V2 workflow.
 *
 * Reads the frames the Premiere plugin exported (frame_001.png, frame_002.png …)
 * in a folder, runs each through Google's Gemini image model with the rough
 * storyboard prompt, and writes sketch_001.png, sketch_002.png … next to them.
 * Then go back to Premiere and click "2 · Place sketches on V2".
 *
 * Requires Node 18+ (built-in fetch). No npm install needed.
 *
 * Usage:
 *   node sketch_frames.js "C:\\path\\to\\export\\folder"
 *   node sketch_frames.js "C:\\path\\to\\folder" --pro     (higher-quality model)
 *
 * API key (first that exists wins):
 *   - apikey.txt in the export folder
 *   - apikey.txt next to this script
 *   - GEMINI_API_KEY environment variable
 */

const fs = require("fs");
const path = require("path");

const MODELS = {
  nb2: "gemini-2.5-flash-image",
  pro: "gemini-3-pro-image-preview",
};
const HOST = "https://generativelanguage.googleapis.com/v1beta/models";

const STORYBOARD_PROMPT =
  "Completely REDRAW this image as a hand-drawn BLACK-AND-WHITE storyboard " +
  "pencil sketch on plain white paper. It must look 100% hand-drawn and 2D - " +
  "NOT photographic, NOT 3D-rendered, NOT shaded or lit like a 3D model. Do " +
  "NOT keep any of the original colours, lighting, textures or rendered " +
  "surfaces.\n\n" +
  "LOOSENESS - this is the MOST important quality. It must read as a fast, " +
  "rough storyboard thumbnail dashed off in seconds, NOT a clean or finished " +
  "drawing:\n" +
  "- Use loose, scratchy, gestural pencil strokes with lots of overlapping " +
  "searching lines and visible construction lines.\n" +
  "- Lines must be sketchy and broken - never tight, clean, even, or " +
  "vector-like. Leave edges open and unfinished.\n" +
  "- The BACKGROUND is the LOOSEST of all: only a few quick suggestive strokes " +
  "to hint at the environment - minimal, sparse and abstracted, never detailed.\n" +
  "- CHARACTERS are also drawn loose and gestural, as a rough gesture pass - " +
  "readable but still rough and energetic, never tight or polished.\n\n" +
  "THE ONLY COLOUR ALLOWED IS RED:\n" +
  "- Draw EVERY character ENTIRELY in RED pencil - 100% of its linework. A " +
  "'character' is any person, humanoid, creature, animal, alien, OR robot / " +
  "droid / mechanical being. This INCLUDES the round, ball, dome or spherical " +
  "robots even when they look like an object, rock or sphere - if it is a " +
  "robot or has a face, it IS a character and must be drawn in RED.\n" +
  "- EVERY line belonging to a character is RED, including ALL interior detail: " +
  "eyes, pupils, eyebrows, mouth, teeth, nose, ears, facial lines, hands, " +
  "fingers, clothing and accessories. NO part of a character may be black or " +
  "grey - if a line is on a character, it is red.\n" +
  "- Draw EVERYTHING ELSE (environment, ground, plants, water, props, " +
  "backgrounds, sky) in BLACK and GREY graphite pencil ONLY.\n" +
  "- No other colours anywhere: no green, brown, blue, or photographic colour.\n\n" +
  "Keep the same composition, camera angle, framing, and the rough position " +
  "and scale of every element. Plain white paper background. No clean vector " +
  "lines, no full rendering, no colour photo elements, nothing that looks 3D.";

function readKey(folder) {
  for (const p of [path.join(folder, "apikey.txt"), path.join(__dirname, "apikey.txt")]) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith("#")) return t;
      }
    } catch (e) {}
  }
  return (process.env.GEMINI_API_KEY || "").trim();
}

async function callGemini(apiKey, model, base64, mime) {
  const url = `${HOST}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [
      { text: STORYBOARD_PROMPT },
      { inlineData: { mimeType: mime || "image/png", data: base64 } },
    ] }],
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error((json && json.error && json.error.message) || ("HTTP " + resp.status));
  for (const cand of json.candidates || []) {
    for (const part of (cand.content && cand.content.parts) || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) return inline.data;
    }
  }
  const block = json.promptFeedback && json.promptFeedback.blockReason;
  throw new Error("no image in response" + (block ? " (blocked: " + block + ")" : ""));
}

function listFrames(folder) {
  // Prefer the manifest if present; otherwise glob frame_*.png (and .png.png).
  const mfPath = path.join(folder, "manifest.json");
  if (fs.existsSync(mfPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
      if (mf && Array.isArray(mf.clips) && mf.clips.length) {
        return mf.clips.map((c) => ({ frame: c.frameName, sketch: c.sketchName }));
      }
    } catch (e) {}
  }
  const names = fs.readdirSync(folder).filter((n) => /^frame_\d+\.png(\.png)?$/i.test(n));
  names.sort();
  return names.map((n) => {
    const idx = (n.match(/frame_(\d+)/i) || [])[1] || "000";
    return { frame: n, sketch: "sketch_" + idx + ".png" };
  });
}

function resolveExisting(folder, frameName) {
  for (const cand of [frameName, frameName + ".png"]) {
    const p = path.join(folder, cand);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let cancelled = false;
process.on("SIGINT", () => {
  if (cancelled) { console.log("\nForce quit."); process.exit(130); }
  cancelled = true;
  console.log("\nCancelling after the current frame… (press Ctrl+C again to force quit)");
});

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith("--"));
  const model = args.includes("--pro") ? MODELS.pro : MODELS.nb2;
  const force = args.includes("--force"); // redo sketches that already exist
  if (!folder) {
    console.error('Usage: node sketch_frames.js "C:\\\\path\\\\to\\\\export\\\\folder" [--pro]');
    process.exit(1);
  }
  if (!fs.existsSync(folder)) { console.error("Folder not found: " + folder); process.exit(1); }

  const apiKey = readKey(folder);
  if (!apiKey) { console.error("No API key. Put it in apikey.txt (in the folder or next to this script) or set GEMINI_API_KEY."); process.exit(1); }

  const items = listFrames(folder);
  if (!items.length) { console.error("No frames (frame_NNN.png) found in " + folder); process.exit(1); }

  console.log(`Sketching ${items.length} frame(s) with ${model}…  (Ctrl+C to cancel)`);
  let ok = 0, fail = 0, skipped = 0;
  for (let i = 0; i < items.length; i++) {
    if (cancelled) { console.log("Cancelled — stopping. Already-made sketches are kept; re-run to resume."); break; }
    const { frame, sketch } = items[i];
    // Resume: skip frames already sketched with a non-empty file (unless --force).
    // Deleted, missing, or 0-byte/broken sketches are regenerated.
    if (!force) {
      const sp = path.join(folder, sketch);
      let good = false;
      try { good = fs.statSync(sp).size > 0; } catch (e) { good = false; }
      if (good) {
        console.log(`  [${i + 1}/${items.length}] ${sketch} already exists — skipped (use --force to redo)`);
        skipped++; continue;
      }
    }
    const src = resolveExisting(folder, frame);
    if (!src) { console.warn(`  [${i + 1}/${items.length}] missing ${frame} — skipped`); fail++; continue; }
    process.stdout.write(`  [${i + 1}/${items.length}] ${frame} -> ${sketch} … `);
    try {
      const b64 = fs.readFileSync(src).toString("base64");
      const out = await callGemini(apiKey, model, b64, "image/png");
      fs.writeFileSync(path.join(folder, sketch), Buffer.from(out, "base64"));
      console.log("ok");
      ok++;
    } catch (e) {
      console.log("FAILED: " + (e.message || e));
      fail++;
    }
  }
  console.log(`Done. ${ok} sketched${skipped ? ", " + skipped + " skipped" : ""}${fail ? ", " + fail + " failed" : ""}. Now click "2 · Place sketches on V2" in Premiere.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
