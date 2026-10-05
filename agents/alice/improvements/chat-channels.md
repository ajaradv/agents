# Alice: phone chat channels

Goal: message Alice from a phone; she triages vault + fleet bus and replies on the same channel.

## Adapter shape

```text
phone --> channel API --> inbound adapter --> FLEET_INBOX/alice/events.jsonl
                                              (or vault fleet/inbox/*.md note)
Alice session or wake daemon --> reply adapter --> channel API --> phone
```

Each inbound message should:

1. Verify captain identity (allowlist user id / phone / email).
2. Append a JSONL line or vault note Alice already reads at session start.
3. Trigger a wake (launchd, `fswatch`, or periodic Pi headless turn) if Alice is not interactive.

Replies must respect Alice authority: no merge, force-push, secrets, retire-home.

## Channel comparison

| Channel | Fit | Friction | Notes |
|---|---|---|---|
| **Telegram Bot** | Best first prototype | Free; BotFather token in 1Password | Webhook on Cloudflare Worker + Tunnel, or long-poll on Mac |
| **Email → Alice** | Fastest reuse of mail ideas | IMAP/SMTP | Firstmate `fm-mail.sh` wakes **Firstmate**, not Alice — use dedicated alias → Alice JSONL |
| **Discord DM** (own bot) | Good if you live in Discord | Bot token | Not the same as Firstmate Relay (`FMX_PAIRING_TOKEN` / myfirstmate.io) |
| **Firstmate Relay (X/Discord)** | Wrong default brain | Already built | Public mentions steer **Firstmate**, not vault triage |
| **Slack** | Work phone UI | App + socket mode | Adapter + wake |
| **WhatsApp Cloud API** | Official WhatsApp | Business verification, 24h window | `WHATSAPP_*` in vault Fleet; webhook to Worker, not Herdr |
| **Twilio WhatsApp** | Same UX, easier sandbox | Per-message cost | Same adapter shape |
| **Unofficial WhatsApp** | — | **Reject** | ToS / ban risk |
| **Signal** (`signal-cli`) | Privacy | Linked device ops | Later |
| **iMessage** | Native iPhone | Mac always on | Fragile; defer |
| **SMS (Twilio)** | Fallback | Per segment | Plain text only |

## Recommended sequence

### Milestone 1 — Bus proof

- [ ] Inbound script appends to `FLEET_INBOX/alice/events.jsonl` with `from: phone`, `kind: message`, `summary`.
- [ ] Manual or scheduled `just alice` / headless Pi reads bus and writes `FLEET_INBOX/firstmate/events.jsonl` or vault note.
- [ ] Document captain allowlist format.

### Milestone 2 — Telegram (or email)

- [ ] Bot token in 1Password; webhook Worker validates Telegram signature.
- [ ] Outbound `sendMessage` from adapter reading Alice's last reply artifact (file or JSONL ack line).
- [ ] Rate limit and max message length.

### Milestone 3 — WhatsApp (optional)

- [ ] Meta Cloud API or Twilio sandbox → production number.
- [ ] Template messages for outside 24h window if needed.

## Security

- Never log message bodies with secrets.
- Webhook endpoints: Cloudflare Access or verify provider signatures only.
- Do not expose SSH or Herdr on the same hostname as chat webhooks.

## Secrets (1Password)

Add when implementing (names only in git until then):

- `TELEGRAM_BOT_TOKEN`
- `WHATSAPP_TOKEN` / Meta app secret (WhatsApp path)
- Optional: dedicated IMAP/SMTP for Alice-only alias
