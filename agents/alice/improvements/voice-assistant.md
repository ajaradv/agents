# Alice: voice assistant

Goal: speak to the fleet from a phone or laptop mic and get answers grounded in vault + bus, within Alice authority.

## Existing Firstmate voice (not Alice today)

Vendor path ([voice-relay.md](../../../vendor/firstmate/docs/voice-relay.md)):

```text
laptop mic --> fm-voice-client.py --SSH--> fm-voice-relay.py --> Bedrock Nova Sonic
                                              --> Firstmate records + fm-inbox.sh queue
```

It does **not** open the Obsidian vault. Step one of three; interrupt and multi-turn context are later upstream.

## Approaches

| Id | Approach | When |
|---|---|---|
| **A** | Reuse Firstmate voice; "tell Alice …" → vault note or Alice JSONL line | First voice milestone |
| **B** | Alice-native relay: same SSH/WARP transport, tools = vault + bus + Alice role | After bus proven |
| **C** | Voice notes on chat (Telegram/WhatsApp audio → STT → chat adapter) | Parallel to chat M1–2 |
| **D** | Realtime WebRTC / phone calling | Last; high scope |

## Milestone A — Hand off via voice

- [ ] Document captain phrases that map to `FLEET_INBOX/alice/events.jsonl` or vault `fleet/inbox/`.
- [ ] Optional: small Firstmate skill or inbox rule when voice queues "for Alice".
- [ ] Phone path: WARP/SSH + existing `fm-voice-client.py` on laptop ([remote-ops.md](../../../docs/remote-ops.md)).

## Milestone B — Alice-native speech

- [ ] Choose STT/TTS: Bedrock Nova (match Firstmate), or `HF_TOKEN` Whisper + TTS vendor.
- [ ] Keys in 1Password Environment `agents-fleet`; AWS profile in `config/voice-*` if reusing relay layout.
- [ ] Spoken output allowlist (mirror Firstmate `voice-read-scope` / deny — no secret readout).
- [ ] Pi session or dedicated relay process with Alice system prompt + pi-obsidian.

## Milestone C — Async voice notes

- [ ] Chat adapter receives `voice` attachment → STT → text pipeline from [chat-channels.md](chat-channels.md).
- [ ] Reply as text or TTS file on channel.

## Milestone D — Realtime (deferred)

- [ ] Cloudflare Realtime or similar; never bind Herdr port publicly.
- [ ] WhatsApp calling only if Meta path already live.

## Operator setup (when implementing)

1. [docs/harness-auth.md](../../../docs/harness-auth.md) + [docs/onepassword.md](../../../docs/onepassword.md)
2. `just alice-op` or mounted `fleet/home/.env` for API keys
3. Phone → laptop: Cloudflare Access + WARP or Tailscale before any audio client

## Out of scope

- Duplicating Firstmate fleet dispatch in a voice extension
- Public audio ports on the captain's Mac
