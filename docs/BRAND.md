# Keepr Brand — Do / Don't (v1, 2026-07-19)

Decisions made with the founder on 2026-07-19. Change only with founder sign-off.

## The mark — "roofline K"
Indigo squircle tile, white custom K whose stem tops out in a roof gable (real-estate nod), gold dot. Source of truth: `keepr-logo-assets/mark.svg` (squircle) + `mark-fullbleed.svg` (favicon variant); in code, the `AppMark` component (electron `src/components/common/AppMark.tsx`, shared `@keepr/ui`).
- Palette: indigo gradient `#4F46E5 → #6D5DF0` · glyph `#FFFFFF` · gold dot `#F5A524` · ink `#14162B`.
- DO keep the gold dot at all sizes (founder decision).
- DON'T recreate the K from a font — it is a custom drawn glyph.

## Mark vs wordmark (the K-stutter rule)
The mark IS a letter K, and the wordmark starts with K — never place them side by side ("K. Keepr." stutters).
- DO use the MARK alone in square/tiny surfaces: app icon, favicons, social avatar, collapsed sidebar, About screen.
- DO use the text WORDMARK "Keepr." alone wherever text fits: landing nav, expanded sidebar, headers.
- DON'T combine mark + wordmark horizontally. (A stacked lockup — mark above wordmark — is acceptable on marketing surfaces only.)

## Wordmark styling
"Keepr" in the system font stack, weight 800, tight tracking (−0.02/−0.03em), near-black; the trailing period is ALWAYS gold `#F5A524` when the wordmark stands alone (shared `<Wordmark/>` in `@keepr/ui`).
- DON'T gold-dot periods inside prose sentences ("…with Keepr." stays plain).
- DON'T render the wordmark as plain black text on branded surfaces.

## Login pages (all surfaces)
Pattern (founder-approved "Option A"): centered auth card → decorative mark (~60px) → plain heading "Sign in to Keepr" (NOT the wordmark; no gold dot in the sentence) → uppercase portal label → auth controls → legal footer (Terms + Privacy links).
- DON'T put the styled wordmark inside the heading sentence.
- DON'T use trial language ("14-day free trial") anywhere — Keepr is PAYG: the app is free; users pay per export/unlock.

## Favicons & app icons
- Favicons MUST be full-bleed opaque squares (indigo fills every pixel). DON'T ship transparent/rounded corners — browsers matte them white.
- App icons (.icns/.ico) use the squircle with proper 8-bit alpha.
- Regeneration pipeline (only if assets must be rebuilt): render SVG via WebKit (`qlmanage -t`), then `sips`/`iconutil`/`magick` from the PNG. NEVER rasterize the SVG directly with ImageMagick (it mangles gradients + text).

## Sidebar
Collapsed: mark alone, centered. Expanded: gold-dot wordmark + portal label. The expand/collapse control is an edge tab on the sidebar border, never in the header row next to the brand.
