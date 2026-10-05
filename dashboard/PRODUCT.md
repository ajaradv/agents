# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing Bun dashboard on localhost. This redesign’s client is htmx 4 and Alpine.js. Server routes and partials stay the source of live data.

## Users

The captain, alone. They open the dashboard on the laptop and on a phone as a view of the same local fleet. The job is to see fleet health and steer Firstmate, Alice, and Architect.

## Product Purpose

A local control surface for the agent fleet: usage, agent status, fleet tasks, and captain chat. Success means every current control still works, and the same screen is usable at phone width and on the laptop, without a second Firstmate.

## Positioning

The dashboard talks to the one living Firstmate TUI and reads fleet state. It does not spawn another Pi and it does not replace attaching to Herdr.

## Operating Context

`just dashboard` on the machine that runs the fleet. Captain messages, subscription usage, API-key balances, the fleet snapshot, and agent spaces. A phone-width layout is required. Opening the server beyond its current bind was not authorized.

## Capabilities and Constraints

Keep working: subscription usage, DeepSeek and OpenRouter balances, Hugging Face key presence, collapsed providers without an account, fleet overview, agent chat and TUI badges, Start/Stop TUI, agent-space chat, and Alice chat.

Where those surfaces sit is open: a health landing page, tabs, or a status bar. Alice chat stays reachable and may move into an agent sidebar instead of a fixed footer.

No new product constraint beyond the app as it exists. One Firstmate. Do not invent hosts, usage figures, or a public URL.

## Brand Commitments

The surface is the fleet dashboard. Pixel art is a binding visual constraint for this redesign. No logo file is on hand.

## Evidence on Hand

The running UI is `dashboard/public/index.html` plus the usage, metrics, fleet, agents, and space partials. There are no testimonials, customers, or marketing claims to add.

## Product Principles

- The dashboard is a view of one Firstmate, not a second agent.
- A layout change does not drop a current control.
- Phone and laptop are the same fleet.
- Health is scannable; chat stays reachable.
- Show only numbers and states the fleet actually reports.
