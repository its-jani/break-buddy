# BreakBuddy

**Rest your eyes. Move your body.**

BreakBuddy is a Manifest V3 Chrome extension that enforces the [20-20-20 eye rest rule](https://www.aao.org/eye-health/tips-prevention/should-you-follow-20-20-20-rule)
and regular movement breaks — with a walk-in buddy instead of a nagging notification.

When a break comes due, a fully transparent layer covers every tab in every browser window: your page stays
completely visible, while a character walks in from off-screen and settles along the bottom edge next to a small
floating card with the instructions, a live countdown, and snooze / skip controls. Clicks are swallowed for the
whole break, so you cannot accidentally work through it.

---

## Features

| | |
|---|---|
| 👀 **Eye Rest Break** | 20-second break every 20 minutes: *look at something 20 feet (about 6 meters) away.* |
| 🏃 **Move & Create Break** | 5-minute break every hour: *stand up, stretch, grab some water.* |
| 🫥 **Transparent layer** | No dimming, tint, or blur — the page underneath stays fully visible. |
| 🚶 **Walk-in entrance** | The buddy slides in from outside the viewport over 2.5 s and settles at the bottom edge. |
| 🏷️ **Floating badge** | Countdown, snooze and skip live in one small card beside the buddy, not over your content. |
| ⏰ **Custom break profiles** | Create unlimited profiles — name, interval, duration (secs or mins), and character. |
| ⚡ **Take a break now** | Fire any preset or custom break on demand from the popup, without waiting for its timer. |
| 🐱 **Character buddies** | Two cat walk cycles (`Cat Walk 1` / `Cat Walk 2`), chosen per break profile. |
| 🖥️ **All windows, all tabs** | One alarm in the service worker broadcasts the overlay everywhere at once. |
| 🔕 **Snooze & skip** | Snooze the exact break for 5 minutes, or dismiss it immediately. |
| 🛡️ **Isolated, non-blocking UI** | Shadow DOM isolation + max `z-index`; the page is never reflowed or scrolled by a break. |
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
| **Snooze (5m)** | Tears down the layer now and re-fires *this exact break* five minutes later (including its custom title and character). |
| **Skip Break** | Dismisses the layer only; the profile's normal schedule is untouched. |
| *Countdown hits `00:00`* | The layer removes itself and the page becomes clickable again. |

While a break is active, clicks, wheel and touch input are absorbed by an invisible blocker, so the page cannot
be interacted with — but nothing about its appearance changes.

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
│   └── content.js          # Injects the transparent Shadow DOM break layer
├── styles/
│   └── overlay.css         # Page-level rules while a break is active
└── assets/
    ├── cat1_walk.webm      # Character walk clips (1280x720, ~10 s loop)
    ├── cat2_walk.webm
    └── icon.png            # Toolbar / extension icon (128px)
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
Listens for `TRIGGER_BREAK` and builds the layer inside an attached Shadow Root (`#break-buddy-root`,
`z-index: 2147483647`, `pointer-events: none`) so host-page styles can't reach it and its own rules can't
leak out. The host paints nothing: a `.bb-blocker` child re-enables `pointer-events` to swallow clicks on an
invisible full-viewport surface, and a `.bb-dock` row along the bottom holds the character tile (`.bb-stage`,
which walks in via `@keyframes bb-walk-in` from `translateX(-100vw)`) beside the floating badge (`.bb-card`).
`assets/<character>_walk.webm` is loaded into the tile and loops in place for the whole break; the static emoji
is a graceful fallback if the WebM is missing or unsupported. The countdown ticks once per second and the layer
dismisses itself at zero. A guard flag prevents double injection, and if the extension has been reloaded the
script detects the dead context, steps aside, and lets a fresh copy re-attach. `styles/overlay.css` only stops
text selection underneath — deliberately **no** scroll lock, because toggling `overflow` would reflow the page
the moment the break ends.

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
| `selectedCharacter` | `'cat1'` | `cat1` \| `cat2`. Values from older builds (`cat`, `dog`, `superhero`) fall back to `cat1`. |
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
| `<all_urls>` (host) | The break layer must be able to appear on any page you are working on. |

## Known limitations

- **The walk clips are not transparent.** `assets/cat1_walk.webm` and `assets/cat2_walk.webm` are
  `VP9 / 1280x720 / yuv420p` — the pixel format carries **no alpha channel**, so the clips have an opaque black
  background. They are therefore presented inside a small contained tile (`border-radius`, border, shadow) rather
  than floated over the page, which would otherwise paint a black rectangle across the viewport. Re-export the
  walks from the original green-screen source with an alpha plane (`VP9` + `yuva420p`) and the tile framing can be
  dropped in one CSS change.
- **Only two buddies.** The dog and superhero themes were retired when their assets were removed; anything saved
  with those values renders as `cat1`.
- **Internal pages can't be covered.** Browsers forbid content scripts on `chrome://`, `edge://`,
  `devtools://`, the Web Store, and similar pages. A break that comes due while you are only on such pages
  will not be visible there (it still fires in every normal tab).
- **Chrome only.** Tested as a Chromium MV3 extension; it has not been validated on Firefox or Safari.
- Only a single 128px icon is supplied; Chrome scales it for the other sizes.

## Development

- Load the folder unpacked and hit **Reload** on `chrome://extensions` after each edit.
- Service-worker logs (`[BreakBuddy] …`) appear in the *Inspect views → service worker* console — useful for
  confirming how many alarms were scheduled and which break fired.
- Layout conventions worth keeping: the layer markup and its CSS live *inside* `content.js`'s Shadow Root
  (so there is no separate overlay stylesheet to fetch), while `styles/overlay.css` is reserved for rules that
  must apply to the host document.
- This repo follows Conventional Commits with milestone-sized, atomic commits.

### Manual test checklist

Set an eye-break interval to `1` minute (or use **⚡ Take Break Now**) and confirm:

1. The page behind the buddy is fully readable — no dimming, no blur, no scroll jump.
2. The tile walks in from the left edge over ~2.5 s and settles at the bottom.
3. Clicking links, buttons, and text on the page does nothing, but wheel/scroll input is also absorbed.
4. The badge appears beside the buddy only after it lands, and its buttons still work.
5. **Snooze (5m)** shows "Snoozed 5 minutes." and re-fires the same break five minutes later.
6. **Skip Break** dismisses instantly; letting the countdown reach `00:00` dismisses on its own.
7. Open a second window — the break must appear in both, at the same moment.
8. Reload the extension, then trigger a break in a tab that was already open — it should still work (the
   background re-injects the content script on demand).

## Version

**v1.2.0** — transparent break layer with a walk-in character tile and a floating badge, real cat walk assets,
and a two-buddy roster (`cat1` / `cat2`). Builds on v1.1.0 (custom break profiles, on-demand triggers,
multi-alarm rescheduling) and v1.0.0 (the 20-20-20 core).
