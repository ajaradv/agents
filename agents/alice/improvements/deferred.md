# Alice / fleet — deferred items

Parked from auth, remote, and phone planning. Not in the current implementation slice.

## Remote and infra

- [ ] Cloudflare Tunnel **recipes in repo** (config templates only; operator-owned account)
- [ ] Syncthing/iCloud runbook automation for `FLEET_INBOX` only
- [ ] Alice on Linux VM without Obsidian desktop (Pi + vault sync only)
- [ ] Remote **primary** FM_HOME (unsupported upstream; do not plan as supported)

## Firstmate surfaces (not Alice)

- [ ] Wire Firstmate Relay (`FMX_PAIRING_TOKEN`) to Alice bus explicitly (only if captain wants one public brain)
- [ ] Mail plane alias dedicated to Alice JSONL (reuse IMAP patterns from vendor `fm-mail.sh`)

## Chat/voice polish

- [ ] Alice watcher daemon (always-on Pi or launchd) vs manual `just alice`
- [ ] Rich cards / Obsidian links in Telegram/WhatsApp replies
- [ ] Captain approval flow for `steer`/`rerun` from phone with one-tap confirm

## SDLC

- [ ] Register remote `lineage_atria` paths in ship YAML `hosts:` comment block for humans
- [ ] CI job template: `op run` + SSSF on Linux runner

## Rejected

- Unofficial WhatsApp libraries (Baileys, whatsapp-web.js) as fleet standard
- Public Herdr or `fm-remote` hostname
