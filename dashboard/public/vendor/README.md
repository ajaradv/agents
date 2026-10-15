# Vendored front-end libraries

Served by the dashboard itself so the page never waits on a CDN (and works
offline, on the phone over Tailscale, and in the PWA). Same bytes the page
loaded from the CDNs before.

| File | Source | License | Check |
|---|---|---|---|
| `htmx-4.0.0.min.js` | https://cdn.jsdelivr.net/npm/htmx.org@4.0.0 | 0BSD | sha384-BvJpBiO8Kh31EqtJe5DRIeWrHWnCGkwytKs9NKFi86Hhw96dEqdEMzZDeK9iEGTc (the page keeps this as its `integrity`) |
| `alpinejs-3.14.3.min.js` | https://unpkg.com/alpinejs@3.14.3/dist/cdn.min.js | MIT | sha256 689f513978d11d69f4d33794f7296c9a586a2e55de79bb447cddbc3f474f9f07 (identical on jsdelivr) |

To upgrade: download the new version, check it, replace the file, and
update the `<script>` tags in `index.html`.
