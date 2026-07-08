# PROFILE-PAYLOAD-CONTRACT — the canonical payload is a byte-level external contract

Task: `docs/profile-payload-external-contract`. SSOT anchor: DESIGN §5.4 (폰트 프로파일,
Contract B) + ADR-0001. Governs `buildCanonicalPayload` in `web/src/profile.ts`.

## What this doc is for

DESIGN §5.4 promises a browser **"generate a profile from my own TTF"** tool and, later,
a profile-sharing ecosystem. That means profiles will one day be produced by code that is
**not** the bundled exporter (`scripts/export-atlas.ts`). This page states the contract any
such external profile generator must honor, so a future implementer finds it before writing
a second serializer.

## The contract

`buildCanonicalPayload(profile)` in `web/src/profile.ts` is the **single, authoritative
byte-layout definition** of a font profile's identity. `profileHash` is `sha256` over the
bytes it emits (`computeProfileHash` → `sha256Hex(buildCanonicalPayload(...))`), and
`verifyProfileHash` re-runs the *same* function on load and rejects the artifact on any
mismatch. The bundled exporter imports the identical function, so the produce side and the
verify side are provably byte-identical — there is exactly one payload definition in the
repo, not two that must be kept in sync.

The payload covers the **full** profile, not coverage alone (ADR-0001 / Contract B):

- header: `u32 version`, `str font.family`, `f64 font.size`, `u32 cellW`, `u32 cellH`,
  `f64 ascent`
- per glyph, **in array order**: `str ch`, `u32 cp`, `bytes coverage` (decoded from
  `alphaB64`), `f64 sumA`, `f64 sumAA`, `f64 gradAA`, `f64 ink`

Encoding is fixed and load-bearing: all integers little-endian; `str s` = `u32`
utf8-byteLength ++ utf8 bytes; `bytes b` = `u32` length ++ raw bytes; floats are `Float64`.
Glyph **order** is part of the identity — the same glyphs in a different order hash
differently.

## Why byte-level identity, not "semantic equality"

The hash is not a checksum of the coverage bitmap alone; it is the seal on everything the
matcher trusts. Under Contract B (ADR-0001, ruling on external-review finding F3) the
per-glyph scalar stats (`sumA`, `sumAA`, `gradAA`, `ink`) are **first-class objective
truth**: `decodeProfile` feeds them straight into the atlas, and the CPU/GPU matcher score
functions consume the *stored* values (the GPU path explicitly declares "stored `sumAA` is
objective"). These scalars are computed from the generator's **high-resolution** atlas,
while the stored coverage (`alphaB64`) is quantized to `u8`. A loaded profile must reproduce
the **same matching result** as the live high-resolution path, so the scalars — not just the
coverage — have to be sealed. If the hash covered coverage only, a tampered or drifted
`sumAA`/`ink` would pass verification and silently skew every match. That is exactly the gap
Contract B closes, and it is why the payload — and therefore the byte layout — is the unit
of protection.

Consequence: **the hash protects a byte layout, not a concept.** Two serializers that a
human would call "equivalent" (e.g. one writes floats big-endian, or orders glyphs by
codepoint instead of atlas order, or emits `str` length as a varint) produce different bytes,
hence different hashes, hence artifacts that fail `verifyProfileHash` against every
in-repo consumer. There is no tolerance and no normalization step — byte identity is the
whole mechanism.

## The two allowed paths for an external profile generator

Any code outside `scripts/export-atlas.ts` that produces a shippable profile MUST take one
of these two paths. There is no third option.

1. **Reuse `buildCanonicalPayload` as a shared library.** Import `computeProfileHash` /
   `buildCanonicalPayload` from `web/src/profile.ts` and hash through it, exactly as the
   bundled exporter does. This is the only way to stay byte-compatible with existing
   `version: 1` profiles and existing loaders without a version bump. Preferred.

2. **Re-implement the layout independently → then you MUST bump the profile `version`.**
   If a generator cannot import the function (different language/runtime, e.g. a Rust or
   WASM TTF tool) and re-derives the byte layout by hand, treat that as a **new payload
   format** even if it is intended to match. An independent reimplementation is not
   trustworthy as byte-identical until proven so, and any *deliberate* layout change (new
   field, different float width, different glyph ordering) is by definition a new format.
   Bump `Profile.version`, and have loaders/verifiers dispatch the canonical-payload
   construction on `version`. Shipping a new byte layout under the old version number
   silently breaks every consumer's hash check.

The rule of thumb: **if the bytes can differ, the version must differ.** Reusing the shared
function is the way to guarantee the bytes cannot differ.

## Where the code lives

- `web/src/profile.ts` — `buildCanonicalPayload`, `computeProfileHash`, `verifyProfileHash`,
  `decodeProfile`, `loadProfile`, and the `Profile` / `ProfileGlyph` types.
- `scripts/export-atlas.ts` — the bundled exporter (`atlasToProfile`); the reference
  producer, and the model for path 1.
- `docs/adr/ADR-0001-profile-stats-objective-contract.md` — the Contract B ruling and the
  rejected Contract A alternative.
- DESIGN §5.4 — the SSOT statement (profile = font + size + cell aspect + glyph coverage set
  + scalars + hash; hash covers the full canonical payload).
