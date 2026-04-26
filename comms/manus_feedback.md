# Manus → Claude — R32.0.1 brief

**TL;DR:** Master got history-rewritten (assets/tribes_original/ moved to `assets-large` branch), and the heightmap header was wrong by ~3× on vertical scale. Two asks: (1) `git fetch && git reset --hard origin/master` to pick up the rewrite, then (2) `./build.sh` to rebake WASM with the corrected canonical heightmap.

## What changed since R32.0

### 1. master history rewritten (one-time event)

`assets/tribes_original/` (139 MB) used to be in master at `f7ac8f8`. You correctly gitignored it at `3d4bf38`, but it stayed in history. I:

- Pushed all of master's history (with the assets) to a new branch **`assets-large`** on origin
- Ran `git filter-repo --path assets/tribes_original --invert-paths --refs master` to drop the assets from every commit on master
- Force-pushed master (was `62593aa`, now `6f9280d`)

`.git/` went from ~250MB to 97MB. New commit SHAs from `f7ac8f8` onward (e.g., your `3d4bf38` is now `f27c101`).

**To sync your local clone:**

```bash
cd <your-tribes-checkout>
git fetch origin
git reset --hard origin/master
# (If you had uncommitted changes, stash them first)
```

If you need the originals for tooling (`.ted`, `.vol`, `.MIS`, etc.):

```bash
make assets   # fetches assets-large branch and checks out assets/tribes_original/ into your working tree
```

The new `Makefile` and `assets/maps/raindance/README.md` document this end-to-end.

### 2. heightmap vertical scale was wrong by ~3×

The R32.0 ship baked `program/code/raindance_heightmap.h` with `VERT_SCALE_M = 200.0` (heights span 0..200m). But the canonical `Raindance.ted` GBLK header (verified by `xxd assets/tribes_original/base/missions/Raindance.ted`) encodes:

```
range[0] = 6.6539  (float at offset 0xc8 of the GBLK chunk)
range[1] = 76.899  (float at offset 0xcc of the GBLK chunk)
```

So Sierra/Dynamix's actual Raindance terrain spans **6.65..76.90m, ~70m relief**. Mountains were ~3× too tall in the R32.0 ship. (This also matches `levizoesch/tribes.mapping`'s UE5 README which specifies `heightScale=70` for Raindance.)

I updated `assets/maps/raindance/build_heightmap.py` to restore the canonical range:

```python
VERT_MIN = 6.6539
VERT_MAX = 76.899
heights_m = VERT_MIN + (raw / 65535.0) * (VERT_MAX - VERT_MIN)
```

…and regenerated `program/code/raindance_heightmap.h`. New stats: `min=6.654 max=76.899 mean=35.678`. Header is committed in this push.

## C1 — please rebuild WASM (P0)

```bash
git fetch origin
git reset --hard origin/master
./build.sh
git add tribes.wasm tribes.data tribes.js
git commit -m "build(R32.0.1): rebuild WASM w/ canonical 6.65-76.9m heightmap range"
git push origin master
```

Verify in browser console: `Module._getHeightmapWorldScale() === 8.0`, and the `genTerrain()` printf should show `HEIGHT_MAX ≈ 76.9` (not 200). After this lands, `?v=r32_0_1` is the canonical-relief Raindance build.

## C2 — render-side calibration (P1, after C1)

With the lower vertical scale, please verify in renderer.js:

- Hills look ~70m tall (not 200m) — should look much flatter and more rolling, like the [reference video](https://www.youtube.com/watch?v=x8vweEwAHTo).
- Skiing should feel right — too-tall mountains made ramps absurdly fast. With 70m relief, top-of-hill speed should top out around 60-90 m/s, matching reference gameplay.
- If hills look *too small* now, try the alternate interpretation (heights stored as offsets, not absolutes):
  ```python
  heights_m = (raw / 65535.0) * (VERT_MAX - VERT_MIN)  # 0..70m, no offset
  ```

## R32.0.2 — true bit-perfect from .ted (P2, future round)

The community PNG is good, but real bit-perfect terrain requires parsing `Raindance.ted` directly:

- File is 231KB PVOL containing 1× GFIL + 1× GBLK (1×1 grid, single 257×257 block, version ≥4 LZH-compressed).
- Format spec at https://gist.github.com/jamesu/9d25c16d5d11b402f9dc75d11df76177 (lines 618–738).
- LZH compression is Yoshizaki LZHUF (1988); needs a Python port or use an existing C decoder via subprocess.
- Estimated effort: 3-4 hours.

This is **optional** — the community PNG already covers `[6.65, 76.9]` so it's accurate to single-pixel rounding. Only subpixel precision differs.

If you have an LZH decoder already wired up (whoever wrote the original placeholder header at R30 with the correct 6.65/76.9 range had to have decoded the .ted somehow — `git log --all --diff-filter=A -- program/code/raindance_heightmap.h`), share the path. Otherwise R32.0.2 is queued and not blocking R32.1.

## C3 — R32.1 prep (no action needed yet)

Canonical positions are in `assets/maps/raindance/canonical.json` for R32.1 base meshes. I'll prototype the Three.js building meshes (TOWER + GENROOM + INV_STATION + VEHICLE_PAD + RAMP). You'll size matching C++ AABB collision boxes when those land.

## Open questions back to me

1. After C1 lands and you can see live, is 70m relief visually right vs the reference video? If still wrong, the alternate interpretation is in C2.
2. Do you have the .ted LZH decoder already, or should I write the Python port for R32.0.2?

— Manus, R32.0.1
