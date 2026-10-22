# Muster Status

The public status page for Muster, at **https://status.musterchat.com**. It shows whether each part of Muster is working now, a 90-day history per service, and any incidents.

It runs entirely on GitHub, away from Render and the call server, so it keeps working when they don't.

## How it works

- **Checks:** `.github/workflows/check.yml` runs `check.js data --for 55 --save save.sh`: a round of checks every 5 minutes for 55 minutes, pushing the data branch after each. GitHub starts scheduled runs 30–45 minutes apart rather than every 5, so each run keeps checking by itself, and the schedule keeps the next run waiting to start when it ends. The page says so if the last check is over 30 minutes old.
  - Each service is checked from outside, with a quick retry (5 seconds) for a dropped connection.
  - A service is down only when two checks in a row fail: a failed check is checked again a minute later. Fail then fail is down, dated from the first failure. Fail then pass is a blip, shown as working and counted as "slow" for the day. An outage ends at its last failed check.
  - The results go to the `data` branch: `status.json` (now), `daily.json` (per day, 90 days) and `outages.json`.
  - That branch is always a single commit, replaced each run, so the repository doesn't grow.
- **The page:** `docs/` is served by GitHub Pages. It reads the data branch through raw.githubusercontent.com and refreshes every minute. It loads nothing from anywhere else: no trackers, and the fonts are self-hosted.
- **What's checked** (`components.js`):

| Service | Check | Slow above |
| --- | --- | --- |
| Website and app | `https://www.musterchat.com/` answers 200 | 3 s |
| Sign-in and accounts | `/api/health` answers `{"ok":true}` | 3 s |
| Messages | the gateway WebSocket says hello (op 10) | 5 s |
| Voice and video calls | `https://rtc.musterchat.com/` answers 200 | 3 s |
| Desktop app updates | the latest release on `muster-releases` redirects as normal | 5 s |

- **Day colours:**
  - green: no failed checks;
  - amber: any failed check, or 10% of checks slow;
  - red: 2% or more of the day's checks failed (about half an hour);
  - grey: no checks yet.
- **Keepalive:** GitHub switches off scheduled workflows in a public repository after 60 days without activity. `.github/workflows/keepalive.yml` switches them back on once a week.

Email isn't shown yet: it can't be checked from outside without sending mail.

## Setting it up (once)

1. Create the **public** repository `shekelgenerator/muster-status` on GitHub and push this folder to `main`.
2. **Settings → Pages:** Source "Deploy from a branch", branch `main`, folder `/docs`. Then set the custom domain to `status.musterchat.com` and tick **Enforce HTTPS** once it's offered.
3. **Hostinger DNS** for musterchat.com: add a `CNAME` record, name `status`, pointing to `shekelgenerator.github.io`.
4. **Actions:** open the Actions tab, enable workflows if asked, and run **Check Muster** once by hand (Run workflow). That creates the `data` branch, and the page fills in.

## Posting an incident

Add an entry to `docs/incidents.json` and push to `main`; the page shows it within a minute or two. Newest update first:

```json
[
  {
    "title": "Calls not connecting for some people",
    "components": ["calls"],
    "updates": [
      { "at": "2026-10-21T13:48:00Z", "stage": "identified", "text": "The call server ran out of memory. We are restarting it." },
      { "at": "2026-10-21T13:36:00Z", "stage": "investigating", "text": "Some calls are not connecting. We are looking into it." }
    ]
  }
]
```

- **Stages:** `investigating`, `identified` (shown as "Found the cause"), `monitoring` ("Fixed, watching") and `resolved`.
- **Open or past:** an incident stays under **Happening now** until its newest update is `resolved`. It then shows under **The last 14 days**.
- **Automatic outages:** the checks also add outages on their own. When an incident you posted covers the same service and time, only your incident is shown.
- **Component ids:** `website`, `api`, `messages`, `calls`, `desktop`.

## Tests

```
npm test
```

- **What runs:** unit tests for the checks (against local HTTP and WebSocket servers), and the page in a real browser on made-up data.
  - The data covers all working, an outage with an incident, an old check, no data, and text that looks like HTML.
  - The browser tests also check a phone width.
- **Playwright:** the browser part needs Playwright (`NODE_PATH` pointing at an install) and is skipped without it.
- **Screenshots:** set `STATUS_SHOTS=<folder>` to save them.

To see real results locally: `node check.js docs/local-data`, serve `docs/` (for example `npx serve docs`), and open `/?data=local-data/`. That folder is ignored by git.
