# Fleet memory

Where each kind of thing is kept (Alice's role, `roles/alice.md`, **Memory**): a value that changes is a fact
(`fact_set`, read with `fact_get`), a standing preference is a line in the captain profile (`remember`), a passing
thing worth checking later is an observation (`log_observation`, expires on its own), and everything else is a
vault note.

## Fact naming

Name facts the same way every time, so a value has one place and `fact_get` finds it.

- **Subject**: a lowercase noun for one thing, as it is called in the fleet: `hub`, `laptop`, `old-macbook`,
  `alice` (or any agent id), `fleet` (fleet-wide policy), a ship id (`kinwork`). Not `fleet-hub` for `hub`; check
  `fact_get` for the subject before inventing one.
- **Key**: a snake_case attribute of that thing: `host`, `model`, `os`, `owner`, `since`.
- **One value per key.** A new value supersedes the old one and the old stays in the history; do not encode a
  second value in the key (`model_old`).
- **No events as facts.** "The hub moved to exe.dev on 10-14" is a vault note or an observation; the fact is
  `hub` `host` = `exe.dev`, with that date in the source.
