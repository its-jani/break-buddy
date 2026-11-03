/**
 * BreakBuddy — Background service worker (Manifest V3)
 * Owns the break schedule via chrome.alarms and broadcasts break triggers
 * to every tab across every browser window.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EYE_BREAK_ALARM = 'eyeBreakAlarm';
const LONG_BREAK_ALARM = 'longBreakAlarm';

/** Break durations (seconds) fired when an alarm is due. */
const EYE_BREAK_DURATION = 20; // 20-second eye rest (20-20-20 rule)
const LONG_BREAK_DURATION = 300; // 5-minute movement / creative break

const BREAK_TYPES = {
  eye: 'eye',
  long: 'long',
};

const DEFAULT_SETTINGS = {
  eyeBreakInterval: 20, // minutes between eye breaks
  longBreakInterval: 60, // minutes between long breaks
  selectedCharacter: 'cat', // 'cat' | 'dog' | 'superhero'
};

// ---------------------------------------------------------------------------
// Alarm scheduling
// ---------------------------------------------------------------------------

/**
 * (Re)create the repeating break alarms from the given settings.
 * @param {{eyeBreakInterval:number,longBreakInterval:number}} settings
 */
async function scheduleAlarms(settings) {
  await chrome.alarms.clearAll();

  const eyeMinutes = Math.max(1, Number(settings.eyeBreakInterval) || DEFAULT_SETTINGS.eyeBreakInterval);
  const longMinutes = Math.max(1, Number(settings.longBreakInterval) || DEFAULT_SETTINGS.longBreakInterval);

  chrome.alarms.create(EYE_BREAK_ALARM, { periodInMinutes: eyeMinutes });
  chrome.alarms.create(LONG_BREAK_ALARM, { periodInMinutes: longMinutes });

  console.info(
    `[BreakBuddy] alarms scheduled — eye break every ${eyeMinutes} min, long break every ${longMinutes} min`
  );
}

// ---------------------------------------------------------------------------
// Break trigger
// ---------------------------------------------------------------------------

/**
 * Fire a break of the given type across all windows.
 * @param {'eye'|'long'} breakType
 * @param {number} durationSeconds
 */
function triggerBreak(breakType, durationSeconds) {
  console.info(`[BreakBuddy] ${breakType} break due (${durationSeconds}s)`);
  broadcastBreak(breakType, durationSeconds);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case EYE_BREAK_ALARM:
      triggerBreak(BREAK_TYPES.eye, EYE_BREAK_DURATION);
      break;
    case LONG_BREAK_ALARM:
      triggerBreak(BREAK_TYPES.long, LONG_BREAK_DURATION);
      break;
    default:
      // Snooze / ad-hoc alarms fire their stored break once.
      handleScheduledBreakAlarm(alarm);
      break;
  }
});

// ---------------------------------------------------------------------------
// Multi-window broadcasting & messaging
// ---------------------------------------------------------------------------

/** Internal pages (chrome://, edge://, web store, ...) cannot host content scripts. */
const UNSUPPORTED_URL = /^(chrome|edge|chrome-extension|edge-extension|about|devtools|view-source|chrome-search):/;

/**
 * Broadcast a TRIGGER_BREAK message to every tab in every window.
 * Injects the content script on demand for tabs that predate installation
 * or live on pages where content scripts cannot be declared.
 * @param {'eye'|'long'} breakType
 * @param {number} durationSeconds
 * @param {string} [characterTheme]
 */
async function broadcastBreak(breakType, durationSeconds, characterTheme) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const theme = characterTheme || settings.selectedCharacter;

  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((tab) => tab.id !== undefined && tab.url && !UNSUPPORTED_URL.test(tab.url));

  const message = { type: 'TRIGGER_BREAK', breakType, durationSeconds, characterTheme: theme };

  const deliveries = targets.map(async (tab) => {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // No content script yet — try to inject one, then retry once.
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/overlay.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scripts/content.js'] });
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // Tab is not scriptable (privileged page, discarded tab, etc.) — skip quietly.
      }
    }
  });

  await Promise.allSettled(deliveries);
  console.info(`[BreakBuddy] broadcast ${breakType} break to ${targets.length} tab(s)`);
}

/**
 * Reset the repeating schedule from persisted settings and notify open tabs
 * so their countdown displays reflect the new cadence.
 * @param {object} newSettings
 */
async function applySettingsUpdate(newSettings) {
  const merged = { ...DEFAULT_SETTINGS, ...newSettings };
  await chrome.storage.local.set(merged);
  await scheduleAlarms(merged);

  // Best-effort ping so popups/tabs can refresh their state.
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: merged }).catch(() => {
    /* no receiver — fine */
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'UPDATE_SETTINGS':
      applySettingsUpdate(message.settings ?? {}).then(() => sendResponse({ ok: true }));
      return true; // keep the message channel open for the async response

    case 'SNOOZE': {
      // Delay the current break by 5 minutes, then fire it once.
      const snoozeMinutes = Math.max(1, Number(message.minutes) || 5);
      const breakType = message.breakType === BREAK_TYPES.long ? BREAK_TYPES.long : BREAK_TYPES.eye;
      const duration = breakType === BREAK_TYPES.long ? LONG_BREAK_DURATION : EYE_BREAK_DURATION;

      chrome.alarms.create(`snooze:${breakType}`, { delayInMinutes: snoozeMinutes });
      // Push the dismissal back to the tab that requested the snooze.
      sendResponse({ ok: true, snoozeMinutes });
      // Remember what to re-fire when the snooze alarm rings.
      chrome.storage.session.set({ [`pendingSnooze:${breakType}`]: { breakType, durationSeconds: duration } });
      return false;
    }

    default:
      return false;
  }
});

/** Handle one-shot snooze alarms created by SNOOZE requests. */
async function handleScheduledBreakAlarm(alarm) {
  const match = /^snooze:(eye|long)$/.exec(alarm.name);
  if (!match) return;

  const key = `pendingSnooze:${match[1]}`;
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key] || { breakType: match[1], durationSeconds: EYE_BREAK_DURATION };
  await chrome.storage.session.remove(key);

  broadcastBreak(pending.breakType, pending.durationSeconds);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  // Populate default settings on first install (do not overwrite user values).
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(stored);

  await scheduleAlarms(stored);
  console.info('[BreakBuddy] installed — defaults populated and alarms scheduled');
});

chrome.runtime.onStartup.addListener(async () => {
  // Service worker restart safety net: make sure alarms still exist.
  const existing = await chrome.alarms.getAll();
  if (existing.length === 0) {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    await scheduleAlarms(settings);
  }
});
