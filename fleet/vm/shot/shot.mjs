#!/usr/bin/env node
// shot - screenshots inside a crew VM (R4e): the image's Chromium, driven by playwright-core.
//
// Usage:
//   shot <url-or-file> [...]          desktop (1440x900) and mobile (390x844) of each page
//   shot page.html --mobile --full    one size, the whole page
//
// Options:
//   --desktop | --mobile | --size WxH   which viewport (default: desktop and mobile)
//   --full                              the whole page, not just the viewport
//   --selector CSS                      only that element
//   --dark                              prefers-color-scheme: dark
//   --wait MS                           extra wait after the page settles (default 400)
//   --out DIR                           where PNGs go (default /cache/shots, else ./shots)
//   --name NAME                         file name stem (default: from the page)
//
// Prints each PNG's path, then the page's console errors and failed requests.
// Read a PNG with the read tool to see it; show it to the captain with the
// canvas (kind image, the same path). Network: only the ship's allowlist, so a
// page that needs a CDN the VM cannot reach renders without it (listed under
// failed requests).
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };

function parse(argv) {
  const o = { targets: [], sizes: [], full: false, dark: false, wait: 400, out: existsSync("/cache") ? "/cache/shots" : "shots", name: "", selector: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--desktop" || a === "--mobile") o.sizes.push(a.slice(2));
    else if (a === "--size") {
      const m = /^(\d{2,5})x(\d{2,5})$/.exec(next());
      if (!m) throw new Error("--size takes WxH, for example 1024x768");
      o.sizes.push({ width: Number(m[1]), height: Number(m[2]) });
    } else if (a === "--full") o.full = true;
    else if (a === "--dark") o.dark = true;
    else if (a === "--wait") o.wait = Math.max(0, Number(next()) || 0);
    else if (a === "--out") o.out = next();
    else if (a === "--name") o.name = next().replace(/[^A-Za-z0-9._-]+/g, "-");
    else if (a === "--selector") o.selector = next();
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.targets.push(a);
  }
  if (!o.sizes.length) o.sizes = ["desktop", "mobile"];
  return o;
}

function toUrl(t) {
  if (/^(https?|file|data):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  return pathToFileURL(resolve(t)).href;
}

function stem(url) {
  try {
    const u = new URL(url);
    const s = u.protocol === "file:" ? basename(u.pathname).replace(/\.[a-z0-9]+$/i, "") : `${u.hostname}${u.pathname}`;
    return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "page";
  } catch {
    return "page";
  }
}

// Gondolin answers HTTPS for allowed hosts with its own CA (it checks the real
// certificate on the host side). curl and node trust it through the environment;
// Chromium keeps its own store, so trust exactly that CA's key and nothing else.
function gondolinCaFlags() {
  const ca = process.env.NODE_EXTRA_CA_CERTS || "/etc/gondolin/mitm/ca.crt";
  try {
    const der = new X509Certificate(readFileSync(ca)).publicKey.export({ type: "spki", format: "der" });
    return [`--ignore-certificate-errors-spki-list=${createHash("sha256").update(der).digest("base64")}`];
  } catch {
    return [];
  }
}

const sizeLabel = (s) => (typeof s === "string" ? s : `${s.width}x${s.height}`);

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || !o.targets.length) {
    console.log("usage: shot <url-or-file> [...] [--desktop|--mobile|--size WxH] [--full] [--selector CSS] [--dark] [--wait MS] [--out DIR] [--name NAME]");
    process.exit(o.help ? 0 : 2);
  }
  mkdirSync(o.out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none", ...gondolinCaFlags()],
  });
  let failed = 0;
  try {
    for (const t of o.targets) {
      const url = toUrl(t);
      const name = o.targets.length > 1 || !o.name ? `${o.name ? `${o.name}-` : ""}${stem(url)}` : o.name;
      for (const s of o.sizes) {
        const vp = typeof s === "string" ? SIZES[s] : s;
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: !!vp.isMobile,
          hasTouch: !!vp.hasTouch,
          deviceScaleFactor: 1,
          colorScheme: o.dark ? "dark" : "light",
        });
        const page = await ctx.newPage();
        const errors = [];
        const blocked = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
        page.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 200)));
        page.on("requestfailed", (r) => blocked.push(`${r.url().slice(0, 160)} (${r.failure()?.errorText ?? "failed"})`));
        try {
          try {
            await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
          } catch (e) {
            // A page that keeps polling never goes idle: take what has loaded.
            if (!/Timeout/i.test(String(e))) throw e;
            errors.push("network did not go idle within 20 s; captured what had loaded");
          }
          await page.evaluate(() => document.fonts?.ready).catch(() => {});
          if (o.wait) await page.waitForTimeout(o.wait);
          const file = resolve(o.out, `${name}-${o.dark ? "dark-" : ""}${sizeLabel(s)}.png`);
          if (o.selector) await page.locator(o.selector).first().screenshot({ path: file, timeout: 10_000 });
          else await page.screenshot({ path: file, fullPage: o.full });
          console.log(file);
        } catch (e) {
          failed++;
          console.log(`FAILED ${url} at ${sizeLabel(s)}: ${String(e?.message ?? e).split("\n")[0]}`);
        }
        for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  console error: ${e}`);
        for (const b of [...new Set(blocked)].slice(0, 10)) console.log(`  failed request: ${b}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`shot: ${e?.message ?? e}`);
  process.exit(2);
});
