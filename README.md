# BreakBuddy

**Rest your eyes. Move your body.**

BreakBuddy is a Manifest V3 Chrome extension that enforces the [20-20-20 eye rest rule](https://www.aao.org/eye-health/tips-prevention/should-you-follow-20-20-20-rule)
and regular movement breaks — with a friendly full-screen buddy instead of a nagging notification.

When a break comes due, every tab in every browser window is covered by a full-screen overlay showing an
animated character, the break instructions, and a live countdown. You can snooze the break by five minutes,
skip it, or just let the countdown run out and get back to work.

---

## Features

| | |
|---|---|
| 👀 **Eye Rest Break** | 20-second overlay every 20 minutes: *look at something 20 feet (about 6 meters) away.* |
| 🏃 **Move & Create Break** | 5-minute overlay every hour: *stand up, stretch, grab some water.* |
| ⏰ **Custom break profiles** | Create unlimited profiles — name, interval, duration (secs or mins), and character. |
| ⚡ **Take a break now** | Fire any preset or custom break on demand from the popup, without waiting for its timer. |
| 🐱 **Character buddies** | Cat, Dog, or Superhero walking animation, chosen per break profile. |
| 🖥️ **All windows, all tabs** | One alarm in the service worker broadcasts the overlay everywhere at once. |
| 🔕 **Snooze & skip** | Snooze the exact break for 5 minutes, or dismiss it immediately. |
| 🛡️ **Isolated overlay** | Shadow DOM isolation + max `z-index`, so page CSS can't bleed in or fight the break. |
| 🧰 **Pause per profile** | Toggle any custom break on or off without deleting its settings. |

Defaults are conservative and fully editable; intervals are clamped to sane ranges (1–180 min for eye breaks,
1–240 min for long breaks, 1–600 min for custom intervals).

---

## Install

No build step, no dependencies, no `npm install` — it is a plain unpacked extension.

1. Clone or download this repository:
   ```powershell
   git clone https://github.com/<your-username>/break-buddy.git
   ```
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `break-buddy` folder (the one containing `manifest.json`).
5. Pin **BreakBuddy** to the toolbar, then click it to open the settings popup.

> **Tip:** to test the overlay immediately, open the popup and click **⚡ Take Break Now** on any timer.

---

## Use

### Default timers

The **Default Timers** tab holds the two built-in profiles:

- **Eye Rest Break** — interval in minutes, duration in seconds.
- **Long Break** — interval in minutes, duration in minutes.
- **Default Character Theme** — used by both presets and as the fallback for custom breaks.

Click **Save Settings** and the schedule is rebuilt immediately; the next break lands according to the new
intervals. **⚡ Take Break Now** triggers that profile across all windows right away.

### Custom breaks

The **Custom Breaks** tab is a full CRUD manager:

- **＋ Add Custom Break** — name, interval, duration (`secs` / `mins`), and character theme.
- **⚡** on a row — fire that break immediately.
- **✎ / 🗑** — edit or delete the profile.
- The switch on each row pauses or resumes that profile without losing it.

### During a break

| Control | Behaviour |
|---|---|
| **Snooze (5m)** | Tears down the overlay now and re-fires *this exact break* five minutes later (including its custom title and character). |
| **Skip Break** | Dismisses the overlay only; the profile's normal schedule is untouched. |
| *Countdown hits `00:00`* | Overlay removes itself and unlocks the page. |

---

## Project layout

```
break-buddy/
├── manifest.json           # MV3 manifest: worker, popup, content script, resources
├── background.js           # Service worker — alarm engine, profile model, broadcaster
├── popup/
│   ├── popup.html          # Settings UI (tabs, forms, custom-break modal)
│   ├── popup.css           # Popup styling
│   └── popup.js            # Preset + custom break CRUD, manual triggers, resync
├── scripts/
│   └── content.js          # Injects the Shadow DOM break overlay on every page
├── styles/
│   └── overlay.css         # Page-level lock while a break is active
└── assets/
    ├── icon.png            # Toolbar / extension icon (128px)
    ├── cat_walk.webm       # Character walking animations
    ├── dog_walk.webm
    └── superhero_walk.webm
```

## Architecture

Three cooperating pieces, all talking through `chrome.runtime` messaging plus shared storage:

**1. `background.js` — the scheduler (single source of truth).**
`getBreakProfiles()` merges the two presets with every enabled custom profile from `chrome.storage.local`.
`scheduleAllBreaks()` clears all alarms and creates one periodic `chrome.alarms` timer per enabled profile
(named `break_alarm_<id>`). When an alarm fires, the worker resolves the profile by id and broadcasts
`TRIGGER_BREAK` to every scriptable tab in every window; if a tab has no content script yet it injects
`scripts/content.js` + `styles/overlay.css` via `chrome.scripting` and retries once. Privileged pages are
filtered out and failures are skipped quietly. It also handles one-shot `snooze:<id>` alarms whose payloads sit
in `chrome.storage.session`, and repopulates defaults on install. A `chrome.runtime.onStartup` check re-seeds
the schedule if the worker woke to find no alarms — the standard MV3 service-worker-restart safety net.

**2. `popup/popup.js` — the editor.**
Reads and writes the same storage keys, then asks the worker to rebuild the alarm schedule with
`UPDATE_ALL_BREAKS` so the schedule can never drift from the settings. Manual triggers send
`TRIGGER_MANUAL_BREAK` with a resolved profile descriptor.

**3. `scripts/content.js` — the presenter.**
Listens for `TRIGGER_BREAK`, builds the overlay inside an attached Shadow Root (`#break-buddy-root`,
`z-index: 2147483647`, `pointer-events: auto`) so host-page styles can't reach it and its own rules can't
leak out, loads `assets/<character>_walk.webm` into the stage, ticks the countdown once per second, and
self-dismisses at zero. `styles/overlay.css` adds `html.break-buddy-active`, which locks page scrolling and
text selection underneath. A guard flag prevents double injection, and the static emoji is a graceful
fallback if a WebM is missing or unsupported.

### Messaging protocol

| Type | From → To | Purpose |
|---|---|---|
| `TRIGGER_BREAK` | worker → content script | Show the overlay (`breakType`, `durationSeconds`, `characterTheme`, optional `title` / `instructions` / `profileId`). |
| `UPDATE_ALL_BREAKS` | popup → worker | Rebuild every alarm from persisted storage. |
| `UPDATE_SETTINGS` | *any* → worker | Apply a partial settings patch and reschedule. |
| `TRIGGER_MANUAL_BREAK` | popup → worker | Fire a resolved profile descriptor immediately. |
| `SNOOZE` | content script → worker | Schedule a one-shot `snooze:<id>` alarm and persist its descriptor in session storage. |

### Data model

Everything lives in `chrome.storage.local`:

| Key | Default | Meaning |
|---|---|---|
| `eyeBreakInterval` | `20` | Minutes between eye breaks. |
| `eyeBreakDuration` | `20` | Seconds the eye overlay lasts. |
| `longBreakInterval` | `60` | Minutes between long breaks. |
| `longBreakDuration` | `300` | Seconds the long overlay lasts (stored in seconds, edited in minutes). |
| `selectedCharacter` | `'cat'` | `cat` \| `dog` \| `superhero`. |
| `customBreaks` | `[]` | Array of `{ id, name, intervalMinutes, durationSeconds, character, enabled }`. |

`chrome.storage.session` holds short-lived `pendingSnooze:<id>` descriptors so a snoozed break can re-fire
with its own title, duration, and character.

---

## Privacy & permissions

BreakBuddy runs entirely offline. There is no analytics, no remote code, and no network request — nothing
you do on a page is read, collected, or transmitted anywhere.

| Permission | Why it is needed |
|---|---|
| `alarms` | Schedules the break timers; survives browser restarts and service-worker sleep. |
| `storage` | Persists settings and custom break profiles. |
| `tabs` | Enumerates tabs across all windows to broadcast the overlay. |
| `scripting` | Injects the overlay on demand into tabs that have no content script yet (e.g. tabs opened before install), then retries the trigger once. |
| `<all_urls>` (host) | The break overlay must be able to appear on any page you are working on. |

## Known limitations

- **Internal pages can't be covered.** Browsers forbid content scripts on `chrome://`, `edge://`,
  `devtools://`, the Web Store, and similar pages. A break that comes due while you are only on such pages
  will not be visible there (it still fires in every normal tab).
- **Placeholder character animations.** The `*_walk.webm` files in `assets/` are tiny placeholders, so the
  overlay currently falls back to the static emoji. Drop real transparent WebM walking loops named
  `cat_walk.webm`, `dog_walk.webm`, and `superhero_walk.webm` into `assets/` to light up the buddy animation.
- **Chrome only.** Tested as a Chromium MV3 extension; it has not been validated on Firefox or Safari.
- Only a single 128px icon is supplied; Chrome scales it for the other sizes.

## Development

- Load the folder unpacked and hit **Reload** on `chrome://extensions` after each edit.
- Service-worker logs (`[BreakBuddy] …`) appear in the *Inspect views → service worker* console — useful for
  confirming how many alarms were scheduled and which break fired.
- Layout conventions worth keeping: the overlay markup and its CSS live *inside* `content.js`'s Shadow Root
  (so there is no separate overlay stylesheet to fetch), while `styles/overlay.css` is reserved for rules that
  must apply to the host document.
- This repo follows Conventional Commits with milestone-sized, atomic commits.

## Version

**v1.1.0** — adds custom break profiles, on-demand break triggers, and dynamic multi-alarm rescheduling on top
of the v1.0.0 20-20-20 core.
