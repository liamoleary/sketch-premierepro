# Nano Banana Storyboard — Premiere Pro plugin

Turn the clips in a sequence into rough storyboard sketches, driven by Google's
Gemini image models. The same rough-pencil look as the Photoshop plugin
(characters in red, environment in grey/charcoal).

The panel has two workflows, picked with the segmented control at the top:

## 1. Match V1 clips → V2  (default)

Built for an animatic-style nested sequence: a row of hold-frame clips sitting on
the **V1** video track. For every clip on V1 the plugin:

1. Exports the clip's **middle frame**.
2. Sends it to Gemini with the rough-storyboard prompt.
3. Saves the sketched still to your output folder and imports it.
4. **Overwrites it onto V2**, trimmed to the **same start time and duration** as
   the V1 clip below it — so the sketch track lines up frame-for-frame with the
   reference.

V2 is whichever video track sits directly above the lowest track that has clips,
so if your clips are on V1 the sketches land on V2. Add an empty V2 track first
if you don't already have one.

## 2. Markers / Every N seconds

The original contact-sheet flow. Capture a frame at every sequence marker, or one
frame every N seconds, sketch each, save them to a folder, import them into a new
bin, and (optionally) compose a multi-panel contact-sheet PNG.

## Requirements

- **Premiere Pro 23.6 or newer** with UXP enabled. The frame-export and sequence
  editing APIs are recent — older builds may load the panel but fail at the
  export or placement step.
- A Google Gemini API key with image-generation billing enabled.
- The same UXP Developer Tool (UDT) you used to load the Photoshop plugin.

## Loading

1. Open UDT. Click **Add Plugin** and pick `premiere/manifest.json`.
2. Make sure Premiere is open with your project loaded.
3. Click **Load** in UDT. The panel appears under **Window → Extensions** (or in
   the panel list while UDT is loaded).

## Use (V1 → V2)

1. Open the panel, expand **Settings**, paste your Gemini API key, click **Save**.
2. Leave the source mode on **Match V1 clips → V2**.
3. Click **Choose…** and pick an output folder for the staged sketch stills.
4. Pick a **model** (Nano Banana 2 is cheap & fast, Pro is higher quality).
5. Open the nested sequence so it's the active sequence, with your hold-frame
   clips on V1 and an empty V2 above them.
6. Click **Sketch V1 clips onto V2**. Each clip is exported, sketched, and placed
   on V2 cut to match V1. Progress shows per clip.

## Options

- **Overwrite anything already on V2 in those ranges** — placement uses an
  overwrite edit, so on an empty V2 it simply drops the sketches in. Leave this
  on if V2 already has content you want replaced in those time ranges.

## Cost controls

Input frames are capped at ~1024px on the long edge and re-encoded as JPEG
quality 70 before they leave Premiere. Each clip/frame is one Gemini image call;
bulk runs scale linearly.

## Troubleshooting

- **"No clips found on any video track"** — make the nested sequence active and
  confirm the hold-frame clips are really on a video track (V1).
- **"there's no track above it"** — add an empty V2 track and run again.
- **"Couldn't export a frame from this sequence"** — your Premiere build's UXP
  DOM doesn't expose `exportFrameJPEG`/`PNG` to scripts yet. Update Premiere.
- **"wouldn't place them programmatically"** — the sketches are still imported
  into your project; the sequence-editing API on your build differs from the ones
  tried. Drag them from the bin onto V2 manually, and send me your Premiere
  version so the placement path can be wired for it.
- **V2 stills use the default still length** — the API on your build wouldn't let
  the plugin set each still's duration; trim the V2 clips to match V1, or report
  the version.
- **403 / billing** — enable billing for the API key's project in Google Cloud;
  image output is not on the free tier.

## Files

- `manifest.json` — UXP manifest (v5), network permission scoped to Gemini.
- `index.html` — panel UI.
- `main.js` — all logic (clip reading, frame export, Gemini call, V2 placement).
"# sketch-premierepro" 
