# Design tokens — blue block system

Source of truth for the pi-mistral-native visual identity. Ingestion source
for the documentation website and for any future design
iterations of the README banner ([`assets/banner.svg`](../assets/banner.svg),
[`assets/banner.png`](../assets/banner.png), editable design study:
[`assets/banner-source.html`](../assets/banner-source.html)).

Derivation: Mistral's visual language uses discrete, hard-edged rectangles,
near-zero border radius and one saturated hue ramp (live mistral.ai logo:
`#FFAF01 → #C4001D`). The blue block system is a cool-hue mapping of that
ramp — the lightness descent and the "one wide signature bar" structure are
preserved, the orange warmth is replaced with blue coolness. The banner
reads "Mistral ecosystem" without copying the brand.

## Palette

| Token | Hex | Role |
|---|---|---|
| Sky | `#4CC9FF` | Lightest ramp step; accents, dots, highlights |
| Azure | `#1FA7FF` | Ramp step 2; eyebrows/labels, links, secondary accent |
| Primary | `#0B7FE0` | The signature blue; widest bar, π glyph, focus states |
| Deep | `#0A5BD0` | Ramp step 4; hover state of Primary |
| Ultramarine | `#0B3FB0` | Darkest ramp step; feet blocks, dark ramp base |
| Ink | `#101826` | Dark surface; text on light surfaces |
| Cool ivory | `#F2F7FF` | Light surface for cards and banners |
| Text on dark | `#E8F0FA` | Body text on Ink surfaces |
| Blue-tinted shadow | `rgba(20, 60, 140, 0.12)` | Shadows on light surfaces (cool-shifted analog of Mistral's warm shadows) |

### Ramp mapping (warm → cool)

| Mistral original | Blue system |
|---|---|
| `#FFAF01` (yellow) | `#4CC9FF` (Sky) |
| `#FF8204` (amber) | `#1FA7FF` (Azure) |
| `#FA500F` (signature orange) | `#0B7FE0` (Primary) |
| `#E51300` (vermilion) | `#0A5BD0` (Deep) |
| `#C4001D` (deep red) | `#0B3FB0` (Ultramarine) |

## Motion tokens

| Token | Value | Application |
|---|---|---|
| Fall-in | `500ms ease-in` | Block entrance, per Mistral's `markitecture-fall`/`bento-fall` |
| Block stagger | `calc(var(--i) * 60ms)` | Per-block entrance delay (reverse-index stagger in the original) |
| Settle overshoot | `scaleY 0.95 → 1.02 → 1` at 65%/80%/100% | Landing feel after fall-in |
| Pop-in | `500ms cubic-bezier(0.68, -0.55, 0.27, 1.55)` | Dot/element entrances with overshoot easing |
| Copy entrances | `translateY(20px)` or `translateX(-40px)`, `500ms`, delay 150–450ms, base ease | Wordmark copy enters directionally, staggered behind the blocks |
| Base ease | `cubic-bezier(0.2, 0, 0, 1)` | Standard timing token (Mistral's base 200ms) |
| Hover lift | `translateY(-4px)`, `250ms`, 18ms stagger | Interactive block lift (web contexts) |
| Ambient wash | `64s linear` rotating gradient | Slow background motion (web contexts) |
| Dot pulse | `3s ease-out`, expanding ring | Sky-blue dot ping |
| Reduced motion | `prefers-reduced-motion: reduce` → disable all | Accessibility: animations never required for comprehension |

`assets/banner.svg` carries the fall-in, pop-in, copy entrance and
dot-pulse keyframes inline (the README ships the static PNG — see the
render-protocol note below); hover and ambient wash are web-context tokens
(kept in the design source for the website, which syncs the repository
`assets/` wholesale). Ambient wash is not animated in the SVG export — see
the render-protocol note below.

**Motion principle:** every element's base (un-animated) style is its final
state. Stripping animations — static rasterization, proxies that drop CSS —
leaves a complete, correct still. Motion is progressive enhancement only.

## Platform canvases (verified)

| Platform / theme | README canvas background |
|---|---|
| GitHub light | `#ffffff` |
| GitHub dark | `#0d1117` |

The banner carries its own Ink (`#101826`) background, so a single asset
reads correctly on both canvases; no `#gh-dark-mode-only` variant pair is
needed. README bodies render at max-width 1012px (GitHub); the banner's
1200 × 400 (3:1) canvas keeps text legible at that clamp.

## Typography

- **Wordmark:** system sans stack (SF/BlinkMacSystemFont/Segoe UI/Arial),
  weight 700, tight negative tracking (`-0.025em` display), line-height 1.0.
- **Labels/eyebrows:** monospace stack (ui-monospace/SFMono-Regular/Menlo/
  Consolas), weight 600, uppercase, wide tracking (`0.2em`).
- Hierarchy by size and color only — single weight per family, mirroring
  Mistral's weight-400-everywhere philosophy adapted to display sizes.
- SVG text uses font stacks, not embedded fonts: any renderer with basic
  system fonts produces a faithful result.

## Render-protocol note

The README banner is the static PNG (`assets/banner.png`, this repository)
because renderers outside GitHub — notably the pi package gallery, which
serves SVG as a download rather than an image — do not display SVG. The
animated SVG lives on where SVG renders well: design iterations and this
document link it directly, and it stays the source for the PNG.

Where the SVG is linked, GitHub raw image serving does not transform it
(served as `image/svg+xml` with the committed keyframes intact), so CSS
animations inside the SVG run in all modern browsers. If a client strips
CSS or sets `prefers-reduced-motion`, the banner degrades to the complete
settled still — by design, every element's base style is its final state
(see motion principle above).

## ADR status note

This file is a design-token handover, not an ADR; no ADR is required for
assets + README + docs changes (see `docs/adr/README.md` criteria — no
architectural decision is taken here).
