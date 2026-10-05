---
name: Fleet
description: Punched pixel leaves for the local fleet dashboard.
colors:
  bone: "#f4efe4"
  sheet: "#fffaf2"
  ink: "#1a1a1a"
  quiet: "#3d4a3a"
  teal: "#0f6e68"
  yellow: "#8a6200"
  ultra: "#2436a8"
  vermilion: "#9c1230"
  night: "#071018"
  hover-sheet: "#efe6d4"
typography:
  display:
    fontFamily: "Silkscreen, ui-sans-serif, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  headline:
    fontFamily: "Silkscreen, ui-sans-serif, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Silkscreen, ui-sans-serif, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  body:
    fontFamily: "Silkscreen, ui-sans-serif, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
  label:
    fontFamily: "Silkscreen, ui-sans-serif, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  none: "0"
spacing:
  grid: "8px"
  sm: "0.4rem"
  md: "0.75rem"
  lg: "1rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bone}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.35rem 0.55rem"
  button-primary-hover:
    backgroundColor: "#333333"
    textColor: "{colors.bone}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.35rem 0.55rem"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.35rem 0.55rem"
  button-secondary-hover:
    backgroundColor: "{colors.hover-sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.35rem 0.55rem"
  tab-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bone}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0.45rem 0.7rem 0.45rem 0.45rem"
  sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.85rem 0.95rem 1rem"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.45rem 0.55rem"
---

# Design System: Fleet

## Overview

**Creative North Star: "Punched Pixel Leaves"**

The dashboard is a tabbed board drawn on a pixel grid. One leaf is open and readable. Health, fleet, and agents are sections you hinge between. Alice is a full-height panel that slides in from the right over a night crossing. The page refuses a scrolling pile of cards and a chat bar pinned to the footer.

Type, borders, and state marks are bitmap and square. Color is a reading of state: teal when a meter or detent is healthy, yellow when it is mid, ultramarine for focus, vermilion when something is waiting. Controls stay ordinary buttons, tabs, and fields. The only motion is a 90ms two-frame hinge when a leaf opens.

**Key Characteristics:**

- One open leaf. Closed leaves are not drawn.
- Bone ground ruled at 8px, 1px ink edges, no radius and no drop shadow.
- Silkscreen for display and body.
- Selection is a punched square. A waiting agent rings that punch in vermilion.
- Phone width stacks every grid to one column. A bottom dock replaces the tabs.

## Colors

Bone paper, ink lines, and four state colors. Secondary text is olive quiet, never gray.

### Primary

- **Ink** (#1a1a1a): type, borders, the selected tab, and the primary button.
- **Bone** (#f4efe4): the page ground. An 8px ink grid at 6% opacity is drawn over it as the registration surface.

### Secondary

- **Teal** (#0f6e68): healthy meters and detents.
- **Yellow** (#8a6200): mid meters and in-progress detents.
- **Ultramarine** (#2436a8): focus rings, the text caret, and text selection.
- **Vermilion** (#9c1230): exhausted meters, errors, the waiting slip, and the ring on a tab that needs the captain.

### Neutral

- **Sheet** (#fffaf2): card, field, log, and unselected tab fill.
- **Night** (#071018): the fallback behind the crossing, and the chat scrollbar track.
- **Quiet** (#3d4a3a): secondary lines, timestamps, and idle detents.
- **Hover sheet** (#efe6d4): hover fill on unselected tabs and secondary buttons.

### Named Rules

**The State Color Rule.** Teal, yellow, ultramarine, and vermilion mark state. They are not decoration on headings.

**The One Leaf Rule.** Only the open section is displayed. Do not stack the other leaves underneath it.

## Typography

**Display Font:** Silkscreen (with ui-sans-serif, sans-serif)
**Body Font:** Silkscreen (with ui-sans-serif, sans-serif)

Silkscreen is Jason Kottke’s bitmap face, SIL Open Font License, self-hosted at `/fonts/silkscreen-latin-400.woff2`. Weight is 400 throughout. Scale comes from size, not weight.

### Hierarchy

- **Display** (400, 1.75rem, 1.2): the word Fleet. 1.35rem below 640px.
- **Headline** (400, 1.35rem, 1.2): the open leaf’s name.
- **Title** (400, 1rem, 1.2): sheet titles and section labels inside a leaf.
- **Body** (400, 16px, 1.45): page copy.
- **Label** (400, 0.8rem, or 0.72rem on detents and buttons): meters, timestamps, and controls.

### Named Rules

**The Bitmap Rule.** Do not load a hosted font stylesheet. The fallback stack exists only when the local file fails.

## Layout

The page is centered at a max width of 72rem with 1rem of side padding, over the sea chart. Leaves stack their contents with 0.85rem gaps. Sheets sit in auto-fit grids: three-up from 14rem, two-up from 16rem. Below 640px both grids and the metric pair become one column, body padding tightens, and a four-item dock sits on the bottom edge. Alice’s panel is `100vw` by `100dvh` and, on a phone, leaves room for that dock.

Space above a leaf heading is the tab bar’s 1.1rem margin. Space below that heading is 0.85rem.

## Elevation & Depth

The system is flat. Depth is the open leaf versus the leaves that are not drawn, plus a 1px ink border on every sheet. There is no drop shadow. The selected punch uses a 2px inset bone ring so the hole reads as punched through the black tab.

### Named Rules

**The Flat Rule.** Do not add offset shadows, glass, or blur. The hinge is the only depth cue, and it lasts 90ms.

## Shapes

Corners are square. Borders are 1px ink. The punch is a 10px square. A detent mark is a 6px square. The hinge clips the leaf from the left in two frames (`steps(2)`, 90ms). Reduced motion removes that animation.

## Components

### Buttons

- **Shape:** square corners, 1px ink border.
- **Primary:** ink fill, bone text, 0.35rem 0.55rem, 0.72rem type. Hover shifts the fill to #333333.
- **Secondary:** sheet fill, ink text, same padding. Hover fills with hover sheet.
- **Disabled:** 45% opacity, not-allowed cursor.
- **Focus:** 2px ultramarine outline, 2px offset.

### Cards / Containers

- **Corner Style:** square.
- **Background:** sheet on bone.
- **Shadow Strategy:** none. See Elevation.
- **Border:** 1px ink.
- **Internal Padding:** 0.85rem 0.95rem 1rem.

### Inputs / Fields

- **Style:** 1px ink border, sheet fill, square corners, 0.85rem type.
- **Focus:** the shared ultramarine outline. Caret is ultramarine.
- **Disabled:** follows the button opacity when the control is a button.

### Navigation

Desktop tabs: Health, Fleet, Agents, and an Alice control that opens the panel. Unselected tabs are sheet with an empty punch. The selected tab is ink with a punched hole. Hover on an unselected tab uses hover sheet. If something is waiting on the captain, the Agents punch grows a vermilion ring. Below 640px the tabs are replaced by a bottom dock with the same four destinations. The active dock item is ink. Alice’s item uses her portrait.

### Meters and detents

A meter is a square label whose border and text are teal, yellow, or vermilion. A detent is a word with a 6px square in quiet, teal, yellow, or vermilion. These are state marks, not pills.

### Leaf hinge and Alice panel

Opening a leaf sets a 90ms two-frame clip from the left. Opening Alice slides the full-viewport panel in from the right on the same 90ms, two-frame timing. `prefers-reduced-motion: reduce` disables both. The panel’s ground is the night crossing. Messages are square bubbles: Alice on the left with her portrait, the captain on the right in ink with the captain portrait. System lines sit in the center without a portrait.

## Do's and Don'ts

### Do:

- **Do** keep one leaf open, and put Alice’s composer in the full-height panel.
- **Do** use bone, ink, sheet, quiet, teal, yellow, ultramarine, and vermilion at the hex values above.
- **Do** self-host Silkscreen and keep the license comment next to the `@font-face`.
- **Do** stack sheets to one column below 640px.

### Don't:

- **Don't** add a radius, a drop shadow, glass, or a gray secondary text color.
- **Don't** put a kicker or eyebrow above a heading.
- **Don't** load Tailwind, DaisyUI, or a hosted font stylesheet.
- **Don't** invent usage figures. Meters show what the server partial returned.
