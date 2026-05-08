# Image Asset Generation Primer

For any agent (Claude / Codex / etc.) generating image assets for kagent.

## TL;DR

Visual style is **locked to Clash of Clans / Warcraft 3** — bright daylight, grass tiles, water, saturated cartoon palette. NOT cyberpunk-dark-industrial, NOT Factorio belts, NOT photorealistic. Submit txt2img workflows to `http://Mini-2.local:8188`. Reference exemplars live in [`docs/assets/reference/`](./assets/reference/).

## Where image gen runs

ComfyUI is host-installed and launchd-managed on `Mini-2.local` (Apple M4, 16GB, MPS). No auth on the LAN.

- **Endpoint:** `http://Mini-2.local:8188` or `http://192.168.68.60:8188`
- **API:** standard ComfyUI JSON-graph (`POST /prompt`, poll `/history/<id>`, fetch `/view?filename=...`)
- **Service:** launchd agent `io.knuteson.comfyui` on Mini-2; `~/comfyui/run.sh` is what it executes
- **Models dir on Mini-2:** `~/comfyui/ComfyUI/models/checkpoints/` and `~/comfyui/ComfyUI/models/loras/`

If reachability fails: `Mini-2.local` may have shifted IP — re-resolve via `dscacheutil -q host -a name Mini-2.local`. The Jetson installation exists but is OOM-bound and reserved for future FLUX-GGUF experiments only.

## Visual style — locked

**Reference aesthetic:** Clash of Clans / Warcraft 3 game art.

| ✅ Use | ❌ Don't |
|---|---|
| Bright daylight palette | Dark cyberpunk |
| Grass terrain tiles, stone path borders | Neon-overload backgrounds |
| Water, trees, clouds in scenery | Gritty / noir tone |
| Saturated cartoon colors | Photorealistic 3D render |
| Soft shadows, friendly readable shapes | Factorio belts/conveyors |
| Buildings sitting on a tile (RTS sprite) | Fantasy castle with gold dome (model's lazy default for "town hall") |
| 16-bit isometric perspective | Smooth shading / vector flat |

**Why this style:** project owner explicitly anchors to TA / Warcraft 3 / Clash of Clans for the kagent workbench RTS view. The dark-cyberpunk direction was tried and visually rejected; the daylight CoC direction was confirmed against generated samples 2026-05-08.

## Style block to paste into prompts

```
POSITIVE_SUFFIX = "16-bit isometric pixel art, Clash of Clans / Warcraft 3 game art aesthetic, bright daylight, vibrant saturated colors, building sprite sitting on grass terrain tile with stone path borders, water and trees nearby, soft cartoon shading, clean readable composition, friendly tone"

NEGATIVE = "dark cyberpunk, neon overload, gritty, noir, photorealistic, blurry, low quality, watermark, text, signature, fantasy castle dome"
```

Append your subject-specific prompt before the style suffix:
```
"single isometric building sprite of a [your thing here], [features], on grass tile, " + POSITIVE_SUFFIX
```

## Reference exemplars

These eight images in [`docs/assets/reference/`](./assets/reference/) are the locked visual language. **Match this look.**

| File | Subject | Used for |
|---|---|---|
| `hero-coc.png` | Wide base panorama (1280×768) | Splash / login background, project README hero |
| `operator-coc.png` | Town-hall-style command HQ | Operator (K8s controller) building sprite |
| `kagent-gateway.png` | Refinery/factory | LiteLLM Gateway sprite |
| `kagent-agent-pod.png` | Bunker with single dome | Per-agent pod sprite (the substrate's primary unit) |
| `agent-barracks.png` | Barracks with units | Agent spawning building (alternative to pod) |
| `kagent-langfuse.png` | Domed observatory | Langfuse trace store sprite |
| `kagent-nats.png` | Pipeline junction with cyan flow | NATS JetStream message bus / "roads" |
| `buildout-scene.png` | Crane + scaffolding + sparks | Loading / construction-in-progress screen |

When generating a NEW asset (e.g., a building for a future substrate component), open these and prompt with deliberate echoes of their composition language: building on grass, stone borders, water nearby, daylight, saturated.

## Models available

**Checkpoints** (single-file, drop into a `CheckpointLoaderSimple` node):
- `sd_xl_turbo_1.0_fp16.safetensors` — primary. 1-4 step gen at cfg=1.0-1.5, sampler=`dpmpp_sde`, scheduler=`karras`. ~2-25s/image at 768x768 on Mini-2.
- `v1-5-pruned-emaonly.safetensors` — legacy SD 1.5. Bigger LoRA ecosystem, slower (20-30 step). Use only if a specific SD 1.5 LoRA is required.

**LoRAs** (chain via `LoraLoader` node):
- `pixel-art-xl.safetensors` — DON'T use when the prompt already says "pixel art" (over-saturates). Useful for forcing pixelation on photo-style subjects.
- `sdxl_lightning_8step_lora.safetensors` — quality boost for **photorealistic** prompts only. For RTS / stylized art it adds neon-busy detail and breaks the locked style. Use 8 steps, cfg=1.0, sampler=`euler`, scheduler=`sgm_uniform`.

## Working code snippet

Self-contained Python — submits a workflow, polls, downloads the image. No deps beyond stdlib.

```python
import json, urllib.request, urllib.parse, time, uuid

HOST = "http://Mini-2.local:8188"

POSITIVE_SUFFIX = "16-bit isometric pixel art, Clash of Clans / Warcraft 3 game art aesthetic, bright daylight, vibrant saturated colors, building sprite sitting on grass terrain tile with stone path borders, water and trees nearby, soft cartoon shading, clean readable composition, friendly tone"
NEGATIVE = "dark cyberpunk, neon overload, gritty, noir, photorealistic, blurry, low quality, watermark, text, signature, fantasy castle dome"


def generate(subject_prompt: str, *, label: str = "kagent-asset", width: int = 768, height: int = 768, seed: int = 100, steps: int = 4) -> str:
    """Generate one image, return local path. Subject prompt is short; style suffix is appended."""
    full_prompt = f"{subject_prompt}, {POSITIVE_SUFFIX}"
    workflow = {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.5,
            "sampler_name": "dpmpp_sde", "scheduler": "karras", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_turbo_1.0_fp16.safetensors"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": full_prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["4", 1]}},
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
        "single isometric building sprite of a 'Vault' secrets-store strongroom, "
        "heavy iron-banded door, tiny gold-coin counter ticker on the side, "
        "armored stone walls, on grass tile",
        label="kagent-vault",
        seed=200,
    )
    print(f"saved: {path}")
```

## Known limitations

- **Text rendering:** SDXL cannot render readable text. Banners, labels, and UI text come out as gibberish glyphs. Workaround: render the asset without text, then composite real text in code (CSS / SVG / Canvas). FLUX-schnell would fix this but is not installed (16GB unified memory is tight for FLUX).
- **Transparent backgrounds:** none of the installed models support alpha output. To get clean sprites: prompt for "isolated on a neutral grass tile" or "on a flat color background" and post-process with `rembg` or a chroma-key step. There's no transparent-output LoRA installed yet.
- **Per-image generation time:** ~2-25s warm at 768×768 (cold-load on first request adds ~15s). 1280×768 hero shots are ~40-55s. Plan asset batches accordingly.
- **No batched async:** the snippet above is sequential. ComfyUI accepts queued submissions but Mini-2 is single-GPU; parallelism gains are marginal.

## Don'ts (lessons captured this session)

1. **Don't run image gen on Jetson Orin Nano** (`192.168.68.73`). The container exists but Tegra NvMap heap OOMs even with `--novram --use-split-cross-attention --bf16-vae`. SD-class diffusion needs >8GB unified contiguous mem; Orin Nano can't deliver it. Reserved for future FLUX-schnell-GGUF Q4 experiments only.
2. **Don't repeat the V2 cyberpunk-industrial direction.** That batch (kept in `~/Desktop/kagent-comfyui-concept/{operator-v2,langfuse-v2,login-screen,kagent-crest,buildout-scene}.png` on the project owner's mac) was a visual mis-step. Project owner picked the bright/grass set instead.
3. **Don't apply Pixel Art LoRA when the prompt already says "pixel art"** — it doubles the constraint and darkens output.
4. **Don't apply Lightning LoRA to stylized art** — it's tuned for photoreal detail and breaks the cartoon shading.
5. **Don't try to render readable text in-image** — SDXL will produce gibberish. Composite text in your DOM/SVG layer.
6. **Don't commit large generated images to the repo without curating.** Keep only locked-style exemplars in `docs/assets/reference/`. Working drafts belong in `~/Desktop/kagent-comfyui-concept/` or a `.gitignore`d local dir.

## Iterating with intent

When a generated asset doesn't land, the failure mode is usually one of:

- **Prompt too literal in a fantasy-trope direction** (e.g., "command tower" → model produces a castle). Fix: anchor with concrete material/era cues — "multi-tier server rack tower with banner", not just "tower".
- **Style suffix not strong enough.** Fix: re-prompt with the negative explicitly listing the wrong direction (e.g., add "NOT a fantasy castle" if you keep getting castles).
- **Composition wrong scale.** Single-building sprite needs `single isometric building sprite of`; whole base panorama needs `wide isometric panorama`. The model lifts these literally.
- **Color drift.** Re-emphasize palette explicitly: "blue tile rooftops, wooden support beams, golden banner accents".

Same seed across iterations keeps composition stable while you tweak prompt; new seed for fresh attempts.
