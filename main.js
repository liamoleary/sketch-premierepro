/*
 * Nano Banana Storyboard — Premiere Pro UXP plugin
 *
 * Two workflows:
 *
 *  1. "Match V1 clips → V2" (default) — walks the clips on the V1 video track
 *     of the active sequence, exports each clip's MIDDLE frame, runs it through
 *     Google's Gemini image model with the rough-storyboard prompt, imports the
 *     sketched still, and overwrites it onto V2 trimmed to the same start time
 *     and duration as the V1 clip below it.
 *
 *  2. "Markers / Every N seconds" — the original contact-sheet flow: capture
 *     frames at markers or on a time interval, sketch each, save to a folder,
 *     import to a bin, and compose a multi-panel contact sheet.
 */

const uxp = require("uxp");
const ppro = require("premierepro");
const fs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;

const GEMINI_HOST = "https://generativelanguage.googleapis.com/v1beta/models";

const MODEL_IDS = {
  nb2: "gemini-2.5-flash-image",
  pro: "gemini-3-pro-image-preview",
};

// Cost controls — same as the Photoshop plugin.
const MAX_EDGE = 1024;
const JPEG_QUALITY = 70;

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

/* ------------------------------------------------------------------ */
/*  DOM                                                                 */
/* ------------------------------------------------------------------ */
const el = (id) => document.getElementById(id);
const captureModeEl = el("captureMode");
const intervalFieldEl = el("intervalField");
const intervalSecondsEl = el("intervalSeconds");
const modeHintEl = el("modeHint");
const v1OptionsEl = el("v1Options");
const captureOptionsEl = el("captureOptions");
const overwriteV2El = el("overwriteV2");
const btnOneClickEl = el("btnOneClick");
const btnExportEl = el("btnExport");
const btnPlaceEl = el("btnPlace");
const phaseHintEl = el("phaseHint");
const modelChoiceEl = el("modelChoice");
const outputFolderLabelEl = el("outputFolderLabel");
const chooseFolderBtn = el("chooseFolderBtn");
const importToBinEl = el("importToBin");
const buildContactSheetEl = el("buildContactSheet");
const goBtn = el("goBtn");
const statusEl = el("status");
const progressBoxEl = el("progressBox");
const progressListEl = el("progressList");
const cancelBtn = el("cancelBtn");
const apiKeyEl = el("apiKey");
const saveKeyBtn = el("saveKey");
const keyStatePill = el("keyStatePill");

let outputFolderToken = null;
let outputFolderName = null;
let cancelRequested = false;

/* ------------------------------------------------------------------ */
/*  Settings persistence                                                */
/* ------------------------------------------------------------------ */
async function saveSecret(key, value) {
  try {
    await uxp.storage.secureStorage.setItem(key, value); return;
  } catch (e) {}
  try { localStorage.setItem(key, value); } catch (e) {}
}
async function loadSecret(key) {
  try {
    const v = await uxp.storage.secureStorage.getItem(key);
    if (v) return typeof v === "string" ? v : new TextDecoder().decode(v);
  } catch (e) {}
  try { return localStorage.getItem(key) || ""; } catch (e) {}
  return "";
}
function savePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function loadPref(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : v;
  } catch (e) { return d; }
}

/* ------------------------------------------------------------------ */
/*  API key file (apikey.txt next to the plugin)                         */
/* ------------------------------------------------------------------ */
// Reads the first non-empty, non-comment line of apikey.txt from the plugin
// folder, so you can drop your key in a file instead of pasting it each time.
async function readKeyFromFile() {
  try {
    const pluginFolder = await fs.getPluginFolder();
    if (!pluginFolder) return "";
    let entry = null;
    try { entry = await pluginFolder.getEntry("apikey.txt"); } catch (e) { return ""; }
    if (!entry || entry.isFolder) return "";
    const text = await entry.read();
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      return line;
    }
  } catch (e) { /* no file / not readable — fine */ }
  return "";
}

/* ------------------------------------------------------------------ */
/*  Status / progress                                                   */
/* ------------------------------------------------------------------ */
function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

const jobs = []; // { id, label, state, seconds, ... }
function renderProgress() {
  if (!jobs.length) { progressBoxEl.style.display = "none"; return; }
  progressBoxEl.style.display = "block";
  progressListEl.innerHTML = "";
  jobs.forEach((j) => {
    const row = document.createElement("div");
    row.className = "progress-row";
    row.dataset.state = j.state;
    const dot = document.createElement("div"); dot.className = "progress-dot";
    const label = document.createElement("div"); label.className = "progress-label";
    label.textContent = j.label;
    const meta = document.createElement("div"); meta.className = "progress-meta";
    meta.textContent = (j.state === "error" && j.error) ? j.error : j.state;
    if (j.error) { meta.title = j.error; row.title = j.error; }
    row.append(dot, label, meta);
    progressListEl.appendChild(row);
  });
}

/* ------------------------------------------------------------------ */
/*  base64 helpers                                                      */
/* ------------------------------------------------------------------ */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64LOOKUP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
function base64ToBytes(b64) {
  b64 = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = b64.length;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const outLen = ((len * 3) >> 2) - pad;
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64LOOKUP[b64.charCodeAt(i)];
    const b = B64LOOKUP[b64.charCodeAt(i + 1)];
    const c = B64LOOKUP[b64.charCodeAt(i + 2)];
    const d = B64LOOKUP[b64.charCodeAt(i + 3)];
    if (p < outLen) out[p++] = (a << 2) | (b >> 4);
    if (p < outLen) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < outLen) out[p++] = ((c & 3) << 6) | d;
  }
  return out;
}
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ------------------------------------------------------------------ */
/*  Gemini call                                                         */
/* ------------------------------------------------------------------ */
async function callGemini({ apiKey, model, prompt, imageBase64, mimeType }) {
  const parts = [{ text: prompt }, { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } }];
  const url = `${GEMINI_HOST}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    const m = (json && json.error && json.error.message) || `HTTP ${resp.status}`;
    throw new Error("Gemini error: " + m);
  }
  for (const cand of (json.candidates || [])) {
    for (const p of (cand.content && cand.content.parts) || []) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        return { base64: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" };
      }
    }
  }
  let text = "";
  for (const cand of (json.candidates || [])) {
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.text) text += p.text + " ";
    }
  }
  const block = json.promptFeedback && json.promptFeedback.blockReason;
  throw new Error("No image in response." + (block ? ` Blocked: ${block}.` : "") + (text ? ` ${text.trim().slice(0, 200)}` : ""));
}

/* ------------------------------------------------------------------ */
/*  Premiere helpers                                                    */
/* ------------------------------------------------------------------ */
async function getActiveSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active project. Open a project in Premiere first.");
  const seq = await project.getActiveSequence();
  if (!seq) throw new Error("No active sequence. Open a sequence in the Timeline.");
  return { project, sequence: seq };
}

// Pull marker times (in seconds) from the sequence.
async function getMarkerTimesSeconds(sequence) {
  let markers = [];
  try {
    if (typeof sequence.getMarkers === "function") {
      markers = await sequence.getMarkers();
    } else if (sequence.markers) {
      markers = await sequence.markers.getMarkers();
    }
  } catch (e) { markers = []; }
  const times = [];
  for (const m of markers || []) {
    try {
      const t = m.startTime || m.start || m.position;
      if (!t) continue;
      const seconds = typeof t.seconds === "number" ? t.seconds
                    : (typeof t === "number" ? t : (await t.getSeconds && t.getSeconds()));
      if (typeof seconds === "number") times.push(seconds);
    } catch (e) { /* skip */ }
  }
  times.sort((a, b) => a - b);
  return times;
}

// Total length of the sequence in seconds.
async function getSequenceLengthSeconds(sequence) {
  try {
    const end = sequence.endTime || (sequence.getEndTime && await sequence.getEndTime());
    if (end) {
      if (typeof end.seconds === "number") return end.seconds;
      if (end.ticks && sequence.ticksPerSecond) return end.ticks / sequence.ticksPerSecond;
    }
  } catch (e) {}
  try {
    const dur = sequence.duration || (sequence.getDuration && await sequence.getDuration());
    if (dur) {
      if (typeof dur.seconds === "number") return dur.seconds;
      if (typeof dur === "number") return dur;
    }
  } catch (e) {}
  return 60; // last-resort default
}

// Build the list of capture times (seconds).
async function buildCaptureTimes(sequence) {
  const mode = getCaptureMode();
  if (mode === "markers") {
    const times = await getMarkerTimesSeconds(sequence);
    if (!times.length) throw new Error("This sequence has no markers. Add markers, or switch to 'Every N seconds'.");
    return times;
  }
  // interval mode
  const step = Math.max(0.1, parseFloat(intervalSecondsEl.value) || 5);
  const len = await getSequenceLengthSeconds(sequence);
  const times = [];
  for (let t = 0; t < len; t += step) times.push(t);
  if (!times.length) throw new Error("Sequence is too short for the given interval.");
  return times;
}

// Frame alignment — exportSequenceFrame rejects times that aren't on a frame
// boundary, so snap the requested seconds to the nearest frame via the timebase.
async function getTicksPerFrame(sequence) {
  try {
    if (typeof sequence.getTimebase === "function") {
      const tb = await sequence.getTimebase();
      const n = Number(tb);
      if (n > 0) return n;
    }
  } catch (e) {}
  return 0;
}

async function makeFrameAlignedTickTime(sequence, seconds) {
  const tpf = await getTicksPerFrame(sequence);
  const tps = ticksPerSecond(sequence);
  if (tpf > 0) {
    const frames = Math.max(0, Math.round((seconds * tps) / tpf));
    const ticks = frames * tpf;
    try {
      if (ppro.TickTime && typeof ppro.TickTime.createWithTicks === "function") {
        return ppro.TickTime.createWithTicks(String(ticks));
      }
    } catch (e) {}
  }
  return await makeTickTime(sequence, seconds);
}

// Get the sequence's pixel dimensions (RectF from getFrameSize).
async function getSequenceFrameSize(sequence) {
  try {
    if (typeof sequence.getFrameSize === "function") {
      const r = await sequence.getFrameSize();
      const w = (r && (r.width != null ? r.width : (r.w != null ? r.w : (r.right != null && r.left != null ? r.right - r.left : null))));
      const h = (r && (r.height != null ? r.height : (r.h != null ? r.h : (r.bottom != null && r.top != null ? r.bottom - r.top : null))));
      if (w && h) return { width: Math.round(w), height: Math.round(h) };
    }
  } catch (e) {}
  try {
    if (typeof sequence.getSettings === "function") {
      const st = await sequence.getSettings();
      const w = st && (st.videoFrameWidth || st.frameWidth || (st.videoFrameRect && st.videoFrameRect.width));
      const h = st && (st.videoFrameHeight || st.frameHeight || (st.videoFrameRect && st.videoFrameRect.height));
      if (w && h) return { width: Math.round(w), height: Math.round(h) };
    }
  } catch (e) {}
  return { width: 1920, height: 1080 };
}

// Locate the file exportSequenceFrame actually produced (build/name quirks vary).
async function findProducedFile(folder, leaf) {
  const base = leaf.replace(/\.png$/i, "");
  const candidates = [leaf, leaf + ".png", base + ".png", base + ".png.png"];
  for (const n of candidates) {
    try { const e = await folder.getEntry(n); if (e && !e.isFolder) return e; } catch (ee) {}
  }
  // Fresh enumeration fallback — catches renamed/extension-appended output and
  // files written externally that getEntry's cache might miss.
  try {
    const entries = await folder.getEntries();
    for (const e of entries) {
      if (!e || e.isFolder) continue;
      const nm = e.name || "";
      if (nm === leaf || nm.indexOf(base) === 0) return e;
    }
  } catch (e) {}
  return null;
}

// Plugin-owned working folder (data/temp) — the picked-folder token can't list
// or read files on some builds, but the plugin's own storage always can.
let _workFolder = null;
async function getWorkFolder() {
  if (_workFolder) return _workFolder;
  try { _workFolder = await fs.getDataFolder(); } catch (e) {}
  if (!_workFolder) { try { _workFolder = await fs.getTemporaryFolder(); } catch (e) {} }
  return _workFolder;
}

// Read the just-exported frame. Files created by the native exporter often
// aren't visible through the original folder token (UXP cache), so try several
// strategies and collect diagnostics so we can see what works on this build.
async function readExportedFile(outFolder, folderDir, leaf, diag) {
  const dir = String(folderDir).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const base = leaf.replace(/\.png$/i, "");
  const names = [leaf + ".png", leaf, base + ".png.png", base + ".png"];

  // 1) Original folder token.
  try {
    const e = await findProducedFile(outFolder, leaf);
    if (e) { diag.push("ok:token"); return e; }
  } catch (e) { diag.push("token-err:" + (e.message || e)); }

  // List what the token sees.
  try {
    const entries = await outFolder.getEntries();
    diag.push("tokEntries(" + entries.length + "):" + entries.slice(0, 6).map((x) => x.name).join(","));
  } catch (e) { diag.push("tokList-err:" + (e.message || e)); }

  diag.push("getEntryWithUrl=" + (typeof fs.getEntryWithUrl));

  // 2) Re-resolve the folder by URL, then look inside the fresh handle.
  try {
    const folderUrl = "file:///" + dir.replace(/^\/+/, "");
    const fresh = await fs.getEntryWithUrl(folderUrl);
    if (fresh && fresh.isFolder) {
      for (const nm of names) {
        try { const e2 = await fresh.getEntry(nm); if (e2 && !e2.isFolder) { diag.push("ok:freshFolder/" + nm); return e2; } } catch (er) {}
      }
      try {
        const fe = await fresh.getEntries();
        diag.push("freshEntries(" + fe.length + "):" + fe.slice(0, 6).map((x) => x.name).join(","));
        for (const e3 of fe) {
          if (!e3.isFolder && (e3.name === leaf || e3.name.indexOf(base) === 0)) { diag.push("ok:freshScan/" + e3.name); return e3; }
        }
      } catch (er) { diag.push("freshList-err:" + (er.message || er)); }
    } else {
      diag.push("freshFolder!=folder");
    }
  } catch (e) { diag.push("freshFolder-err:" + (e.message || e)); }

  // 3) Direct file URL.
  for (const nm of names) {
    const url = "file:///" + (dir + "/" + nm).replace(/^\/+/, "");
    try {
      const ent = await fs.getEntryWithUrl(url);
      if (ent && !ent.isFolder) { diag.push("ok:fileUrl/" + nm); return ent; }
    } catch (err) { diag.push("url(" + nm + ")-err:" + (err.message || err)); }
  }

  return null;
}

// Export a frame at a given time (seconds) to a PNG in the output folder using// Export a frame at a given time (seconds) to a PNG in the output folder using
// ppro.Exporter.exportSequenceFrame (the real Premiere 25.0+ UXP API).
// Returns { file, base64, mimeType }.
async function exportFrameAt(sequence, seconds, outputFolder, indexLabel) {
  // Export to the user's chosen folder (a real path the native exporter can
  // write to); with "fullAccess" we can read it back by absolute path.
  const outFolder = outputFolder || (await getWorkFolder());
  if (!outFolder) throw new Error("Couldn't open an output folder.");
  const safeIdx = String(indexLabel).padStart(3, "0");
  const leaf = `nb_frame_${safeIdx}_${Math.round(seconds * 1000)}ms.png`;
  const folderDir = await getPlatformPathForFile(outFolder);

  if (!(ppro.Exporter && typeof ppro.Exporter.exportSequenceFrame === "function")) {
    throw new Error("ppro.Exporter.exportSequenceFrame is not available. Update Premiere Pro to 25.0 or newer.");
  }
  const { width, height } = await getSequenceFrameSize(sequence);

  // UXP can't read files created by the native exporter unless it already owns
  // the entry — so pre-create the target file(s) through UXP, let Premiere
  // overwrite the same path, then read our own tracked entry. Premiere appends
  // an extra ".png", so cover both the single- and double-extension names.
  const dblName = leaf + ".png";
  let eDouble = null, eSingle = null;
  try { eDouble = await outFolder.createFile(dblName, { overwrite: true }); } catch (e) {}
  try { eSingle = await outFolder.createFile(leaf, { overwrite: true }); } catch (e) {}

  // Move the playhead to the target time, then export the player position
  // (matches Adobe's working sample, which avoids the "returned false" problem).
  try {
    const target = await makeFrameAlignedTickTime(sequence, seconds);
    if (typeof sequence.setPlayerPosition === "function") await sequence.setPlayerPosition(target);
  } catch (e) {}
  let exportTime;
  try { exportTime = await sequence.getPlayerPosition(); }
  catch (e) { exportTime = await makeFrameAlignedTickTime(sequence, seconds); }

  let res, err = null;
  try {
    res = await ppro.Exporter.exportSequenceFrame(sequence, exportTime, leaf, folderDir, width, height);
  } catch (e) { err = (e && (e.message || String(e))) || "throw"; }

  const diag = [];

  // A) UXP-tracked pre-created entries (works if UXP reflects the overwrite).
  for (const ent of [eSingle, eDouble]) {
    if (!ent) continue;
    try {
      const buf = await ent.read({ format: formats.binary });
      const bytes = new Uint8Array(buf);
      if (bytes.byteLength > 0) return { file: ent, base64: bytesToBase64(bytes), mimeType: "image/png" };
    } catch (e) {}
  }

  // Self-test so we can tell read-after-our-own-write from read-of-external-file.
  try {
    const probe = await outFolder.createFile("nb_probe.txt", { overwrite: true });
    await probe.write("hello", { format: formats.utf8 });
    diag.push("selfRW=" + JSON.stringify(await probe.read({ format: formats.utf8 })));
  } catch (e) { diag.push("selfRW-err:" + (e.message || e)); }

  // B/C) Read the real file by absolute path (needs manifest fullAccess).
  const dir = String(folderDir).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const base = leaf.replace(/\.png$/i, "");
  const names = [leaf, leaf + ".png", base + ".png.png"];
  for (const nm of names) {
    const url = "file:///" + (dir + "/" + nm).replace(/^\/+/, "");
    // B) getEntryWithUrl + read
    try {
      const ent = await fs.getEntryWithUrl(url);
      if (ent && !ent.isFolder) {
        const buf = await ent.read({ format: formats.binary });
        const bytes = new Uint8Array(buf);
        if (bytes.byteLength > 0) return { file: ent, base64: bytesToBase64(bytes), mimeType: "image/png" };
      }
    } catch (e) { diag.push("url(" + nm + "):" + (e.message || e)); }
    // C) fetch the file URL
    try {
      const r = await fetch(url);
      if (r && r.ok) {
        const ab = await r.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes.byteLength > 0) return { file: null, base64: bytesToBase64(bytes), mimeType: "image/png" };
      } else { diag.push("fetch(" + nm + "):" + (r && r.status)); }
    } catch (e) { diag.push("fetch-err(" + nm + "):" + (e.message || e)); }
  }

  throw new Error(
    `export returned ${JSON.stringify(res)}${err ? ", error " + err : ""} but no readable bytes. ` +
    `dir "${folderDir}". Diag: ${diag.join(" | ")}`);
}

async function makeTickTime(sequence, seconds) {
  // ppro.TickTime API varies — try a few constructors.
  try {
    if (ppro.TickTime && typeof ppro.TickTime.createWithSeconds === "function") {
      return ppro.TickTime.createWithSeconds(seconds);
    }
  } catch (e) {}
  try {
    if (ppro.TickTime && typeof ppro.TickTime.fromSeconds === "function") {
      return ppro.TickTime.fromSeconds(seconds);
    }
  } catch (e) {}
  try {
    const tps = sequence.ticksPerSecond || 254016000000;
    if (ppro.TickTime && typeof ppro.TickTime.createWithTicks === "function") {
      return ppro.TickTime.createWithTicks(Math.round(seconds * tps));
    }
  } catch (e) {}
  // Fallback: return a plain { seconds } object — some methods accept this.
  return { seconds };
}

async function getPlatformPathForFile(file) {
  // UXP file entries have nativePath / platformPath / path depending on version.
  return file.nativePath || file.platformPath || file.url || file.path || "";
}

/* ------------------------------------------------------------------ */
/*  Folder picker                                                       */
/* ------------------------------------------------------------------ */
async function pickOutputFolder() {
  try {
    const folder = await fs.getFolder();
    if (!folder) return;
    outputFolderToken = folder;
    outputFolderName = folder.name || (await getPlatformPathForFile(folder));
    outputFolderLabelEl.value = outputFolderName;
    try { await savePref("outputFolderName", outputFolderName); } catch (e) {}
  } catch (e) {
    if (e && e.code !== "OPERATION_CANCELLED") {
      setStatus("Couldn't open folder picker: " + (e.message || e), "error");
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Contact sheet (HTML canvas → PNG)                                   */
/* ------------------------------------------------------------------ */
async function buildContactSheetFromBytes(panels, outFolder) {
  if (!panels.length) return null;
  const cols = panels.length >= 6 ? 4 : panels.length >= 3 ? 3 : panels.length;
  const rows = Math.ceil(panels.length / cols);
  const cellW = 640;
  const cellH = 360;
  const pad = 16;
  const labelH = 28;
  const titleH = 40;
  const totalW = pad + cols * (cellW + pad);
  const totalH = titleH + rows * (cellH + labelH + pad) + pad;
  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.fillStyle = "#222";
  ctx.font = "bold 20px sans-serif";
  ctx.textBaseline = "top";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  ctx.fillText(`Storyboard contact sheet — ${stamp}`, pad, pad);
  for (let i = 0; i < panels.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cellW + pad);
    const y = titleH + pad + row * (cellH + labelH + pad);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, cellW + 2, cellH + 2);
    const dataUrl = `data:${panels[i].mimeType || "image/png"};base64,${panels[i].base64}`;
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const ar = img.width / img.height;
        const cellAR = cellW / cellH;
        let dw, dh, dx, dy;
        if (ar > cellAR) { dw = cellW; dh = cellW / ar; dx = x; dy = y + (cellH - dh) / 2; }
        else { dh = cellH; dw = cellH * ar; dx = x + (cellW - dw) / 2; dy = y; }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x, y, cellW, cellH);
        ctx.drawImage(img, dx, dy, dw, dh);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = dataUrl;
    });
    ctx.fillStyle = "#222";
    ctx.font = "600 14px sans-serif";
    ctx.fillText(panels[i].label, x, y + cellH + 6);
  }
  const dataUrl = canvas.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1];
  const bytes = base64ToBytes(b64);
  const sheetFile = await outFolder.createFile(`storyboard_sheet_${Date.now()}.png`, { overwrite: true });
  await sheetFile.write(bytes.buffer, { format: formats.binary });
  return sheetFile;
}

/* ------------------------------------------------------------------ */
/*  Project import (markers/interval mode)                              */
/* ------------------------------------------------------------------ */
async function importFilesToBin(project, files, binName) {
  if (!files.length) return;
  const paths = [];
  for (const f of files) {
    const p = await getPlatformPathForFile(f);
    if (p) paths.push(p);
  }
  if (!paths.length) return;
  try {
    if (typeof project.importFiles === "function") { await project.importFiles(paths); return; }
  } catch (e) {}
  try {
    if (ppro.ProjectUtils && typeof ppro.ProjectUtils.importFiles === "function") {
      await ppro.ProjectUtils.importFiles(project, paths); return;
    }
  } catch (e) {}
  setStatus(
    "Storyboard frames saved to the output folder, but this Premiere build " +
    "didn't accept programmatic import. Drag the folder into your project bin manually.",
    "success"
  );
}

/* ------------------------------------------------------------------ */
/*  Capture mode UI                                                     */
/* ------------------------------------------------------------------ */
function getCaptureMode() {
  const active = captureModeEl.querySelector(".seg-btn.active");
  return active ? active.dataset.value : "v1clips";
}
const MODE_HINTS = {
  v1clips: "Sketches the middle frame of every clip on the V1 video track and lays each result on V2, trimmed to match the clip below it.",
  markers: "Captures one frame at each marker on the active sequence, sketches it, and saves to the output folder.",
  interval: "Captures one frame every N seconds across the sequence, sketches each, and saves to the output folder.",
};
function setV1Busy(b) {
  [btnOneClickEl, btnExportEl, btnPlaceEl, goBtn, cancelBtn].forEach((x) => {
    if (x && x !== cancelBtn) x.disabled = b;
  });
}
function applyModeUI() {
  const mode = getCaptureMode();
  intervalFieldEl.style.display = mode === "interval" ? "block" : "none";
  const isV1 = mode === "v1clips";
  v1OptionsEl.style.display = isV1 ? "block" : "none";
  captureOptionsEl.style.display = isV1 ? "none" : "block";
  if (modeHintEl) modeHintEl.textContent = MODE_HINTS[mode] || "";
  goBtn.style.display = isV1 ? "none" : "block";
  goBtn.textContent = "Generate storyboard from sequence";
}
captureModeEl.querySelectorAll(".seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    captureModeEl.querySelectorAll(".seg-btn").forEach((x) =>
      x.classList.toggle("active", x === b));
    applyModeUI();
    savePref("captureMode", getCaptureMode());
  });
});

/* ================================================================== */
/*  V1 clips → V2 sketch placement                                      */
/* ================================================================== */

const TICKS_PER_SECOND = 254016000000; // Premiere's fixed tick rate.

function ticksPerSecond(sequence) {
  try {
    if (ppro.TickTime && ppro.TickTime.TICKS_PER_SECOND) return ppro.TickTime.TICKS_PER_SECOND;
  } catch (e) {}
  return (sequence && sequence.ticksPerSecond) || TICKS_PER_SECOND;
}

// Normalise any TickTime-ish value to seconds.
function tickToSeconds(t, sequence) {
  if (t == null) return null;
  if (typeof t === "number") return t;
  if (typeof t.seconds === "number") return t.seconds;
  if (typeof t.ticks === "number") return t.ticks / ticksPerSecond(sequence);
  if (typeof t.ticksNumber === "number") return t.ticksNumber / ticksPerSecond(sequence);
  if (typeof t.ticks === "string" && /^\d+$/.test(t.ticks)) return Number(t.ticks) / ticksPerSecond(sequence);
  return null;
}

async function secondsToTickTime(sequence, seconds) {
  return await makeTickTime(sequence, seconds);
}

// Get a TickTime's tick count as a string (no float precision loss).
function tickToTicksString(t, sequence) {
  if (t == null) return null;
  if (typeof t.ticks === "string" && /^\d+$/.test(t.ticks)) return t.ticks;
  if (typeof t.ticksNumber === "number") return String(Math.round(t.ticksNumber));
  if (typeof t.ticks === "number") return String(Math.round(t.ticks));
  const sec = tickToSeconds(t, sequence);
  if (sec == null) return null;
  return String(Math.round(sec * ticksPerSecond(sequence)));
}

function makeTickTimeFromTicks(ticksStr) {
  try {
    if (ppro.TickTime && typeof ppro.TickTime.createWithTicks === "function") {
      return ppro.TickTime.createWithTicks(String(ticksStr));
    }
  } catch (e) {}
  return null;
}

// How many video tracks does the sequence have?
async function getVideoTrackCount(sequence) {
  try {
    if (typeof sequence.getVideoTrackCount === "function") return await sequence.getVideoTrackCount();
  } catch (e) {}
  try {
    if (sequence.videoTracks && typeof sequence.videoTracks.numTracks === "number") return sequence.videoTracks.numTracks;
  } catch (e) {}
  try {
    if (sequence.videoTracks && typeof sequence.videoTracks.length === "number") return sequence.videoTracks.length;
  } catch (e) {}
  return 0;
}

async function getVideoTrack(sequence, index) {
  try {
    if (typeof sequence.getVideoTrack === "function") return await sequence.getVideoTrack(index);
  } catch (e) {}
  try {
    if (sequence.videoTracks && typeof sequence.videoTracks.getTrackAt === "function") return await sequence.videoTracks.getTrackAt(index);
  } catch (e) {}
  try {
    if (sequence.videoTracks && sequence.videoTracks[index]) return sequence.videoTracks[index];
  } catch (e) {}
  return null;
}

// Return real clip items (not gaps) on a track, sorted by start time.
async function getClipItems(track, sequence) {
  let items = [];
  const clipType =
    (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) ||
    (ppro.TrackItemType && ppro.TrackItemType.CLIP) || 1;
  try {
    if (typeof track.getTrackItems === "function") {
      try { items = await track.getTrackItems(clipType, false); }
      catch (e) { items = await track.getTrackItems(); }
    } else if (track.clips && typeof track.clips.getTrackItems === "function") {
      items = await track.clips.getTrackItems();
    } else if (Array.isArray(track.trackItems)) {
      items = track.trackItems;
    }
  } catch (e) { items = []; }

  const out = [];
  for (const it of items || []) {
    try {
      const startRaw = (typeof it.getStartTime === "function") ? await it.getStartTime() : (it.start || it.startTime);
      const endRaw = (typeof it.getEndTime === "function") ? await it.getEndTime() : (it.end || it.endTime);
      const startSec = tickToSeconds(startRaw, sequence);
      const endSec = tickToSeconds(endRaw, sequence);
      if (startSec == null || endSec == null || endSec <= startSec) continue;
      const startTicks = tickToTicksString(startRaw, sequence);
      const endTicks = tickToTicksString(endRaw, sequence);
      let name = "clip";
      try { name = (typeof it.getName === "function") ? await it.getName() : (it.name || "clip"); } catch (e) {}
      out.push({ item: it, startSec, endSec, midSec: (startSec + endSec) / 2, startTicks, endTicks, name });
    } catch (e) { /* skip unreadable item */ }
  }
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

// Find the lowest video track that actually holds clips (the V1 the user means).
async function findSourceClips(sequence) {
  const count = await getVideoTrackCount(sequence);
  if (!count) throw new Error("Couldn't read any video tracks from the active sequence.");
  for (let i = 0; i < count; i++) {
    const track = await getVideoTrack(sequence, i);
    if (!track) continue;
    const clips = await getClipItems(track, sequence);
    if (clips.length) return { sourceIndex: i, track, clips, trackCount: count };
  }
  throw new Error("No clips found on any video track. Open the nested sequence that has your hold-frame clips on V1.");
}

function normPath(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }
function samePath(a, b) { return normPath(a) === normPath(b); }

async function getProjectItemMediaPath(pi) {
  try { if (typeof pi.getMediaFilePath === "function") return await pi.getMediaFilePath(); } catch (e) {}
  try { if (pi.getMediaPath) return await pi.getMediaPath(); } catch (e) {}
  try { if (pi.mediaPath) return pi.mediaPath; } catch (e) {}
  return null;
}

// Recursively collect every ProjectItem under the root.
async function collectProjectItems(project) {
  const out = [];
  let root = null;
  try { root = (typeof project.getRootItem === "function") ? await project.getRootItem() : project.rootItem; } catch (e) {}
  if (!root) return out;
  async function walk(node) {
    let kids = [];
    try { kids = (typeof node.getItems === "function") ? await node.getItems() : (node.children || []); } catch (e) { kids = []; }
    for (const k of kids || []) {
      out.push(k);
      try {
        const isBin = (typeof k.getItems === "function") || (k.children && k.children.length);
        if (isBin) await walk(k);
      } catch (e) {}
    }
  }
  await walk(root);
  return out;
}

async function listAllProjectItemPaths(project) {
  const set = new Set();
  const items = await collectProjectItems(project);
  for (const pi of items) {
    try { const mp = await getProjectItemMediaPath(pi); if (mp) set.add(normPath(mp)); } catch (e) {}
  }
  return set;
}

// Import one file and return its ProjectItem.
async function importStillAndGetItem(project, file) {
  const path = await getPlatformPathForFile(file);
  if (!path) throw new Error("Couldn't resolve a disk path for the sketched still.");

  const before = await listAllProjectItemPaths(project);

  let imported = false;
  try {
    if (typeof project.importFiles === "function") {
      await project.importFiles([path], true);
      imported = true;
    }
  } catch (e) {}
  if (!imported) {
    try {
      if (ppro.ProjectUtils && typeof ppro.ProjectUtils.importFiles === "function") {
        await ppro.ProjectUtils.importFiles(project, [path]);
        imported = true;
      }
    } catch (e) {}
  }
  if (!imported) throw new Error("This Premiere build didn't accept programmatic import.");

  const fileName = file.name;
  const after = await collectProjectItems(project);
  let match = null;
  for (const pi of after) {
    try {
      const n = (typeof pi.getName === "function") ? await pi.getName() : pi.name;
      const mp = await getProjectItemMediaPath(pi);
      if ((mp && samePath(mp, path)) || (n && n === fileName)) { match = pi; break; }
    } catch (e) {}
  }
  if (!match) {
    for (const pi of after) {
      try {
        const mp = await getProjectItemMediaPath(pi);
        if (mp && !before.has(normPath(mp))) { match = pi; break; }
      } catch (e) {}
    }
  }
  if (!match) throw new Error("Imported the still but couldn't find it in the project to place it.");
  return match;
}

// Run a Premiere edit transaction (lockedAccess + executeTransaction).
async function runTransaction(project, build, label) {
  if (typeof project.executeTransaction !== "function") {
    throw new Error("No transaction API on this Premiere build.");
  }
  const doTx = () => project.executeTransaction((c) => build(c), label || "Nano Banana edit");
  if (typeof project.lockedAccess === "function") {
    let err = null;
    const r = project.lockedAccess(() => { try { doTx(); } catch (e) { err = e; } });
    if (r && typeof r.then === "function") await r;
    if (err) throw err;
    return;
  }
  const r = doTx();
  if (r && typeof r.then === "function") await r;
}

async function getSequenceEditor(sequence) {
  try {
    if (ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === "function") {
      return await ppro.SequenceEditor.getEditor(sequence);
    }
  } catch (e) {}
  return null;
}

// Trim a still's source in/out so an overwrite places exactly durSec of it.
async function setStillDuration(project, projectItem, durSec, sequence) {
  const inTT = await secondsToTickTime(sequence, 0);
  const outTT = await secondsToTickTime(sequence, durSec);
  // Preferred: action-based in/out on the projectItem, run in a transaction.
  try {
    if (typeof projectItem.createSetInPointAction === "function" &&
        typeof projectItem.createSetOutPointAction === "function") {
      await runTransaction(project, (compound) => {
        compound.addAction(projectItem.createSetInPointAction(inTT));
        compound.addAction(projectItem.createSetOutPointAction(outTT));
      }, "Set still in/out");
      return true;
    }
  } catch (e) {}
  // Some builds want a media-type argument on the actions.
  try {
    if (typeof projectItem.createSetInPointAction === "function" &&
        typeof projectItem.createSetOutPointAction === "function") {
      const mediaVideo = (ppro.Constants && ppro.Constants.MediaType && ppro.Constants.MediaType.VIDEO) || 1;
      await runTransaction(project, (compound) => {
        compound.addAction(projectItem.createSetInPointAction(inTT, mediaVideo));
        compound.addAction(projectItem.createSetOutPointAction(outTT, mediaVideo));
      }, "Set still in/out");
      return true;
    }
  } catch (e) {}
  // Direct setters (older shapes).
  try {
    if (typeof projectItem.setInPoint === "function" && typeof projectItem.setOutPoint === "function") {
      await projectItem.setInPoint(inTT);
      await projectItem.setOutPoint(outTT);
      return true;
    }
  } catch (e) {}
  return false;
}

// Overwrite projectItem onto videoTrackIndex at startSec (no ripple). Throws on failure.
async function overwriteOntoTrack(project, sequence, projectItem, startSec, videoTrackIndex) {
  const startTT = await secondsToTickTime(sequence, startSec);
  const seqEditor = await getSequenceEditor(sequence);
  if (!seqEditor || typeof seqEditor.createOverwriteItemAction !== "function") {
    throw new Error("SequenceEditor.createOverwriteItemAction unavailable (needs Premiere 25.0+).");
  }
  const audioTrackIndex = 0; // stills carry no audio, so the A-track is untouched.
  await runTransaction(project, (compound) => {
    compound.addAction(
      seqEditor.createOverwriteItemAction(projectItem, startTT, videoTrackIndex, audioTrackIndex));
  }, "Place sketch on V2");
  return true;
}

/* ================================================================== */
/*  Two-phase V1 -> V2 (export frames, sketch externally, place)        */
/* ================================================================== */

const STORE_KEY = "v1v2_manifest";

// Export a frame to a folder without reading it back (avoids the UXP read wall).
async function exportFrameOnly(sequence, seconds, outFolder, name) {
  const folderDir = await getPlatformPathForFile(outFolder);
  if (!(ppro.Exporter && typeof ppro.Exporter.exportSequenceFrame === "function")) {
    throw new Error("ppro.Exporter.exportSequenceFrame unavailable (needs Premiere 25.0+).");
  }
  const { width, height } = await getSequenceFrameSize(sequence);
  try {
    const target = await makeFrameAlignedTickTime(sequence, seconds);
    if (typeof sequence.setPlayerPosition === "function") await sequence.setPlayerPosition(target);
  } catch (e) {}
  let exportTime;
  try { exportTime = await sequence.getPlayerPosition(); }
  catch (e) { exportTime = await makeFrameAlignedTickTime(sequence, seconds); }
  return await ppro.Exporter.exportSequenceFrame(sequence, exportTime, name, folderDir, width, height);
}

// Import a file by absolute path (Premiere reads it natively — no UXP read needed).
async function importByPathAndGetItem(project, path, fileName) {
  const before = await listAllProjectItemPaths(project);
  let imported = false;
  try { if (typeof project.importFiles === "function") { await project.importFiles([path], true); imported = true; } } catch (e) {}
  if (!imported) {
    try { if (ppro.ProjectUtils && typeof ppro.ProjectUtils.importFiles === "function") { await ppro.ProjectUtils.importFiles(project, [path]); imported = true; } } catch (e) {}
  }
  if (!imported) throw new Error("programmatic import not supported on this build");
  const after = await collectProjectItems(project);
  // 1) Exact media-path match — uniquely identifies THIS folder's file, so an
  //    identically-named sketch imported from a previous run/folder (e.g. v05
  //    vs v06) is never picked by mistake.
  for (const pi of after) {
    try { const mp = await getProjectItemMediaPath(pi); if (mp && samePath(mp, path)) return pi; } catch (e) {}
  }
  // 2) A newly-added item whose path was not present before this import.
  for (const pi of after) {
    try { const mp = await getProjectItemMediaPath(pi); if (mp && !before.has(normPath(mp))) return pi; } catch (e) {}
  }
  // 3) Last resort: match by file name.
  for (const pi of after) {
    try { const n = (typeof pi.getName === "function") ? await pi.getName() : pi.name; if (n && n === fileName) return pi; } catch (e) {}
  }
  throw new Error("imported but couldn't find it in the project to place");
}

async function setStillDurationTicks(project, projectItem, durTicksStr) {
  const inTT = makeTickTimeFromTicks("0");
  const outTT = makeTickTimeFromTicks(durTicksStr);
  if (!inTT || !outTT) return false;
  try {
    if (typeof projectItem.createSetInPointAction === "function" && typeof projectItem.createSetOutPointAction === "function") {
      await runTransaction(project, (c) => {
        c.addAction(projectItem.createSetInPointAction(inTT));
        c.addAction(projectItem.createSetOutPointAction(outTT));
      }, "Set still in/out");
      return true;
    }
  } catch (e) {}
  try {
    if (typeof projectItem.createSetInPointAction === "function" && typeof projectItem.createSetOutPointAction === "function") {
      const mv = (ppro.Constants && ppro.Constants.MediaType && ppro.Constants.MediaType.VIDEO) || 1;
      await runTransaction(project, (c) => {
        c.addAction(projectItem.createSetInPointAction(inTT, mv));
        c.addAction(projectItem.createSetOutPointAction(outTT, mv));
      }, "Set still in/out");
      return true;
    }
  } catch (e) {}
  return false;
}

async function overwriteItemAt(project, sequence, projectItem, startTT, videoTrackIndex) {
  if (!startTT) throw new Error("bad start time");
  const seqEditor = await getSequenceEditor(sequence);
  if (!seqEditor || typeof seqEditor.createOverwriteItemAction !== "function") {
    throw new Error("SequenceEditor.createOverwriteItemAction unavailable (needs Premiere 25.0+).");
  }
  await runTransaction(project, (c) => {
    c.addAction(seqEditor.createOverwriteItemAction(projectItem, startTT, videoTrackIndex, 0));
  }, "Place sketch on V2");
  return true;
}

// PHASE 1 — export a frame per V1 clip + write a manifest.
/* ------------------------------------------------------------------ */
/*  Auto-generated Python sketch runner (written into the export folder) */
/* ------------------------------------------------------------------ */
// A self-contained Python script (stdlib only) that reads the manifest/frames
// in its own folder, sketches each via Gemini, and writes sketch_NNN.png.
// NOTE: kept free of backslashes so it embeds safely in this template literal.
const PY_SKETCH = `import sys, os, json, base64, urllib.request, urllib.error, urllib.parse

MODELS = {'nb2': 'gemini-2.5-flash-image', 'pro': 'gemini-3-pro-image-preview'}
HOST = 'https://generativelanguage.googleapis.com/v1beta/models'

def read_text(path):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read()
    except OSError:
        return ''

def read_key(folder, script_dir):
    for p in (os.path.join(folder, 'apikey.txt'), os.path.join(script_dir, 'apikey.txt')):
        for line in read_text(p).splitlines():
            t = line.strip()
            if t and not t.startswith('#'):
                return t
    return (os.environ.get('GEMINI_API_KEY') or '').strip()

def load_prompt(folder, script_dir):
    for p in (os.path.join(folder, 'prompt.txt'), os.path.join(script_dir, 'prompt.txt')):
        txt = read_text(p).strip()
        if txt:
            return txt
    return 'Redraw this image as a rough black and white storyboard pencil sketch. Draw all characters (including robots) in red; everything else in grey pencil. Loose and gestural, not 3D, no colour except red.'

def call_gemini(api_key, model, prompt, b64, mime):
    url = HOST + '/' + model + ':generateContent?key=' + urllib.parse.quote(api_key)
    body = {'contents': [{'parts': [{'text': prompt}, {'inlineData': {'mimeType': mime, 'data': b64}}]}]}
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode('utf-8')).get('error', {}).get('message', str(e))
        except Exception:
            msg = str(e)
        raise RuntimeError(msg)
    for cand in payload.get('candidates', []):
        for part in (cand.get('content', {}) or {}).get('parts', []):
            inline = part.get('inlineData') or part.get('inline_data')
            if inline and inline.get('data'):
                return inline['data']
    block = (payload.get('promptFeedback') or {}).get('blockReason')
    raise RuntimeError('no image in response' + ((' blocked: ' + block) if block else ''))

def resolve_existing(folder, name):
    for cand in (name, name + '.png'):
        p = os.path.join(folder, cand)
        if os.path.exists(p):
            return p
    return None

def list_items(folder):
    mf = os.path.join(folder, 'manifest.json')
    if os.path.exists(mf):
        try:
            data = json.loads(read_text(mf))
            clips = data.get('clips') or []
            if clips:
                return [(c.get('frameName'), c.get('sketchName')) for c in clips]
        except Exception:
            pass
    items = []
    for n in sorted(os.listdir(folder)):
        low = n.lower()
        if low.startswith('frame_') and low.endswith('.png'):
            base = n[:-4] if n.lower().endswith('.png.png') else n
            idx = ''.join(ch for ch in base if ch.isdigit())
            items.append((n, 'sketch_' + idx + '.png'))
    return items

def main():
    args = sys.argv[1:]
    folder = None
    for a in args:
        if not a.startswith('--'):
            folder = a
            break
    model = MODELS['pro'] if '--pro' in args else MODELS['nb2']
    force = '--force' in args
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if not folder:
        folder = script_dir
    if not os.path.isdir(folder):
        print('Folder not found: ' + folder)
        return
    api_key = read_key(folder, script_dir)
    if not api_key:
        print('No API key. Put it in apikey.txt or set GEMINI_API_KEY.')
        return
    prompt = load_prompt(folder, script_dir)
    items = list_items(folder)
    if not items:
        print('No frames (frame_NNN.png) found in ' + folder)
        return
    print('Sketching ' + str(len(items)) + ' frame(s) with ' + model + '  (Ctrl+C to cancel)')
    ok = skipped = fail = 0
    try:
        for i, (frame, sketch) in enumerate(items, 1):
            outp = os.path.join(folder, sketch)
            if (not force) and os.path.exists(outp) and os.path.getsize(outp) > 0:
                print('  [' + str(i) + '/' + str(len(items)) + '] ' + sketch + ' exists - skipped')
                skipped += 1
                continue
            src = resolve_existing(folder, frame)
            if not src:
                print('  [' + str(i) + '/' + str(len(items)) + '] missing ' + str(frame) + ' - skipped')
                fail += 1
                continue
            try:
                with open(src, 'rb') as fh:
                    b64 = base64.b64encode(fh.read()).decode('ascii')
                print('  [' + str(i) + '/' + str(len(items)) + '] ' + frame + ' -> ' + sketch + ' ... ', end='', flush=True)
                out_b64 = call_gemini(api_key, model, prompt, b64, 'image/png')
                with open(outp, 'wb') as fh:
                    fh.write(base64.b64decode(out_b64))
                print('ok')
                ok += 1
            except Exception as e:
                print('FAILED: ' + str(e))
                fail += 1
    except KeyboardInterrupt:
        print('Cancelled. Finished sketches are kept; re-run to resume.')
    print('Done. ' + str(ok) + ' sketched, ' + str(skipped) + ' skipped, ' + str(fail) + ' failed. Now click 2 - Place sketches on V2 in Premiere.')

if __name__ == '__main__':
    main()
`;

function buildSketchBat(key) {
  const lines = [
    "@echo off",
    "setlocal",
    key ? ('set "GEMINI_API_KEY=' + key + '"') : "",
    'cd /d "%~dp0"',
    'python sketch_frames.py "%CD%" || py sketch_frames.py "%CD%"',
    "echo.",
    "echo Done. Close this window, then click 2 - Place sketches on V2 in Premiere.",
    "pause",
  ].filter(Boolean);
  return lines.join("\r\n") + "\r\n";
}

async function tryOpenPath(nativePath) {
  try {
    const shell = uxp.shell || (uxp.host && uxp.host.shell);
    if (shell) {
      if (typeof shell.openPath === "function") { await shell.openPath(nativePath); return true; }
      if (typeof shell.openExternal === "function") {
        const url = "file:///" + String(nativePath).replace(/\\/g, "/").replace(/^\/+/, "");
        await shell.openExternal(url); return true;
      }
    }
  } catch (e) {}
  return false;
}

// Write sketch_frames.py + prompt.txt + run_sketch.bat into the folder and try
// to launch the .bat (which opens a cmd window and runs the Python sketch step).
// ---- Backgrounds kit: character-removal Python + launcher (backslash-free) ----
const PY_REMOVE = `import sys, os, base64, json, urllib.request, urllib.error, urllib.parse

MODELS = {'nb2': 'gemini-2.5-flash-image', 'pro': 'gemini-3-pro-image-preview'}
HOST = 'https://generativelanguage.googleapis.com/v1beta/models'
EXTS = ('.png', '.jpg', '.jpeg', '.webp')
MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}
PROMPT = ('Remove ALL characters from this image, leaving only the empty background environment. '
          'A character is any person, humanoid, creature, animal, alien, OR robot / droid / mechanical being - '
          'including any round, ball, dome or spherical robots even when they look like an object. '
          'Erase every character completely and realistically reconstruct (inpaint) the background that was behind them, '
          'matching the existing lighting, perspective, textures, colours and art style so it looks like a natural, '
          'untouched empty plate of the same scene. Keep the camera angle, framing and composition identical. '
          'Do not add any new objects, people or creatures. Output only the cleaned background image.')

def read_key(folder, script_dir):
    for p in (os.path.join(folder, 'apikey.txt'), os.path.join(script_dir, 'apikey.txt')):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for line in fh:
                    t = line.strip()
                    if t and not t.startswith('#'):
                        return t
        except OSError:
            pass
    return (os.environ.get('GEMINI_API_KEY') or '').strip()

def call_gemini(api_key, model, b64, mime):
    url = HOST + '/' + model + ':generateContent?key=' + urllib.parse.quote(api_key)
    body = {'contents': [{'parts': [{'text': PROMPT}, {'inlineData': {'mimeType': mime, 'data': b64}}]}]}
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode('utf-8')).get('error', {}).get('message', str(e))
        except Exception:
            msg = str(e)
        raise RuntimeError(msg)
    for cand in payload.get('candidates', []):
        for part in (cand.get('content', {}) or {}).get('parts', []):
            inline = part.get('inlineData') or part.get('inline_data')
            if inline and inline.get('data'):
                return inline['data']
    block = (payload.get('promptFeedback') or {}).get('blockReason')
    raise RuntimeError('no image in response' + ((' blocked: ' + block) if block else ''))

def main():
    args = sys.argv[1:]
    folder = None
    for a in args:
        if not a.startswith('--'):
            folder = a
            break
    model = MODELS['pro'] if '--pro' in args else MODELS['nb2']
    force = '--force' in args
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if not folder:
        folder = script_dir
    if not os.path.isdir(folder):
        print('Folder not found: ' + folder)
        return
    api_key = read_key(folder, script_dir)
    if not api_key:
        print('No API key. Put it in apikey.txt or set GEMINI_API_KEY.')
        return
    out_dir = os.path.join(folder, 'plates')
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(n for n in os.listdir(folder) if os.path.splitext(n)[1].lower() in EXTS and os.path.isfile(os.path.join(folder, n)))
    if not files:
        print('No images here yet. Put the shots you want cleaned in this folder and run again.')
        return
    print('Removing characters from ' + str(len(files)) + ' image(s) with ' + model + '  (Ctrl+C to cancel)')
    ok = skipped = fail = 0
    try:
        for i, name in enumerate(files, 1):
            outp = os.path.join(out_dir, os.path.splitext(name)[0] + '.png')
            if (not force) and os.path.exists(outp) and os.path.getsize(outp) > 0:
                print('  [' + str(i) + '/' + str(len(files)) + '] ' + name + ' already done - skipped')
                skipped += 1
                continue
            ext = os.path.splitext(name)[1].lower()
            try:
                with open(os.path.join(folder, name), 'rb') as fh:
                    b64 = base64.b64encode(fh.read()).decode('ascii')
                print('  [' + str(i) + '/' + str(len(files)) + '] ' + name + ' ... ', end='', flush=True)
                out_b64 = call_gemini(api_key, model, b64, MIME.get(ext, 'image/png'))
                with open(outp, 'wb') as fh:
                    fh.write(base64.b64decode(out_b64))
                print('ok')
                ok += 1
            except Exception as e:
                print('FAILED: ' + str(e))
                fail += 1
    except KeyboardInterrupt:
        print('Cancelled. Finished plates are kept; re-run to resume.')
    print('Done. ' + str(ok) + ' cleaned, ' + str(skipped) + ' skipped, ' + str(fail) + ' failed. Output is in the plates subfolder.')

if __name__ == '__main__':
    main()
`;

function buildRemoveBat(key) {
  const lines = [
    "@echo off",
    "setlocal",
    key ? ('set "GEMINI_API_KEY=' + key + '"') : "",
    'cd /d "%~dp0"',
    "echo Put the shots you want cleaned into THIS folder, then this removes",
    "echo the characters into a 'plates' subfolder.",
    "echo.",
    'python remove_characters.py "%CD%" || py remove_characters.py "%CD%"',
    "echo.",
    "pause",
  ].filter(Boolean);
  return lines.join("\r\n") + "\r\n";
}

// Create a "backgrounds" subfolder with the removal script + its launcher.
async function writeBackgroundsKit(folder, key) {
  const out = { ok: false };
  try {
    let bg = null;
    try { bg = await folder.createFolder("backgrounds"); }
    catch (e) { try { bg = await folder.getEntry("backgrounds"); } catch (e2) {} }
    if (!bg) throw new Error("couldn't create backgrounds folder");
    const py = await bg.createFile("remove_characters.py", { overwrite: true });
    await py.write(PY_REMOVE, { format: formats.utf8 });
    const bat = await bg.createFile("run_remove_characters.bat", { overwrite: true });
    await bat.write(buildRemoveBat(key), { format: formats.utf8 });
    out.ok = true;
    out.path = await getPlatformPathForFile(bg);
  } catch (e) { out.error = e.message || String(e); }
  return out;
}

async function writeAndRunSketch(folder) {
  const out = { launched: false };
  try {
    const fpy = await folder.createFile("sketch_frames.py", { overwrite: true });
    await fpy.write(PY_SKETCH, { format: formats.utf8 });
    const fpr = await folder.createFile("prompt.txt", { overwrite: true });
    await fpr.write(STORYBOARD_PROMPT, { format: formats.utf8 });
    const key = (apiKeyEl.value || "").trim();
    const fbat = await folder.createFile("run_sketch.bat", { overwrite: true });
    await fbat.write(buildSketchBat(key), { format: formats.utf8 });
    out.batPath = await getPlatformPathForFile(fbat);
    out.launched = await tryOpenPath(out.batPath);
    out.bg = await writeBackgroundsKit(folder, key);
  } catch (e) { out.error = e.message || String(e); }
  return out;
}

async function exportFramesPhase() {
  cancelRequested = false;
  if (!outputFolderToken) { setStatus("Choose an output folder first.", "error"); return; }
  btnExportEl.disabled = true; btnPlaceEl.disabled = true;
  jobs.length = 0;
  try {
    setStatus("Reading active sequence…", "working");
    const { sequence } = await getActiveSequence();
    const { sourceIndex, clips, trackCount } = await findSourceClips(sequence);
    const targetIndex = sourceIndex + 1;
    if (targetIndex >= trackCount) {
      throw new Error(`Found ${clips.length} clip(s) on V${sourceIndex + 1}, but there's no track above. Add an empty V${targetIndex + 1} and run again.`);
    }
    const folderDir = String(await getPlatformPathForFile(outputFolderToken)).replace(/\\/g, "/").replace(/\/+$/, "");
    const manifest = { folderDir, targetIndex, createdAt: new Date().toISOString(), clips: [] };
    clips.forEach((c, i) => {
      const idx = String(i + 1).padStart(3, "0");
      manifest.clips.push({
        i: i + 1, name: c.name,
        frameName: `frame_${idx}.png`, sketchName: `sketch_${idx}.png`,
        startTicks: c.startTicks, durTicks: String(Number(c.endTicks) - Number(c.startTicks)),
        midSec: c.midSec,
      });
      jobs.push({ id: i + 1, label: `Clip ${i + 1} — ${c.name}`, state: "queued", midSec: c.midSec, frameName: `frame_${idx}.png` });
    });
    renderProgress();

    let ok = 0, fail = 0;
    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { setStatus("Cancelled.", "error"); break; }
      const job = jobs[i]; job.state = "running"; renderProgress();
      setStatus(`Exporting frame ${i + 1} of ${jobs.length}…`, "working");
      try {
        const r = await exportFrameOnly(sequence, job.midSec, outputFolderToken, job.frameName);
        if (r === false) throw new Error("exporter returned false");
        ok++; job.state = "done";
      } catch (e) { fail++; job.error = e.message || String(e); job.state = "error"; }
      renderProgress();
    }

    try {
      const mf = await outputFolderToken.createFile("manifest.json", { overwrite: true });
      await mf.write(JSON.stringify(manifest, null, 2), { format: formats.utf8 });
    } catch (e) {}
    try { savePref(STORE_KEY, JSON.stringify(manifest)); } catch (e) {}

    setStatus(`Step 1 done: ${ok} frame(s) exported${fail ? `, ${fail} failed` : ""}. Writing sketch runner…`, "working");
    const gen = await writeAndRunSketch(outputFolderToken);
    let tail;
    if (gen.launched) tail = " A command window is running the sketch step now — wait for it to finish, then click step 2.";
    else if (gen.batPath) tail = ` Couldn't auto-launch — double-click "run_sketch.bat" in the output folder, then click step 2.`;
    else tail = ` Couldn't write the runner${gen.error ? " (" + gen.error + ")" : ""}; run sketch_frames.js manually instead.`;
    if (gen.bg && gen.bg.ok) tail += ` Also created a "backgrounds" folder — drop shots in it and run run_remove_characters.bat for clean plates.`;
    setStatus(`Step 1 done: ${ok} frame(s) exported${fail ? `, ${fail} failed` : ""}.` + tail, fail ? "" : "success");
  } catch (err) {
    setStatus("Error: " + (err.message || err), "error");
  } finally {
    btnExportEl.disabled = false; btnPlaceEl.disabled = false;
  }
}

// PHASE 2 — import each sketch and overwrite it onto V2 at the saved timing.
// Read manifest.json from the user's currently-selected output folder.
async function readManifestFromFolder(folderToken, folderDir) {
  try {
    const e = await folderToken.getEntry("manifest.json");
    if (e && !e.isFolder) {
      const txt = await e.read({ format: formats.utf8 });
      if (txt) return JSON.parse(txt);
    }
  } catch (e) {}
  try {
    const url = "file:///" + (folderDir + "/manifest.json").replace(/^\/+/, "");
    const e = await fs.getEntryWithUrl(url);
    if (e && !e.isFolder) {
      const txt = await e.read({ format: formats.utf8 });
      if (txt) return JSON.parse(txt);
    }
  } catch (e) {}
  return null;
}

function normName(n) { return String(n || "").trim().toLowerCase(); }

async function getFolderItems(folderItem) {
  try { if (folderItem && typeof folderItem.getItems === "function") return await folderItem.getItems(); } catch (e) {}
  try {
    if (ppro.FolderItem && typeof ppro.FolderItem.cast === "function") {
      const fi = ppro.FolderItem.cast(folderItem);
      if (fi && typeof fi.getItems === "function") return await fi.getItems();
    }
  } catch (e) {}
  return [];
}

async function placeSketchesPhase() {
  cancelRequested = false;
  btnExportEl.disabled = true; btnPlaceEl.disabled = true;
  jobs.length = 0;
  try {
    if (!outputFolderToken) throw new Error("Choose the output folder (the one holding this run's sketches + manifest.json) first.");
    const folderDir = String(await getPlatformPathForFile(outputFolderToken)).replace(/\\/g, "/").replace(/\/+$/, "");
    let manifest = await readManifestFromFolder(outputFolderToken, folderDir);
    if (!manifest) {
      const raw = loadPref(STORE_KEY, "");
      if (!raw) throw new Error("No manifest.json in the selected folder, and none saved. Run step 1 into this folder first.");
      manifest = JSON.parse(raw);
    }
    manifest.folderDir = folderDir;
    const targetIndex = manifest.targetIndex;
    const { project, sequence } = await getActiveSequence();

    manifest.clips.forEach((c) => jobs.push({
      id: c.i, label: `Sketch ${c.i} - ${c.name}`, state: "queued",
      sketchName: c.sketchName, startTicks: c.startTicks, durTicks: c.durTicks,
    }));
    renderProgress();

    // Import this run's sketches into a FRESH bin, so identically-named sketches
    // imported from a previous run/folder can never be matched by mistake.
    setStatus("Importing this folder's sketches into a new bin...", "working");
    const rootItem = await project.getRootItem();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    let bin = null;
    try { bin = await rootItem.createBin("NB Sketches " + stamp); } catch (e) { bin = null; }
    const paths = manifest.clips.map((c) => folderDir + "/" + c.sketchName);
    let imported = false;
    try {
      if (typeof project.importFiles === "function") { await project.importFiles(paths, true, bin || undefined); imported = true; }
    } catch (e) {}
    if (!imported) {
      try { if (ppro.ProjectUtils && typeof ppro.ProjectUtils.importFiles === "function") { await ppro.ProjectUtils.importFiles(project, paths); imported = true; } } catch (e) {}
    }
    if (!imported) throw new Error("This Premiere build wouldn't import the sketches.");

    // name -> projectItem map, restricted to the new bin (fall back to project).
    let items = bin ? await getFolderItems(bin) : [];
    if (!items || !items.length) items = await collectProjectItems(project);
    const byName = {};
    for (const pi of items) {
      try {
        const n = (typeof pi.getName === "function") ? await pi.getName() : pi.name;
        if (n) byName[normName(n)] = pi;
      } catch (e) {}
    }

    let placed = 0, durationWarned = false, firstError = null;
    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { setStatus("Cancelled.", "error"); break; }
      const job = jobs[i]; job.state = "running"; renderProgress();
      let step = "match";
      try {
        const base = job.sketchName.replace(/\.png$/i, "");
        const projectItem = byName[normName(job.sketchName)] || byName[normName(base)];
        if (!projectItem) throw new Error("couldn't find imported " + job.sketchName + " in the new bin");
        step = "trim";
        const trimmed = await setStillDurationTicks(project, projectItem, job.durTicks);
        if (!trimmed) durationWarned = true;
        step = "place";
        setStatus(`Placing sketch ${i + 1} of ${jobs.length} on V${targetIndex + 1}...`, "working");
        await overwriteItemAt(project, sequence, projectItem, makeTickTimeFromTicks(job.startTicks), targetIndex);
        placed++; job.state = "done";
      } catch (e) {
        const msg = `[${step}] ${(e && (e.message || String(e))) || "unknown"}`;
        job.error = msg; if (!firstError) firstError = `Clip ${i + 1} - ${msg}`;
        job.state = "error"; renderProgress();
        if (i === 0) { setStatus(`Stopped after the first clip failed. ${firstError}`, "error"); break; }
      }
      renderProgress();
    }

    if (!cancelRequested) {
      const failed = jobs.filter((j) => j.state === "error").length;
      let msg = `Step 2 done: ${placed} sketch${placed === 1 ? "" : "es"} placed on V${targetIndex + 1}${failed ? `, ${failed} failed` : ""}.`;
      if (durationWarned) msg += " Some durations used the default still length - trim to match V1.";
      if (firstError) msg += " First error: " + firstError;
      setStatus(msg, failed ? "" : "success");
    }
  } catch (err) {
    setStatus("Error: " + (err.message || err), "error");
  } finally {
    btnExportEl.disabled = false; btnPlaceEl.disabled = false;
  }
}

async function generateFromV1Clips() {
  cancelRequested = false;
  const apiKey = (apiKeyEl.value || "").trim();
  const choice = modelChoiceEl.value || "nb2";
  const model = choice === "pro" ? MODEL_IDS.pro : MODEL_IDS.nb2;

  if (!apiKey) { setStatus("Add your Gemini API key in Settings first.", "error"); return; }
  if (!outputFolderToken) { setStatus("Choose an output folder (used to stage the sketched stills) first.", "error"); return; }

  setV1Busy(true);
  jobs.length = 0;

  try {
    setStatus("Reading active sequence…", "working");
    const { project, sequence } = await getActiveSequence();

    const { sourceIndex, clips, trackCount } = await findSourceClips(sequence);
    const targetIndex = sourceIndex + 1; // V2 sits directly above the source track.
    if (targetIndex >= trackCount) {
      throw new Error(
        `Found ${clips.length} clip(s) on V${sourceIndex + 1}, but there's no track above it. ` +
        `Add an empty V${targetIndex + 1} track and run again.`);
    }

    clips.forEach((c, i) => {
      jobs.push({
        id: i + 1,
        label: `Clip ${i + 1} — ${c.name} (${formatTimecode(c.startSec)})`,
        state: "queued",
        seconds: c.midSec,
        startSec: c.startSec,
        durSec: c.endSec - c.startSec,
      });
    });
    renderProgress();

    let placed = 0;
    let durationWarned = false;
    let firstError = null;

    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { setStatus("Cancelled.", "error"); break; }
      const job = jobs[i];
      job.state = "running"; renderProgress();

      let step = "export";
      try {
        setStatus(`Exporting middle frame of clip ${i + 1} of ${jobs.length}…`, "working");
        const exported = await exportFrameAt(sequence, job.seconds, outputFolderToken, i + 1);

        step = "sketch";
        setStatus(`Sketching clip ${i + 1} of ${jobs.length}…`, "working");
        const { base64, mimeType } = await callGemini({
          apiKey, model,
          prompt: STORYBOARD_PROMPT,
          imageBase64: exported.base64,
          mimeType: exported.mimeType,
        });

        const ext = mimeType.indexOf("jpeg") >= 0 ? "jpg" : "png";
        const outName = `sketch_V2_${String(i + 1).padStart(3, "0")}_${Math.round(job.startSec * 1000)}ms.${ext}`;
        const outFile = await outputFolderToken.createFile(outName, { overwrite: true });
        await outFile.write(base64ToBytes(base64).buffer, { format: formats.binary });

        step = "import";
        setStatus(`Importing sketch ${i + 1} of ${jobs.length}…`, "working");
        const projectItem = await importStillAndGetItem(project, outFile);
        const trimmed = await setStillDuration(project, projectItem, job.durSec, sequence);
        if (!trimmed) durationWarned = true;

        step = "place";
        setStatus(`Placing sketch ${i + 1} of ${jobs.length} on V${targetIndex + 1}…`, "working");
        await overwriteOntoTrack(project, sequence, projectItem, job.startSec, targetIndex);

        placed++;
        job.state = "done"; renderProgress();
      } catch (e) {
        const msg = `[${step}] ${(e && (e.message || String(e))) || "unknown error"}`;
        job.error = msg;
        if (!firstError) firstError = `Clip ${i + 1} — ${msg}`;
        job.state = "error"; renderProgress();
        setStatus(`Clip ${i + 1} failed: ${msg}`, "error");
        if (i === 0) {
          setStatus(`Stopped after the first clip failed (same problem would hit them all). Clip 1 — ${msg}`, "error");
          break;
        }
      }
    }

    if (!cancelRequested) {
      const failed = jobs.filter((j) => j.state === "error").length;
      let msg = `Done. ${placed} sketch${placed === 1 ? "" : "es"} placed on V${targetIndex + 1}`;
      if (failed) msg += `, ${failed} clip${failed === 1 ? "" : "s"} failed`;
      msg += ".";
      if (durationWarned) {
        msg += " Note: clip durations couldn't be set via the API, so some V2 stills may use the default still length — trim them to match V1.";
      }
      if (firstError) msg += `  First error: ${firstError}`;
      setStatus(msg, failed ? "error" : "success");
    }
  } catch (err) {
    setStatus(`Error: ${err.message || err}`, "error");
  } finally {
    setV1Busy(false);
  }
}

/* ------------------------------------------------------------------ */
/*  Main flow — markers / interval contact sheet                        */
/* ------------------------------------------------------------------ */
async function generateStoryboard() {
  cancelRequested = false;
  const apiKey = (apiKeyEl.value || "").trim();
  const choice = modelChoiceEl.value || "nb2";
  const model = choice === "pro" ? MODEL_IDS.pro : MODEL_IDS.nb2;
  const wantImport = !!importToBinEl.checked;
  const wantSheet = !!buildContactSheetEl.checked;

  if (!apiKey) { setStatus("Add your Gemini API key in Settings first.", "error"); return; }
  if (!outputFolderToken) { setStatus("Choose an output folder first.", "error"); return; }

  goBtn.disabled = true;
  jobs.length = 0;

  try {
    setStatus("Reading active sequence…", "working");
    const { project, sequence } = await getActiveSequence();
    const times = await buildCaptureTimes(sequence);

    times.forEach((t, i) => {
      jobs.push({ id: i + 1, label: `Frame ${i + 1} — ${formatTimecode(t)}`, state: "queued", seconds: t });
    });
    renderProgress();

    const generatedFiles = [];
    const panelsForSheet = [];

    for (let i = 0; i < jobs.length; i++) {
      if (cancelRequested) { setStatus("Cancelled.", "error"); break; }
      const job = jobs[i];
      job.state = "running"; renderProgress();
      setStatus(`Exporting frame ${i + 1} of ${jobs.length} at ${formatTimecode(job.seconds)}…`, "working");

      try {
        const exported = await exportFrameAt(sequence, job.seconds, outputFolderToken, i + 1);

        setStatus(`Storyboarding frame ${i + 1} of ${jobs.length}…`, "working");
        const { base64, mimeType } = await callGemini({
          apiKey, model,
          prompt: STORYBOARD_PROMPT,
          imageBase64: exported.base64,
          mimeType: exported.mimeType,
        });

        const outName = `nb_storyboard_${String(i + 1).padStart(3, "0")}_${Math.round(job.seconds * 1000)}ms.${mimeType.indexOf("jpeg") >= 0 ? "jpg" : "png"}`;
        const outFile = await outputFolderToken.createFile(outName, { overwrite: true });
        const outBytes = base64ToBytes(base64);
        await outFile.write(outBytes.buffer, { format: formats.binary });

        generatedFiles.push(outFile);
        panelsForSheet.push({ base64, mimeType, label: formatTimecode(job.seconds) });

        job.state = "done"; renderProgress();
      } catch (e) {
        job.state = "error"; renderProgress();
        setStatus(`Frame ${i + 1} failed: ${e.message || e}`, "error");
      }
    }

    if (wantSheet && panelsForSheet.length) {
      setStatus("Composing contact sheet…", "working");
      try {
        const sheetFile = await buildContactSheetFromBytes(panelsForSheet, outputFolderToken);
        if (sheetFile) generatedFiles.push(sheetFile);
      } catch (e) {
        setStatus("Contact sheet failed: " + (e.message || e), "error");
      }
    }

    if (wantImport && generatedFiles.length) {
      setStatus("Importing into project bin…", "working");
      try {
        await importFilesToBin(project, generatedFiles, `Storyboard ${new Date().toISOString().slice(0, 16)}`);
      } catch (e) { /* importFilesToBin handles fallback status */ }
    }

    if (!cancelRequested) {
      const done = jobs.filter((j) => j.state === "done").length;
      const failed = jobs.filter((j) => j.state === "error").length;
      setStatus(
        `Done. ${done} frame${done === 1 ? "" : "s"} generated${failed ? `, ${failed} failed` : ""}. Saved to "${outputFolderName}".`,
        failed ? "" : "success"
      );
    }
  } catch (err) {
    setStatus(`Error: ${err.message || err}`, "error");
  } finally {
    goBtn.disabled = false;
  }
}

function formatTimecode(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                              */
/* ------------------------------------------------------------------ */
goBtn.addEventListener("click", () => generateStoryboard());
if (btnOneClickEl) btnOneClickEl.addEventListener("click", () => generateFromV1Clips());
if (btnExportEl) btnExportEl.addEventListener("click", () => exportFramesPhase());
if (btnPlaceEl) btnPlaceEl.addEventListener("click", () => placeSketchesPhase());
chooseFolderBtn.addEventListener("click", pickOutputFolder);
cancelBtn.addEventListener("click", () => { cancelRequested = true; });

saveKeyBtn.addEventListener("click", async () => {
  const k = (apiKeyEl.value || "").trim();
  if (!k) { setStatus("Nothing to save — paste a key first.", "error"); return; }
  await saveSecret("gemini_api_key", k);
  keyStatePill.textContent = "✓ saved";
  setStatus("API key saved locally.", "success");
});

modelChoiceEl.addEventListener("change", () => savePref("modelChoice", modelChoiceEl.value));
intervalSecondsEl.addEventListener("change", () => savePref("intervalSeconds", intervalSecondsEl.value));
importToBinEl.addEventListener("change", () => savePref("importToBin", importToBinEl.checked ? "1" : "0"));
buildContactSheetEl.addEventListener("change", () => savePref("buildContactSheet", buildContactSheetEl.checked ? "1" : "0"));
overwriteV2El.addEventListener("change", () => savePref("overwriteV2", overwriteV2El.checked ? "1" : "0"));

(async function init() {
  let savedKey = await loadSecret("gemini_api_key");
  if (savedKey) {
    apiKeyEl.value = savedKey;
    keyStatePill.textContent = "✓ saved";
  } else {
    const fileKey = await readKeyFromFile();
    if (fileKey) {
      apiKeyEl.value = fileKey;
      keyStatePill.textContent = "✓ from apikey.txt";
      try { await saveSecret("gemini_api_key", fileKey); } catch (e) {}
    }
  }
  modelChoiceEl.value = loadPref("modelChoice", "nb2");
  intervalSecondsEl.value = loadPref("intervalSeconds", "5");
  importToBinEl.checked = loadPref("importToBin", "1") === "1";
  buildContactSheetEl.checked = loadPref("buildContactSheet", "1") === "1";
  overwriteV2El.checked = loadPref("overwriteV2", "0") === "1";
  const mode = loadPref("captureMode", "v1clips");
  captureModeEl.querySelectorAll(".seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.value === mode));
  applyModeUI();
})();
