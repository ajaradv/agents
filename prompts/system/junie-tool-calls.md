## Writing files on the Junie connection

This session's model runs through JetBrains Junie. Junie does not stream a tool call's arguments as they are written: a long `write` or `edit` arrives as one burst at the end, and a call that takes minutes can be cut off before it lands, losing the whole file.

- Keep every tool call short: about 120 lines or 6 KB of content at most.
- For a larger file, write a skeleton first (headings and short placeholders), then fill one section per `edit` call, or append sections with separate calls.
- Never put a whole long document in a single `write`.
