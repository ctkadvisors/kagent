# Image Asset Generation Primer

For any agent (Claude / Codex / etc.) generating image assets for kagent.

## TL;DR

There is **no active visual lock** for the workbench. The 2026-05-08 sprite-GUI experiment (first CoC/W3, then RA2) was abandoned: skinning the workbench's voxel scene with a painted RTS map made figure-ground worse, not better — the agent voxels disappeared into the painted-city backdrop and HUDs couldn't read against the busy texture. The workbench keeps its dark-slate-with-grid scene and its **game-like usability** (camera, hotkeys, multi-select, dispatch popover, replay, mission tutorial, vapor trails, screen shake, sound, mood lighting) — but does not ship sprite or terrain backdrops.

The ComfyUI pipeline still works and is documented below for one-off uses (a README hero shot, a marketing image, a future opt-in visualization). Reference exemplars from the abandoned experiments live in [`docs/assets/reference/`](./assets/reference/) (RA2 set) and [`docs/assets/reference-archive-w3/`](./assets/reference-archive-w3/) (CoC/W3 set) — useful as prompt anchors, NOT as a "use this style everywhere" mandate.

If you're tempted to skin the workbench in any visual style: don't. The lesson: a busy painted backdrop drowns out the in-canvas signal. If a future feature needs imagery (e.g., a per-tool icon set), generate the smallest possible asset, isolated, with abundant negative space — and validate it doesn't break HUD legibility before shipping.

## Where image gen runs

ComfyUI is host-installed and launchd-managed on `Mini-2.local` (Apple M4, 16GB, MPS). No auth on the LAN.

- **Endpoint:** `http://Mini-2.local:8188` or `http://192.168.68.60:8188`
- **API:** standard ComfyUI JSON-graph (`POST /prompt`, poll `/history/<id>`, fetch `/view?filename=...`)
- **Service:** launchd agent `io.knuteson.comfyui` on Mini-2; `~/comfyui/run.sh` is what it executes
- **Models dir on Mini-2:** `~/comfyui/ComfyUI/models/checkpoints/` and `~/comfyui/ComfyUI/models/loras/`

If reachability fails: `Mini-2.local` may have shifted IP — re-resolve via `dscacheutil -q host -a name Mini-2.local`. The Jetson installation exists but is OOM-bound and reserved for future FLUX-GGUF experiments only.

## Visual style — no active lock

There is no active visual lock. Two prior experiments — Clash-of-Clans/Warcraft-3 daylight cartoon (2026-05-08 morning), then Red-Alert-2 voxel-sprite (2026-05-08 evening) — both ended up degrading workbench usability when applied as a backdrop or panel chrome under the voxel scene. The painted-map-under-voxels approach drowned the in-canvas signal regardless of the painted style. **Don't repeat that pattern.**

Reference images from both abandoned experiments live in [`docs/assets/reference/`](./assets/reference/) and [`docs/assets/reference-archive-w3/`](./assets/reference-archive-w3/). They're useful as **prompt anchors for one-off uses** (e.g., a README hero shot, a marketing image), not as a project-wide style.

If a future feature needs imagery: generate the smallest possible asset, isolated, with abundant negative space — and validate it doesn't break HUD legibility before shipping. The voxel scene's dark slate + grid + FX vocabulary is what currently works for ops readability.

## Models available

**Checkpoints** (single-file, drop into a `CheckpointLoaderSimple` node):
- `sd_xl_turbo_1.0_fp16.safetensors` — primary. 1-4 step gen at cfg=1.0-1.5, sampler=`dpmpp_sde`, scheduler=`karras`. ~2-25s/image at 768x768 on Mini-2.
- `v1-5-pruned-emaonly.safetensors` — legacy SD 1.5. Bigger LoRA ecosystem, slower (20-30 step). Use only if a specific SD 1.5 LoRA is required.

**LoRAs** (chain via `LoraLoader` node):
- `pixel-art-xl.safetensors` — useful for forcing pixelation on photo-style subjects.
- `sdxl_lightning_8step_lora.safetensors` — quality boost for **photorealistic** prompts only. Use 8 steps, cfg=1.0, sampler=`euler`, scheduler=`sgm_uniform`.

## Working code snippet

Self-contained Python — submits a workflow, polls, downloads the image. No deps beyond stdlib. The prompt is whatever you want; there's no "house style" suffix anymore. Pick the style that fits the one-off use you're generating for.

```python
import json, urllib.request, urllib.parse, time, uuid

HOST = "http://Mini-2.local:8188"


def generate(prompt: str, negative: str = "", *, label: str = "kagent-asset", width: int = 768, height: int = 768, seed: int = 100, steps: int = 4) -> str:
    """Generate one image, return local path."""
    workflow = {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.5,
            "sampler_name": "dpmpp_sde", "scheduler": "karras", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_turbo_1.0_fp16.safetensors"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": label, "images": ["8", 0]}},
    }
    cid = str(uuid.uuid4())
    req = urllib.request.Request(
        f"{HOST}/prompt",
        data=json.dumps({"prompt": workflow, "client_id": cid}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        prompt_id = json.loads(r.read())["prompt_id"]
    deadline = time.time() + 120
    while time.time() < deadline:
        with urllib.request.urlopen(f"{HOST}/history/{prompt_id}", timeout=10) as r:
            hist = json.loads(r.read())
        if prompt_id in hist and (hist[prompt_id].get("outputs") or hist[prompt_id].get("status", {}).get("completed")):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError(f"timeout waiting for {prompt_id}")
    for _, node_out in hist[prompt_id].get("outputs", {}).items():
        for img in node_out.get("images", []):
            url = (
                f"{HOST}/view?"
                f"filename={urllib.parse.quote(img['filename'])}"
                f"&subfolder={urllib.parse.quote(img.get('subfolder', ''))}"
                f"&type={img.get('type', 'output')}"
            )
            with urllib.request.urlopen(url, timeout=15) as r:
                data = r.read()
            local = f"/tmp/{img['filename']}"
            with open(local, "wb") as f:
                f.write(data)
            return local
    raise RuntimeError("no images in output")
```

## Known limitations

- **Text rendering:** SDXL cannot render readable text. Banners, labels, and UI text come out as gibberish glyphs. Workaround: render the asset without text, then composite real text in code (CSS / SVG / Canvas). FLUX-schnell would fix this but is not installed (16GB unified memory is tight for FLUX).
- **Transparent backgrounds:** none of the installed models support alpha output. To get clean sprites: prompt for "isolated on a flat solid color background" and post-process with `rembg` or a chroma-key step. There's no transparent-output LoRA installed yet.
- **Per-image generation time:** ~2-25s warm at 768×768 (cold-load on first request adds ~15s). 1280×768 hero shots are ~40-55s. Plan asset batches accordingly.
- **No batched async:** the snippet above is sequential. ComfyUI accepts queued submissions but Mini-2 is single-GPU; parallelism gains are marginal.
- **"Empty terrain" prompts are difficult:** SDXL Turbo strongly wants to populate scenes. Even with explicit negatives ("no buildings, no structures") it often slips a hut or two in. For a true empty plot, lead with "completely empty land" and pile on negative variants. If still populated, generate-and-crop or in-paint to remove.

## Don'ts

1. **Don't skin the workbench in any visual style.** The 2026-05-08 sprite-GUI experiment proved a painted backdrop under the voxel scene drowns the in-canvas signal regardless of the painted style. The workbench's "game-like" character lives in its **usability** — hotkeys, multi-select, dispatch grammar, replay, vapor trails, screen shake, sound — not in sprite chrome.
2. **Don't run image gen on Jetson Orin Nano** (`192.168.68.73`). The container exists but Tegra NvMap heap OOMs even with `--novram --use-split-cross-attention --bf16-vae`. Reserved for future FLUX-schnell-GGUF Q4 experiments only.
3. **Don't apply Pixel Art LoRA when the prompt already says "pixel art"** — over-saturates.
4. **Don't apply Lightning LoRA to stylized art** — it's tuned for photoreal detail and breaks cartoon shading.
5. **Don't try to render readable text in-image** — SDXL produces gibberish. Composite text in your DOM/SVG layer.
6. **Don't commit large generated images to the repo without a justifying use.** Working drafts belong in `~/Desktop/<topic>/` or a `.gitignore`d local dir, not in the repo.

## Iterating with intent

When a generated asset doesn't land, the failure mode is usually one of:

- **Prompt too literal in a fantasy-trope direction** (e.g., "command tower" → model produces a castle). Fix: anchor with concrete material/era cues — "low concrete bunker with white satellite dish on top", not just "command tower".
- **Composition wrong scale.** Single-building sprite needs `single isometric building sprite of`; whole base panorama needs `wide isometric battlefield`. The model lifts these literally.
- **Too populated when you wanted empty.** SDXL really wants to populate scenes. Lead with "completely empty land, NO BUILDINGS, NO STRUCTURES" + heavy negatives. Often still slips a hut or two — generate-and-crop or in-paint to remove.
- **Drifts toward dark/gritty/painterly when you want bright/clean.** Add explicit anti-anchors to the negative: `dark, gritty, muddy, painterly, photorealistic`.
- **Color drift.** Re-emphasize palette explicitly: "blue trim, white panels, red accents, weathered concrete tile."

Same seed across iterations keeps composition stable while you tweak prompt; new seed for fresh attempts.
