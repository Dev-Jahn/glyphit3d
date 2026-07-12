import type { MatchOptions } from './types.js';
import { COUPLING_DEFAULTS } from './coupling.js';

// Shared ASCII-identity preset (spec §5). The identity aesthetic family: the structure-aware
// selection prior (λ_id=5, τ_id=2.5e-4), a charset-coherence mode, and the shape-color coupling
// ("color dither"). Extracted so the node CLI (cli.ts applyIdentity) and the web worker
// (web/src/band-opts.ts) build the SAME MatchOptions from ONE place — the web then only threads the
// three interactive knobs, and the preset lives here.
//
// It deliberately does NOT set the contrast floor — that is the CALLER's (CLI: 24/255 fixed; web: the
// floor slider, params.floor) — nor the quality: identity IS Q2 and matchGrid throws otherwise (no
// fallback), so the caller forces quality 2.
export type IdentityCoherence = 'none' | 'ramp-bias' | 'pure-ramp' | 'smooth';

export function applyIdentityPreset(
  opts: MatchOptions,
  cfg: { coherence: IdentityCoherence; colorDither: boolean },
): void {
  opts.identityLambda = 5;
  opts.identityTau = 2.5e-4;
  opts.identityCoherence = cfg.coherence;
  // Color dither = shape-color coupling. ON (default) → coupling stays the color modulator. OFF →
  // MONOCHROME: leave coupling UNSET (no color-modulation pass) and flag identityColorDither false so
  // matchGrid forces fg=encode(fixedFg) on every identity Q2 emit. resolveCoupling normalizes the
  // COUPLING_DEFAULTS object identically to the CLI's historical `coupling = {}`, so this is
  // byte-identical to the pre-extraction CLI output.
  if (cfg.colorDither) opts.coupling = { ...COUPLING_DEFAULTS };
  else opts.identityColorDither = false;
}
