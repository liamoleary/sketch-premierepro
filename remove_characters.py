#!/usr/bin/env python3
"""
remove_characters.py - batch "clean plate" generator.

Put your shots (PNG/JPG/JPEG/WEBP) in a folder, run this, and it asks Google's
Gemini image model to ERASE every character (people, aliens, creatures, AND
robots/droids including round ones) and rebuild the background behind them.
Results are written to a "plates" subfolder, one per input, same filename.

Requires Python 3.8+. No pip install needed (standard library only).

Usage:
    python remove_characters.py "C:\\path\\to\\shots_folder"
    python remove_characters.py "C:\\path\\to\\folder" --pro     (higher quality)
    python remove_characters.py "C:\\path\\to\\folder" --force    (redo existing)

API key (first that exists wins):
    - apikey.txt in the shots folder
    - apikey.txt next to this script
    - GEMINI_API_KEY environment variable
"""

import sys
import os
import json
import base64
import urllib.request
import urllib.error
import urllib.parse

MODELS = {"nb2": "gemini-2.5-flash-image", "pro": "gemini-3-pro-image-preview"}
HOST = "https://generativelanguage.googleapis.com/v1beta/models"

PROMPT = (
    "Remove ALL characters from this image, leaving only the empty background "
    "environment. A 'character' is any person, humanoid, creature, animal, "
    "alien, OR robot / droid / mechanical being - INCLUDING any round, ball, "
    "dome or spherical robots even when they look like an object. "
    "Erase every character completely and realistically reconstruct (inpaint) "
    "the background that was behind them, matching the existing lighting, "
    "perspective, textures, colours and art style so it looks like a natural, "
    "untouched empty plate of the same scene. Keep the camera angle, framing, "
    "composition and everything else identical. Do not add any new objects, "
    "people or creatures. Output only the cleaned background image."
)

EXTS = (".png", ".jpg", ".jpeg", ".webp")
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def read_key(folder, script_dir):
    for p in (os.path.join(folder, "apikey.txt"), os.path.join(script_dir, "apikey.txt")):
        try:
            with open(p, "r", encoding="utf-8") as fh:
                for line in fh:
                    t = line.strip()
                    if t and not t.startswith("#"):
                        return t
        except OSError:
            pass
    return (os.environ.get("GEMINI_API_KEY") or "").strip()


def call_gemini(api_key, model, b64, mime):
    url = "%s/%s:generateContent?key=%s" % (HOST, model, urllib.parse.quote(api_key))
    body = {
        "contents": [{
            "parts": [
                {"text": PROMPT},
                {"inlineData": {"mimeType": mime, "data": b64}},
            ]
        }]
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", str(e))
        except Exception:
            msg = str(e)
        raise RuntimeError(msg)
    for cand in payload.get("candidates", []):
        for part in (cand.get("content", {}) or {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return inline["data"]
    block = (payload.get("promptFeedback") or {}).get("blockReason")
    raise RuntimeError("no image in response" + (" (blocked: %s)" % block if block else ""))


def main():
    args = sys.argv[1:]
    folder = next((a for a in args if not a.startswith("--")), None)
    model = MODELS["pro"] if "--pro" in args else MODELS["nb2"]
    force = "--force" in args
    script_dir = os.path.dirname(os.path.abspath(__file__))

    if not folder:
        print('Usage: python remove_characters.py "C:\\\\path\\\\to\\\\folder" [--pro] [--force]')
        sys.exit(1)
    if not os.path.isdir(folder):
        print("Folder not found:", folder)
        sys.exit(1)

    api_key = read_key(folder, script_dir)
    if not api_key:
        print("No API key. Put it in apikey.txt (in the folder or next to this script) or set GEMINI_API_KEY.")
        sys.exit(1)

    out_dir = os.path.join(folder, "plates")
    os.makedirs(out_dir, exist_ok=True)

    files = sorted(
        f for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in EXTS and os.path.isfile(os.path.join(folder, f))
    )
    if not files:
        print("No images (%s) found in %s" % ("/".join(EXTS), folder))
        sys.exit(1)

    print("Removing characters from %d image(s) with %s …  (Ctrl+C to cancel)" % (len(files), model))
    ok = skipped = fail = 0
    try:
        for i, name in enumerate(files, 1):
            out_path = os.path.join(out_dir, os.path.splitext(name)[0] + ".png")
            if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                print("  [%d/%d] %s already done - skipped" % (i, len(files), name))
                skipped += 1
                continue
            ext = os.path.splitext(name)[1].lower()
            try:
                with open(os.path.join(folder, name), "rb") as fh:
                    b64 = base64.b64encode(fh.read()).decode("ascii")
                print("  [%d/%d] %s … " % (i, len(files), name), end="", flush=True)
                out_b64 = call_gemini(api_key, model, b64, MIME.get(ext, "image/png"))
                with open(out_path, "wb") as fh:
                    fh.write(base64.b64decode(out_b64))
                print("ok")
                ok += 1
            except Exception as e:
                print("FAILED: %s" % e)
                fail += 1
    except KeyboardInterrupt:
        print("\nCancelled. Finished plates are kept; re-run to resume.")

    print("Done. %d cleaned%s%s. Output: %s" % (
        ok,
        (", %d skipped" % skipped) if skipped else "",
        (", %d failed" % fail) if fail else "",
        out_dir,
    ))


if __name__ == "__main__":
    main()
