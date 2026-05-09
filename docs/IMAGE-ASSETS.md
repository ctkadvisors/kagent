# Image Asset Generation Primer

For any agent (Claude / Codex / etc.) generating image assets for kagent.

## TL;DR

Visual style is **locked to Red Alert 2 / Yuri's Revenge** — Westwood 2000-era voxel-sprite aesthetic. **Bright, saturated, cartoony-military, blue sky, faceted low-poly look, crisp readable silhouettes.** NOT SC2 / Blizzard grimdark, NOT Clash-of-Clans / Warcraft-3 fantasy daylight, NOT photorealistic. Submit txt2img workflows to `http://Mini-2.local:8188`. Reference exemplars live in [`docs/assets/reference/`](./assets/reference/).

The earlier CoC/W3 lock was reverted: it was visually right for marketing-flavored hero shots but visually wrong as the workbench's RTS surface — the daylight cartoon look fades incoherently to the (kept) dark-amber RA2 inner UI. RA2 unifies everything. The retired CoC reference set is preserved in [`docs/assets/reference-archive-w3/`](./assets/reference-archive-w3/) for future hero-shot or marketing use.

## Where image gen runs

ComfyUI is host-installed and launchd-managed on `Mini-2.local` (Apple M4, 16GB, MPS). No auth on the LAN.

- **Endpoint:** `http://Mini-2.local:8188` or `http://192.168.68.60:8188`
- **API:** standard ComfyUI JSON-graph (`POST /prompt`, poll `/history/<id>`, fetch `/view?filename=...`)
- **Service:** launchd agent `io.knuteson.comfyui` on Mini-2; `~/comfyui/run.sh` is what it executes
- **Models dir on Mini-2:** `~/comfyui/ComfyUI/models/checkpoints/` and `~/comfyui/ComfyUI/models/loras/`

If reachability fails: `Mini-2.local` may have shifted IP — re-resolve via `dscacheutil -q host -a name Mini-2.local`. The Jetson installation exists but is OOM-bound and reserved for future FLUX-GGUF experiments only.

## Visual style — locked

**Reference aesthetic:** Red Alert 2 / Yuri's Revenge (Westwood, 2000) game art.

| ✅ Use | ❌ Don't |
|---|---|
| Bright saturated colors | Dark / muddy / muted palette |
| Blue sky overhead | Grimdark / overcast / dystopian |
| Crisp readable silhouettes | Cluttered / painterly |
| Faceted low-poly voxel sprites | Realistic 3D / smooth shading |
| Cartoony military (cold-war era) | Sci-fi horror / biological |
| Faction colors (Allies blue+tan, Soviets red+gray) | Photorealistic textures |
| Concrete + ribbed metal panels with weathering | Brown sludge / oil paint |
| Asphalt road grids with painted yellow markings | Fantasy castles / domes |
| Industrial idioms: silos, smokestacks, radar dishes, conveyors | Cute / pastel / kid-friendly |

**Why this style:** the workbench owner explicitly anchored to Red Alert 2 / Yuri's Revenge — "bright, readable, cartoony-military, voxel sprites." Earlier RA2-leaning attempts collapsed into SC2 territory (dark, gritty, painterly); the prompt now anchors HARD against SC2/Blizzard via explicit negatives. Confirmed against generated samples 2026-05-08.

## Style block to paste into prompts

```
RA2_SUFFIX = (
    "Red Alert 2 voxel sprite, retro 2000-era Westwood game art, "
    "bright saturated colors, blue sky, crisp readable silhouette, "
    "cartoony military, clean forms, faceted low-poly voxel look, "
    "isometric 30-degree view, primary-color faction accents, "
    "weathered metal panels but bright not muddy"
)

RA2_NEGATIVE = (
    "StarCraft, StarCraft 2, SC2, Blizzard, dark, gritty, muddy, "
    "painterly, photorealistic, realistic textures, grimdark, "
    "sci-fi horror, biological, brown sludge, dim lighting, "
    "Warhammer 40k, dystopian, oil paint, blurry, low quality, "
    "watermark, text, signature, fantasy castle, Clash of Clans, "
    "Warcraft, daylight cartoon, kid-friendly, cute, pastel, "
    "noir, photorealism"
)
```

Append your subject-specific prompt before the suffix:
```
"single isometric Red Alert 2 [subject] sprite, [features], on cracked concrete tile, " + RA2_SUFFIX
```

The `RA2_NEGATIVE` block is critical — without explicit anti-SC2 anchoring, SDXL Turbo's "industrial military isometric" prior pulls toward darker, more realistic Blizzard styling.

## Reference exemplars

These four images in [`docs/assets/reference/`](./assets/reference/) are the locked visual language. **Match this look.**

| File | Subject | Used for |
|---|---|---|
| `ra2-terrain.png` | Wide isometric battlefield ground (1280×768) | `.sceneWrap` CSS backdrop under voxel scene |
| `ra2-allied-hq.png` | Allied Construction Yard with crane arm | Operator (K8s controller) building sprite |
| `ra2-refinery.png` | Industrial silo + smokestacks | LiteLLM Gateway sprite |
| `ra2-radar-dome.png` | Domed radar bunker | Tool-use / observability sprite (or Langfuse equivalent) |

When generating a NEW asset (e.g., a building for a future substrate component), open these and prompt with deliberate echoes of their composition language: faceted voxel forms on cracked concrete tiles, blue-and-tan or red-and-gray faction palettes, crisp silhouettes, blue sky, primary-color trim accents.

## Models available

**Checkpoints** (single-file, drop into a `CheckpointLoaderSimple` node):
- `sd_xl_turbo_1.0_fp16.safetensors` — primary. 1-4 step gen at cfg=1.0-1.5, sampler=`dpmpp_sde`, scheduler=`karras`. ~2-25s/image at 768x768 on Mini-2.
- `v1-5-pruned-emaonly.safetensors` — legacy SD 1.5. Bigger LoRA ecosystem, slower (20-30 step). Use only if a specific SD 1.5 LoRA is required.

**LoRAs** (chain via `LoraLoader` node):
- `pixel-art-xl.safetensors` — DON'T use when the prompt already says "voxel sprite" / "pixel art" (over-saturates). Useful for forcing pixelation on photo-style subjects.
- `sdxl_lightning_8step_lora.safetensors` — quality boost for **photorealistic** prompts only. For RTS / stylized art it adds neon-busy detail and breaks the locked style. Use 8 steps, cfg=1.0, sampler=`euler`, scheduler=`sgm_uniform`.

## Working code snippet

Self-contained Python — submits a workflow, polls, downloads the image. No deps beyond stdlib.

```python
import json, urllib.request, urllib.parse, time, uuid

HOST = "http://Mini-2.local:8188"

RA2_SUFFIX = (
    "Red Alert 2 voxel sprite, retro 2000-era Westwood game art, "
    "bright saturated colors, blue sky, crisp readable silhouette, "
    "cartoony military, clean forms, faceted low-poly voxel look, "
    "isometric 30-degree view, primary-color faction accents, "
    "weathered metal panels but bright not muddy"
)

RA2_NEGATIVE = (
    "StarCraft, StarCraft 2, SC2, Blizzard, dark, gritty, muddy, "
    "painterly, photorealistic, realistic textures, grimdark, "
    "sci-fi horror, biological, brown sludge, dim lighting, "
    "Warhammer 40k, dystopian, oil paint, blurry, low quality, "
    "watermark, text, signature, fantasy castle, Clash of Clans, "
    "Warcraft, daylight cartoon, kid-friendly, cute, pastel"
)


def generate(subject_prompt: str, *, label: str = "kagent-asset", width: int = 768, height: int = 768, seed: int = 100, steps: int = 4) -> str:
    """Generate one image, return local path. Subject prompt is short; RA2 suffix is appended."""
    full_prompt = f"{subject_prompt}, {RA2_SUFFIX}"
    workflow = {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.5,
            "sampler_name": "dpmpp_sde", "scheduler": "karras", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_turbo_1.0_fp16.safetensors"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": full_prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": RA2_NEGATIVE, "clip": ["4", 1]}},
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


# Example: a new building sprite for a hypothetical "Vault" component
if __name__ == "__main__":
    path = generate(
        "single isometric Red Alert 2 'Vault' secrets-store bunker sprite, "
        "low concrete bunker with heavy iron-banded vault door, "
        "small white antenna on top, blue trim, cyan glowing keypad panel on the side, "
        "single building isolated on cracked concrete tile",
        label="kagent-vault",
        seed=200,
    )
    print(f"saved: {path}")
```

## Known limitations

- **Text rendering:** SDXL cannot render readable text. Banners, labels, and UI text come out as gibberish glyphs. Workaround: render the asset without text, then composite real text in code (CSS / SVG / Canvas). FLUX-schnell would fix this but is not installed (16GB unified memory is tight for FLUX).
- **Transparent backgrounds:** none of the installed models support alpha output. To get clean sprites: prompt for "isolated on a flat solid color background" and post-process with `rembg` or a chroma-key step. There's no transparent-output LoRA installed yet.
- **Per-image generation time:** ~2-25s warm at 768×768 (cold-load on first request adds ~15s). 1280×768 hero shots are ~40-55s. Plan asset batches accordingly.
- **No batched async:** the snippet above is sequential. ComfyUI accepts queued submissions but Mini-2 is single-GPU; parallelism gains are marginal.
- **"Empty terrain" prompts are difficult:** SDXL Turbo strongly wants to populate scenes. Even with explicit negatives ("no buildings, no structures") it often slips a hut or two in. For a true empty plot, lead with "completely empty land" and pile on negative variants. If still populated, generate-and-crop or in-paint to remove.

## Don'ts (lessons captured this session)

1. **Don't run image gen on Jetson Orin Nano** (`192.168.68.73`). The container exists but Tegra NvMap heap OOMs even with `--novram --use-split-cross-attention --bf16-vae`. SD-class diffusion needs >8GB unified contiguous mem; Orin Nano can't deliver it. Reserved for future FLUX-schnell-GGUF Q4 experiments only.
2. **Don't repeat the V2 cyberpunk-industrial direction** (`~/Desktop/kagent-comfyui-concept/{operator-v2,langfuse-v2,login-screen,kagent-crest,buildout-scene}.png` on the project owner's mac). That batch was a visual mis-step.
3. **Don't repeat the W3/CoC daylight direction for the workbench.** The Clash-of-Clans batch is gorgeous but creates a jarring fade-out problem when transitioning to the dark-amber inner UI. Marketing/hero use is fine — workbench is RA2.
4. **Don't apply Pixel Art LoRA when the prompt already says "voxel sprite" / "pixel art"** — it doubles the constraint and darkens output.
5. **Don't apply Lightning LoRA to stylized art** — it's tuned for photoreal detail and breaks the cartoon shading.
6. **Don't skip the anti-SC2 negatives.** Without them SDXL drifts into Blizzard territory: dark, painterly, muddy. Always include `StarCraft, SC2, Blizzard, dark, gritty, muddy, painterly` in the negative.
7. **Don't try to render readable text in-image** — SDXL will produce gibberish. Composite text in your DOM/SVG layer.
8. **Don't commit large generated images to the repo without curating.** Keep only locked-style exemplars in `docs/assets/reference/`. Working drafts belong in `~/Desktop/kagent-ra2-experiment/` or a `.gitignore`d local dir.

## Iterating with intent

When a generated asset doesn't land, the failure mode is usually one of:

- **Drifted into SC2/grimdark territory.** Fix: re-emphasize "Red Alert 2", "Westwood", "bright", "cartoony military", "blue sky" in the positive; pile on `StarCraft, SC2, Blizzard, dark, muddy, painterly` in the negative.
- **Prompt too literal in a fantasy-trope direction** (e.g., "command tower" → model produces a castle). Fix: anchor with concrete material/era cues — "low concrete bunker with white satellite dish on top", not just "command tower".
- **Style suffix not strong enough.** Fix: re-prompt with the negative explicitly listing the wrong direction (e.g., add "NOT a fantasy castle" if you keep getting castles).
- **Composition wrong scale.** Single-building sprite needs `single isometric building sprite of`; whole base panorama needs `wide isometric battlefield`. The model lifts these literally.
- **Too populated when you wanted empty.** Fix: lead with "completely empty land, NO BUILDINGS, NO STRUCTURES, NO TRAFFIC" + heavy negatives. SDXL really wants to populate scenes.
- **Color drift.** Re-emphasize palette explicitly: "blue trim, white panels, red accents, weathered concrete tile."

Same seed across iterations keeps composition stable while you tweak prompt; new seed for fresh attempts.
