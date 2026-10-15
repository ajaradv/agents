# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (installable on the phone as a PWA next; see Operating Context)

## Stack

Bun server on `127.0.0.1:8787` (`just dashboard`), htmx 4 partials and Alpine.js on the client, no build step. Agents run in a separate **fleet node** (`dashboard/node.ts`, `127.0.0.1:8786`, token in `fleet/inbox/.node/`): live agent sessions (`pi --mode rpc`), chat turns, open questions, and the crew API. The dashboard starts the node when it is missing and mirrors its state, so restarting the dashboard leaves agents working. The dashboard still serves the ship logs (SQLite per ship), the canvas, and voice.

## Users

The captain, alone. Laptop first, phone as the same fleet. The job is to watch and steer many agents like a game: who is working, who needs an answer, what each ship is doing, and what it costs.

## Product Purpose

A harbor for the agent fleet. **Ships** are projects (`fleet/ships/*.yaml`); **crewmates** are agents aboard a ship (`<ship>-<role>`), with **flagship officers** (Alice, the Architect, the Shipwright, the Designer) on the rail. A ship sails **voyages** (vault notes) broken into **tasks**, runs **maneuvers** (SSSF ADWs), and keeps a **ship's log**. The captain talks to any agent in the chat drawer, by text or push-to-talk, answers their questions inline, reviews their work on the canvas, and sees spend and quotas on Health. Firstmate remains an optional orchestrator per ship.

## Positioning

The fleet's own control surface, not a front end for one harness. It reads Firstmate's state when a ship uses Firstmate, and runs ship leads, crewmates, and officers itself.

## Operating Context

Local machine, bound to loopback; the server refuses requests from other web pages (same-origin guard) and foreign hosts. Remote use is planned through **Tailscale** (the dashboard stays on loopback; Tailscale Serve exposes it to the captain's devices), phone app first, then a hub with device nodes (see the vault: `fleet/plans/research/durable-remote-fleet.md`). Keys come from a 1Password-fed `fleet/home/.env`.

## Capabilities and Constraints

- Sections: **Needs you** (`/needs`: every question an agent is waiting on, Firstmate holds, and messages that did not go through, each answerable in place; the count sits in the mast and is the phone dock's first item), **Harbor** (ships, decks, shipyard), **Health** (Firstmate status, subscription and API lanes, model spend, registry fold), **Agents** (officer cards, crew tables grouped by ship, TUI control, groups). The old Fleet tab was folded into Health on 2026-10-14.
- Chat for every agent and group, as a column beside the page at 1200px and up (the canvas takes the rest of the width when open, and opens by itself when a new item lands) and a full-screen drawer below that: markdown replies, live streaming, ask_captain dialogs answered inline, canvas beside the thread, push-to-talk and spoken replies, Jev auto-routing. Sends are idempotent (requestId).
- Rail and tabs show who is waiting on the captain; the tab title carries the Needs-you count.
- Alice is the omni agent (live session): she reads the whole fleet (`fleet_status`, ship logs, tasks, maneuvers, any agent's thread) and messages any agent (`fleet_chat`) through the node's fleet API; fleet actions that change state come later behind a captain Go. Officers' turns and spend are logged on the `fleet` ship, whose deck lists them as its crew; officers can carry a `daily_budget_usd`.
- Model lanes: Cursor included usage, DeepSeek, OpenRouter (Junie was dropped on 2026-10-14). Every agent has a `fallback_model` on another provider, used when its model's key is missing or the model hit a billing or auth failure that day; per-ship crew budgets and officer daily budgets.
- Do not invent hosts, usage figures, or a public URL. Do not bind beyond loopback without authentication.

## Brand Commitments

Pixel art is binding: the sea chart, portraits, Silkscreen display type, square shapes. No logo file.

## Evidence on Hand

The running UI (`public/index.html`, `app.js`, `md.js`, `pixel.css`) and the server partials. Design critique of 2026-10-14 in the vault (`fleet/plans/research/fleet-ui-critique-2026-10-14.md`). No testimonials or marketing claims.

## Product Principles

- Who needs the captain is visible from anywhere.
- Reading comes first: long replies render as formatted text in a readable face.
- Phone and laptop are the same fleet; on the phone the conversation gets the screen.
- Nothing on screen moves without a real signal behind it; Reduce Motion keeps every state legible.
- Show only numbers and states the fleet actually reports; errors read as sentences, raw detail folded.
