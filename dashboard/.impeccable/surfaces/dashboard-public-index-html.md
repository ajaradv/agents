---
version: 1
slug: "dashboard-public-index-html"
primary_target: "dashboard/public/index.html"
related_targets: []
---

# Fleet dashboard

Mode: operate

Audience: the captain, on a laptop or on a phone, looking at the same local fleet.

Task: scan health, fleet tasks, and agent state, then chat with Alice or start a TUI.

Constraints: every current control stays. One Firstmate. Localhost bind unchanged. Pixel art is binding. Alice is a full-height panel, not a leaf. Phone navigation is a bottom dock.

## Direction contract

THESIS: One leaf is open. Health, fleet, and agents hinge. Alice slides over them from the right at full width and full height, instead of sitting in the tab row or a footer.

OWN-WORLD: Bone chart ground ruled in an 8px pixel grid, ink borders, Silkscreen, punched-hole tabs, and a night-crossing panel. Teal, yellow, ultramarine, and vermilion mark state. Avatars are nautical 16-bit portraits.

STORY: The captain sees whether the fleet needs them, opens the leaf that holds the work, and calls Alice from the tab or the phone dock. Her replies and the captain’s sit in separate bubbles.

FIRST VIEWPORT: The word Fleet sits at the top left, over the sea chart. Under it, Health, Fleet, Agents, and Alice. Health is open. Alice opens the crossing. On a phone the same four destinations are a bottom dock. The primary action on the open leaf is Health, already selected.

FORM: Punched pixel leaves, seed 8095d6f7, with the Alice panel and nautical portraits added by the captain after the first build.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: a leaf hinges in 90ms, two frames. Alice uses that same timing, from the right.
