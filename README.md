# Nano Banana Storyboard — Premiere Pro plugin

Turn the clips in a sequence into rough storyboard sketches (characters in red,
environment in grey/charcoal), driven by Google's Gemini image models.

## Why the V1 -> V2 flow is two steps

Premiere's plugin runtime (UXP) lets a plugin write files and ask Premiere to
export a frame, but on current builds it will **not let the plugin read back a
file that Premiere's exporter created** — only files the plugin wrote itself.
The sketch step needs to read each exported frame to send it to Gemini, so that
one step has to run *outside* Premiere. Hence three stages:

1. **Plugin → "1 · Export frames + manifest"** — exports one frame per V1 clip
   to your output folder, plus a `manifest.json` recording each clip's timing.
2. **`sketch_frames.js`** (run once in a terminal) — sketches every `frame_NNN.png`
   into `sketch_NNN.png` in that same folder.
3. **Plugin → "2 · Place sketches on V2"** — imports each sketch and lays it on
   V2 at the same start and duration as the matching V1 clip.

Steps 1 and 3 never read image bytes, so they aren't affected by the UXP limit.

## Requirements

- **Premiere Pro 25.0 or newer** (uses `Exporter.exportSequenceFrame` and
  `SequenceEditor`).
- **Node.js 18+** to run the sketch script (built-in `fetch`, no `npm install`).
- A Google Gemini API key with image-generation billing enabled.
- UXP Developer Tool (UDT) to load the plugin.

## Set up the API key

Create `apikey.txt` in this folder containing just your key (`AIza...`) on one
line. Both the plugin and the sketch script read it. It's covered by
`.gitignore`, so it won't be committed.

## Loading the plugin

1. UDT → **Add Plugin** → pick `premiere/manifest.json`.
2. Open Premiere with your project, then **Load** in UDT.
   (After changing `manifest.json`, **Remove** and re-**Add** the plugin so new
   permissions register.)

## Running the V1 -> V2 workflow

1. Open the nested sequence so it's active, with your hold-frame clips on V1 and
   an **empty V2** above them.
2. In the panel, leave the source on **Match V1 clips → V2**, click **Choose…**
   and pick an output folder.
3. Click **1 · Export frames + manifest**. You'll get `frame_001.png …` plus
   `manifest.json` in that folder.
4. In a terminal, run the sketch step over that folder:

   ```
   node sketch_frames.js "C:\path\to\your\output\folder"
   ```

   Add `--pro` for the higher-quality model. It writes `sketch_001.png …`.
5. Back in Premiere, click **2 · Place sketches on V2**. Each sketch lands on V2
   cut to match the V1 clip below it.

## Markers / Every-N-seconds mode

The other source modes still work as a contact-sheet flow: capture frames at
markers or on an interval, sketch them, and save a multi-panel contact sheet.
(These also rely on reading exported frames, so they're subject to the same UXP
limitation on some builds.)

## Files

- `manifest.json` — UXP manifest (network scoped to Gemini, `fullAccess` files).
- `index.html` — panel UI.
- `main.js` — plugin logic (clip reading, frame export, placement on V2).
- `sketch_frames.js` — Node script: sketches exported frames via Gemini.
- `apikey.txt` — your Gemini key (git-ignored; create it yourself).

## Troubleshooting

- **Step 2 says `[place] SequenceEditor… unavailable`** — update Premiere to 25.0+.
- **Step 2 `[import] … not supported`** — the sketches are still on disk; drag
  them onto V2 manually, or send me your Premiere version.
- **Durations use the default still length** — the API wouldn't set in/out on
  your build; trim the V2 stills to match V1, or report the version.
- **Sketch script: "No API key"** — create `apikey.txt` or set `GEMINI_API_KEY`.
- **403 / billing** — enable billing for the key's Google Cloud project.
