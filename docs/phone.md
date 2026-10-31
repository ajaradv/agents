# The fleet on your phone (D6)

The dashboard installs as an app on your phone and sends a push notification
whenever something lands in **Needs you**: a question, a Go request, a done /
blocked / decision / milestone notice, an order waiting for you, a hold, or a
message that did not go through. Memory proposals (things you said that Jev
thinks are worth remembering) arrive as one notification that says how many
are open, not one each. Tapping the notification opens Needs you.

## How it is reached

The dashboard listens on `127.0.0.1` only. **Tailscale Serve** shares it on
your tailnet at `https://<this-mac>.<tailnet>.ts.net`, with a real HTTPS
certificate (needed for install and push). Only devices signed in to your
tailnet can open it; it is never on the internet (that would be Funnel, which
`bin/fleet-phone` never turns on). Requests through Serve carry your Tailscale
login; set `FLEET_TAILNET_USERS=you@example.com` (then re-run
`bin/fleet-services install`) to admit only that login.

## Set up (once)

1. Install Tailscale on the Mac (https://tailscale.com/download/mac) and on the
   phone (App Store / Play Store); sign in to the same account on both.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS
   certificates** (DNS page).
3. On the Mac: `bin/fleet-phone on`. It prints the address.
4. On the phone, open `https://<address>/needs`:
   - iPhone (iOS 16.4+): Safari, Share, **Add to Home Screen**, then open
     **Fleet** from the home screen (push works only from the installed app).
   - Android: Chrome, menu, **Install app**.
5. In the app, open Needs you and tap **Notify this device**; allow
   notifications. A test notification arrives ("Notifications are on for this
   device, Captain.").

## Day to day

- **Snooze** holds phone notifications too; **Wake** compiles what was held
  into the digest.
- Tap **Notifying this device** to turn it off for that device.
- The laptop must be awake and on the network: the fleet still runs there
  (an always-on host is R5).
- `bin/fleet-phone status` shows what is shared; `bin/fleet-phone off` stops it.

## Where things live

- `dashboard/public/manifest.webmanifest`, `sw.js`, `icons/`: the app shell.
- `dashboard/lib/push.ts`: VAPID keys (`fleet/inbox/.node/vapid.json`),
  device subscriptions and what was pushed (journal database).
- `dashboard/lib/request-guard.ts`: admits the tailnet name only with
  Tailscale Serve's identity header.
