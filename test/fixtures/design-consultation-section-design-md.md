---
# gstack: design-md-format=spec
name: Ops Analytics Dashboard (working name)
description: Warm-gray paper ground, ink type, hairline rules, one signal colour reserved for state. A dispatch board, not a card deck.
colors:
  primary: "#1A1C1A"          # ink; primary buttons, strong rules, pinned sum lines
  on-primary: "#F4F4F1"
  surface: "#F4F4F1"          # page ground; warm gray, near-zero chroma (not cream)
  surface-raised: "#FFFFFF"   # table sheets, panels, popovers
  surface-sunken: "#EBEBE7"   # table header row, zebra rows, disabled fields
  border: "#D7D7D1"           # hairline rules between rows and panels (decorative only)
  text: "#1A1C1A"
  text-muted: "#5E625E"       # 5.6:1 on surface; also the input border colour (3:1 rule)
  accent: "#1F4E79"           # marine blue; links, focus ring, selected row, unfold connector
  success: "#2E6B3F"          # quiet on purpose
  warning: "#8A5F00"          # dried mustard; 5.1:1 on surface
  error: "#C42B2B"            # the one loud colour on the page
  dark-primary: "#E9E9E4"
  dark-on-primary: "#161715"
  dark-surface: "#161715"
  dark-surface-raised: "#1E1F1D"
  dark-surface-sunken: "#101110"
  dark-border: "#2E302D"
  dark-text: "#E9E9E4"
  dark-text-muted: "#9C9E98"
  dark-accent: "#7FB2E5"
  dark-success: "#6FBF87"
  dark-warning: "#E0A93B"
  dark-error: "#FF6B5A"
typography:
  display:
    fontWeight: 600
    fontSize: 1.5rem
    lineHeight: 1.2
    letterSpacing: -0.01em
  kpi:
    fontWeight: 600
    fontSize: 2.25rem
    lineHeight: 1.05
    letterSpacing: -0.02em
    fontFeature: tnum, zero
  body:
    fontWeight: 400
    fontSize: 0.875rem
    lineHeight: 1.5
  table:
    fontWeight: 400
    fontSize: 0.8125rem
    lineHeight: 1.25
    fontFeature: tnum
  label:
    fontWeight: 600
    fontSize: 0.6875rem
    lineHeight: 1.2
    letterSpacing: 0.04em
    textTransform: uppercase
  mono:
    fontWeight: 400
    fontSize: 0.8125rem
    lineHeight: 1.4
    fontFeature: tnum, zero
rounded:
  sm: 2px
  md: 4px
  lg: 6px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: 32px
    paddingX: "{spacing.md}"
  button-primary-hover:
    backgroundColor: "#2E312E"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    borderColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    height: 32px
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "{colors.surface-raised}"
    rounded: "{rounded.md}"
    height: 32px
  input:
    backgroundColor: "{colors.surface-raised}"
    borderColor: "{colors.text-muted}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: 32px
    paddingX: "{spacing.sm}"
  focus-ring:
    outlineColor: "{colors.accent}"
    outlineWidth: 2px
    outlineOffset: 2px
  panel:
    backgroundColor: "{colors.surface-raised}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  table-header:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    height: 32px
  table-row:
    height: 32px
    borderColor: "{colors.border}"
  table-row-compact:
    height: 28px
  table-row-wall:
    height: 44px
  nav-link:
    textColor: "{colors.text-muted}"
    height: 32px
  nav-link-active:
    textColor: "{colors.text}"
    backgroundColor: "{colors.surface-sunken}"
  section-rule:
    borderColor: "{colors.primary}"
    borderWidth: 2px
  status-dot:
    size: 8px
    rounded: "{rounded.full}"
---

# Ops Analytics Dashboard (working name)

## Overview

**Creative North Star:** Industrial/Utilitarian in a dispatch-board register. Every pixel of chroma is information, so an ops lead sees what is off-target, and by how much, before finishing the first read.
**Product context:** B2B analytics dashboard for operations teams (ops managers, analysts, shift leads, on-call staff) in logistics, support, fulfilment, field service and platform ops. They watch throughput, queue depth, SLA attainment, incidents and staffing against targets and drill from a headline number into the rows behind it. Web app dashboard, greenfield, no prior brand.
**Mode per surface:**
- Operate: the dashboard, tables, filters, alerts. The primary surface; everything below is tuned for it.
- Read: scheduled reports and incident write-ups. Same tokens, 72ch measure, body at 1rem.
- Persuade: a small marketing site later. Same palette and faces, more whitespace, display up to 3rem, still left-aligned.
- Experience: none.
**Reference sites:** none. Competitive research was declined; this system comes from the users' own world (rail timetables, shift boards, dispatch sheets, control-room mimic boards), not from remembered competitor screens.
**The one thing to remember (working answer, agent-selected, confirm with the team):** "Nothing on this screen is decoration. You knew what was wrong, and how wrong, before you finished reading."
**Key characteristics:**
- A warm gray sheet with ink type and hairline rules. It reads as a document the team owns, not a product they rent.
- The headline band is a row of numbers with labels underneath, not a row of tiles.
- Red appears rarely, so when it appears you look at it.
- Dense by default. Row height 32px, 13px table type, tabular figures right-aligned to the decimal.
- No drop shadows on the sheet. Depth exists only on overlays.

## Colors

**Strategy:** Restrained. Neutrals plus one interactive hue (marine blue) plus three status hues. Nothing else.
**Light or dark:** Light is the default because the primary use scene is an eight-hour desk session under office lighting, where a dark UI produces glare halos and forces re-adaptation every time the eye leaves the screen. Dark is a real mode, not an inversion, auto-selected for the Wall preset (ops-room screens viewed from distance) and offered on phones for night on-call.

Neutrals derive from a near-zero-chroma warm gray, not blue-gray. `surface` `#F4F4F1` is the ground; `surface-raised` white is where data sits; `surface-sunken` marks table headers, zebra rows and disabled fields. The ground is deliberately not cream: a yellow ground shifts the perceived hue of `warning` toward `error`.

`primary` is ink. Primary buttons, section rules and pinned sum lines are near-black, which keeps all saturated colour free for meaning. `accent` marine blue signals interaction only: links, the focus ring, the selected row, the connector rule on an unfolded drill-down. Blue is the one hue with no status meaning, which is why it and only it may signal "you can act here".

Status hues are ranked by loudness on purpose. `success` `#2E6B3F` is quiet (nothing to see). `warning` `#8A5F00` is a dried mustard chosen to separate from both red and green for deutan and protan viewers and to pass 5.1:1 as text on the ground. `error` `#C42B2B` is the only loud colour on the page. Status is always encoded three ways: hue, a gutter glyph (▲ ▼ ■) and a label or underline. Colour is never the only signal.

Dark theme preserves the same hierarchy: `dark-surface-raised` sits one step lighter than `dark-surface`, `dark-surface-sunken` one step darker, and separation is still a 1px rule, never a shadow or glow. Status hues are lifted in lightness (`dark-error` `#FF6B5A`) because dark surfaces swallow saturation. Text stays warm off-white so day and night feel like one instrument under two lights.

Contrast (computed against the ground): text 16:1, text-muted 5.6:1, accent 7.7:1, success 5.8:1, warning 5.1:1, error 5.1:1. Dark: text 14.8:1, muted 6.7:1, accent 8.1:1, success 8.1:1, warning 8.5:1, error 6.4:1. `border` `#D7D7D1` is 1.3:1 and is therefore reserved for decorative hairlines; input and control boundaries use `text-muted`.

## Typography

**Source world and register:** timetables, dispatch sheets, departure boards, instrument panels. Mode: Operate. The register is a plain, sturdy grotesk for words and a tabular face for numbers. No serif: on this ground with a red status colour a serif display is the cream/serif/terracotta default, and serif hairlines vanish on a wall screen at four metres.

**Font selection: PENDING VERIFICATION.** No font listing could be checked in this session (no web search, no shell). Per the consultation's font-verification rule the `fontFamily` values are omitted from the front matter above and no loading URL is given. Verify each candidate's exact name, weights, license and loading URL on its official Google Fonts or Fontshare listing before adopting; if a candidate fails, take the named alternate. Do not substitute `system-ui`, Inter, Roboto or Arial as the design intent in the meantime; a generic `sans-serif` / `monospace` stack in development is acceptable only until verification lands.

| Role | Candidate (pending) | Alternate (pending) | Weights | Used for |
|---|---|---|---|---|
| Display | Cabinet Grotesk (Fontshare) | General Sans (Fontshare) | 500, 700 | Page titles at 1.5rem, section titles at 1.25rem, marketing headlines up to 3rem. Never body copy. |
| Body and UI | Source Sans 3 (Google Fonts) | IBM Plex Sans (Google Fonts; on the overused list, permitted here as body/UI on an Operate surface because it was drawn for dense data screens and has tabular figures) | 400, 600 | Table cells at 0.8125rem, controls and copy at 0.875rem, Read surfaces at 1rem. Requires `tnum`. |
| Label | same face as Body | same | 600 | Column headers, KPI labels, metadata: 0.6875rem, uppercase, 0.04em tracking. |
| Mono | JetBrains Mono (Google Fonts) | IBM Plex Mono (Google Fonts) | 400, 600 | IDs, SKUs, ISO timestamps, log lines, shift notes, and the hero KPI numerals (see Risks). Requires `tnum` and `zero`. |

**Scale:** 11 / 13 / 14 / 16 / 20 / 24 / 36 px. Each level differs by size, not just weight. KPI numerals are 2.25rem at 600 with -0.02em tracking; the Wall preset scales them to 4.5rem and body to 1.125rem. Body never drops below 12px on desktop or 14px on phone.

**Numerals:** every numeric column and every KPI uses `font-variant-numeric: tabular-nums slashed-zero`, right-aligned, decimal-aligned. A column of numbers must read as a shape.

**Loading strategy (once verified):** self-host WOFF2 with `font-display: swap`, preload the body face only, subset to Latin. Two families and one mono, no more.

## Layout

**Grid-disciplined.** The dashboard is fluid; width is data.

- Desktop (≥1280px): 12-column fluid grid, 16px gutters, 24px page margins. Left rail 240px, collapsible to 56px (icons plus tooltips). No max width on Operate surfaces.
- Laptop (1024 to 1279px): 8 columns, rail collapsed by default.
- Tablet and phone (<1024px): single column. Rail becomes a top bar and drawer. KPI band wraps 2-up. Tables scroll horizontally with the first column and header pinned.
- Wall preset (≥1920px, kiosk): nav hidden, 1.25× type scale, row height 44px, dark theme by default, no hover states.
- Read surfaces: 72ch measure, centred column, left-aligned text.
- Marketing: 1200px max width, same grid, no centred headings.

**Rhythm:** 4px base, 8px step. Panel padding 16px, grid gap 16px, section gap 32px, page section gap 48px. Row height 32px default, 28px compact, 44px wall, selectable from a three-position density control in the toolbar (Compact / Standard / Wall). Interactive elements outside tables keep a 32px minimum height and 40px on touch.

**The headline band (adopted from the independent voice):** the top of every dashboard page is one typographic row of six to eight hero figures, each with its label beneath in the label style and its target set in `text-muted` to the right (`4,812 / 5,000`). Deviation is shown by the figure itself changing colour, a gutter glyph and an underline. No tiles, no icons, no sparklines.

**Drill-down as unfold (adopted from the independent voice):** clicking a hero figure unfolds the rows behind it directly beneath the band. The figure stays pinned as a sum line, a 1px `accent` rule connects the two, and each further level pins another sum line. Breadcrumbs are the stack of pinned sum lines. The user never loses the number they were looking at.

**Intentional grid break:** exactly one. Section titles sit on top of a 2px ink rule that runs the full content width, breaking the column gutter the way a ledger heading sits on its column line.

## Elevation & Depth

The sheet is flat. Panels, tables and the headline band are separated by 1px `border` rules and by `surface-sunken` tints, never by shadows. Depth exists only where something genuinely floats:

- Popover, menu, tooltip: `0 4px 12px rgba(26, 28, 26, 0.12)` plus a 1px `border`.
- Dialog, drawer: `0 12px 32px rgba(26, 28, 26, 0.18)` plus a 1px `border`, over a `rgba(26, 28, 26, 0.32)` scrim.
- Dark theme: shadows drop to `rgba(0, 0, 0, 0.5)` at the same offsets; the 1px `dark-border` does the work.

No zero-offset glow, no coloured halo, no inset highlight, no frosted glass.

## Shapes

Small radii throughout so nothing reads as a bubble.

- `sm` 2px: inputs, selects, tags, table cells with a tint.
- `md` 4px: buttons, panels, popovers.
- `lg` 6px: dialogs and drawers.
- `full`: status dots and avatar marks only. Never on buttons.
- Nested element radius = outer radius minus the gap. A 2px-radius tag inside a 4px panel with 2px inset is correct; a 4px tag inside a 4px panel is not.

## Components

Every component ships all states: default, hover, focus-visible, active, disabled, loading, empty, error, and long-content. States below are the invariants; the Wall preset removes hover states and scales heights.

- **Button primary:** ink on ground, 32px, 12px horizontal padding, 4px radius, 600 weight at 0.8125rem. Hover `#2E312E`. Active darkens to `#0F100F`. Focus-visible: 2px `accent` outline, 2px offset. Disabled: `surface-sunken` background, `text-muted` text, no border. One primary per view.
- **Button secondary:** white, 1px `text-muted` border, ink text. Hover `surface-sunken`.
- **Button ghost:** no border, `accent` text. Hover underlines. Used for inline row actions.
- **Button danger:** `error` background, white text. Only on the confirming step of a destructive action, never in a toolbar.
- **Input / select:** white, 1px `text-muted` border, 2px radius, 32px, 8px padding. Focus: border becomes `accent` plus the focus ring. Error: border `error`, message below in `error` at label size, with an icon. Disabled: `surface-sunken`, no border. Labels above the field in label style; help text below in `text-muted`.
- **Table:** sticky header on `surface-sunken` in label style; 32px rows separated by 1px `border`; numeric columns right-aligned with `tnum`; text columns left-aligned; first column pinned on horizontal scroll. Hover row `surface-sunken`; selected row `accent` at 8% tint with a 2px `accent` left rule inside the cell padding (the rule is inside a rectangular row, not on a rounded card). Sort indicator is a glyph, not a colour. Loading: skeleton rows in `surface-sunken`, no shimmer. Empty: one sentence saying what would be here and the action that fills it. Error: the failing panel keeps its frame and shows the message inline with a retry.
- **KPI figure:** mono face, 2.25rem, 600, `tnum zero`; label beneath; target to the right in `text-muted`; deviation colours the figure, adds a gutter glyph (▲ over, ▼ under, ■ on target) and a 2px underline in the same hue. On target, the figure stays ink. Never boxed.
- **Status:** 8px dot plus label, or figure recolour plus glyph. Success is quiet, warning is mustard, error is red. Never colour alone.
- **Side nav link:** 32px, `text-muted`, 0.8125rem. Hover ink text. Active: ink text on `surface-sunken`, no accent bar. Collapsed rail shows icons at 20px with tooltips.
- **Filter bar:** a single 40px row of inputs and chips under the page title; applied filters render as removable 2px-radius chips in `surface-sunken`. Never a modal.
- **Toast:** bottom-left, white, 1px `border`, 4px radius, status glyph, auto-dismiss 6s except errors, which persist.
- **Section rule:** 2px ink rule with the section title sitting on it, left-aligned.

## Do's and Don'ts

- Do: set every numeric column with `tabular-nums`, right-aligned, decimal-aligned.
- Do: encode every status three ways (hue, glyph, label or underline).
- Do: separate panels with 1px rules and tints; reserve shadows for things that float.
- Do: keep one primary button per view and keep it ink.
- Do: design empty, loading, error and long-content states before shipping a component.
- Don't: put a KPI in a tile with an icon, sparkline and delta chip. The figure is the component.
- Don't: use blue for anything that is not interactive, or any status hue for anything that is not status.
- Don't: nest a card in a card, or put a coloured left border on a rounded card.
- Don't: switch the ground to cream or the display to a serif; that is the stock "warm editorial" look and it breaks the amber/red separation.
- Don't: choose dark because it is a tool. Dark is for the wall and the night shift, decided by the use scene.
- Don't: add a kicker above a heading, an icon tile above a section, or a gradient anywhere.

## Motion

- **Approach:** minimal-functional. Motion exists to keep the user's eye on the number they were reading.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(80ms) hover and pressed states; short(160ms) menus, popovers, tooltips; medium(240ms) drawer, unfold; long(400ms) reserved, currently unused.
- **The one authored moment:** the ledger unfold. Clicking a hero figure slides the rows open beneath it over 240ms ease-out while the figure stays pinned and the `accent` connector rule draws from the figure down to the table header. When a figure crosses a threshold on live data, its colour, glyph and underline transition over 240ms, no flash, no pulse.
- `prefers-reduced-motion`: all durations drop to 0 except opacity fades at 80ms.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-29 | Initial design system created | Created by /design-consultation from product context (B2B ops analytics dashboard); competitive research declined by the user; one native independent voice consulted, Codex unavailable in this harness |
| 2026-09-29 | Light default, dark for Wall preset and night on-call | Decided by the use scene (long desk sessions under office light), not category habit |
| 2026-09-29 | Ink primary; chroma reserved for interaction and status | Serves the memorable thing: every coloured pixel is information |
| 2026-09-29 | Warm gray ground `#F4F4F1`, not cream | Cream plus red status shifts amber toward red; also avoids the cream/serif/terracotta default |
| 2026-09-29 | Headline band of figures and in-place ledger unfold | Adopted from the independent native voice; both keep the user's eye on the number |
| 2026-09-29 | Serif hero numerals rejected | Calibration look one on this palette; serif hairlines fail on wall screens at distance |
| 2026-09-29 | Fonts pending verification | No web search or shell available in-session; fontFamily omitted from tokens until Google Fonts / Fontshare listings are checked |
| 2026-09-29 | Preview deferred | Fonts unverified; the consultation's fallback defers the Phase 5 preview until faces can be verified |

