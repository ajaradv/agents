# Alice improvement backlog

Tracked action plans for phone chat, voice, and related work. **Not implemented** in the auth/remote slice — hand off to Firstmate as a project on ship **`fleet`** (this repo).

## How to brief Firstmate

1. Pick one milestone from [chat-channels.md](chat-channels.md) or [voice-assistant.md](voice-assistant.md).
2. File a ship brief on `fleet` with scope = **one adapter** or **one voice milestone**.
3. Authority: same deny list as [roles/alice.md](../../../roles/alice.md) — no secrets, merge, force-push, retire-home from untrusted channels.
4. Secrets: 1Password vault **`Fleet`**, Environment **`agents-fleet`** — variable names only in git ([fleet/config/env.example](../../../fleet/config/env.example)).

## Prerequisites (control center)

- `FLEET_INBOX` and `ALICE_VAULT` overrides via `bin/launch` ([docs/remote-ops.md](../../../docs/remote-ops.md))
- Synced `fleet/inbox/` if Alice and Firstmate run on different hosts
- [docs/onepassword.md](../../../docs/onepassword.md) for API keys when adapters call Pi or STT

## Files

| Doc | Contents |
|---|---|
| [chat-channels.md](chat-channels.md) | WhatsApp, Telegram, email, Slack, etc. |
| [voice-assistant.md](voice-assistant.md) | Firstmate relay reuse vs Alice-native speech |
| [deferred.md](deferred.md) | Parked items from fleet auth/remote planning |

## Out of scope for these plans

- Unofficial WhatsApp (web scrape) bridges
- Public Herdr endpoints
- Turning Alice into a Firstmate secondmate without an explicit architecture decision
