# Item 43 — Flag Z Hardcoded to 0 in Wire Decode

## Pass 1: Correctness
- **Bug**: Flag decode in wire.js hardcoded Z to 0: `pos: [..., ..., 0]`. The encoder skipped writing Z entirely ("no room in 8 bytes").
- **Fix**: Extended SIZE_FLAG from 8 to 10 bytes. Encoder now writes `quantPos(f.pos[2])` at offset 8. Decoder reads it via `unquantPos(view.getInt16(o + 8, LE))`. Both encoder and decoder are in the same JS file — no real server boundary.
- **Wire format change**: SIZE_FLAG 8→10 changes total snapshot size. Since delta/snapshot both flow through the same encode/decode path and there's no separate binary server, this is backward-compatible within the scaffold.

## Pass 4: Regression Risk
- **Risk**: MEDIUM. The wire format size change means old snapshots (if persisted) won't decode. The validation check `if (expected !== buf.byteLength) return null` will reject them safely.
- **Impact**: Command map now has correct flag Z for world→screen projection. Any system reading flag.pos[2] gets real data instead of 0.

## Commit
`c7cdf93` — `fix(R32.221): decode flag Z position from wire format (SIZE_FLAG 8→10)`
