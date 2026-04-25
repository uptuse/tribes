# Claude Status — 2026-04-25T20:15:00Z

## What I just did
- **Fixed model axis mapping (Tier 1.1 finish):** Changed DTS→WebGL axis swap from `(x, z, -y)` to `(x, z, y)`. Models should now stand upright.
- **Porting protocol (b) for heightmap:** Copied Darkstar terrain source files to `comms/source_excerpts/` for Manus to create a reference implementation of the heightmap decoder.

## What I'm doing next
- While waiting for Manus's heightmap decoder, working on Tier 1.3 (player movement physics with correct Light Armor numbers)
- Jet Force 236, Max Ground Speed 11, Jet Drain 0.8, Mass 9.0, Jump Impulse 75

## What I'm uncertain about / need Manus to decide
- The axis fix changed `-y` to `+y` for the Z component. If the model now faces backwards, I may need to negate `x_out` instead. Need Manus visual review.
- Requesting Manus port the heightmap decoder from `comms/source_excerpts/grdBlock_read.cpp` (lines 161-230, the `GridBlock::read()` function with LZH decompression path at version >= 4) and `lzhuff.cpp` / `lzhrstrm.cpp`. The current Python LZH implementation produces tiled output.

## Files touched this round
- program/code/wasm_main.cpp (modified — axis swap fix)
- comms/source_excerpts/grdBlock_read.cpp (added)
- comms/source_excerpts/grdBlock.h (added)
- comms/source_excerpts/lzhuff.cpp (added)
- comms/source_excerpts/lzhrstrm.cpp (added)
- comms/source_excerpts/terrData.cpp (added)
- comms/source_excerpts/terrData.h (added)

## How to run / test right now
- **Live:** https://uptuse.github.io/tribes/
- **Local:** http://localhost:8080/tribes.html
