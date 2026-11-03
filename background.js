/**
 * BreakBuddy — Background service worker (Manifest V3)
 * Owns the break schedule via chrome.alarms and broadcasts break triggers
 * to every tab across every browser window.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Built-in profile ids (stable alarm-name suffixes).
const EYE_BREAK_ID = 'eye';
const LONG_BREAK_ID = 'long';

/** Prefix for every dynamically scheduled break alarm. */
const BREAK_ALARM_PREFIX = 'break_alarm_';

/** Default overlay durations (seconds) — user-customisable via settings. */
const EYE_BREAK_DURATION = 20; // 20-second eye rest (20-20-20 rule)
const LONG_BREAK_DURATION = 300; // 5-minute movement / creative break

const BREAK_TYPES = {
  eye: 'eye',
  long: 'long',
  custom: 'custom',
};

const DEFAULT_SETTINGS = {
  eyeBreakInterval: 20, // minutes between eye breaks
  eyeBreakDuration: EYE_BREAK_DURATION, // seconds the eye overlay lasts
  longBreakInterval: 60, // minutes between long breaks
  longBreakDuration: LONG_BREAK_DURATION, // seconds the long overlay lasts
  selectedCharacter: 'cat', // 'cat' | 'dog' | 'superhero'
};

// Shape of a stored custom break profile:
// { id, name, intervalMinutes, durationSeconds, character, enabled }
const DEFAULT_CUSTOM_BREAKS = [];

/** Storage keys used across the app. */
const STORAGE_KEYS = { ...DEFAULT_SETTINGS, customBreaks: DEFAULT_CUSTOM_BREAKS };

// ---------------------------------------------------------------------------
// Break profile model
// ---------------------------------------------------------------------------

/**
 * Build the complete list of break profiles — the two built-in presets plus
 * every user-created custom break — resolved from persisted storage. This is
 * the single source of truth for scheduling, alarm firing, and manual triggers.
 */
async function getBreakProfiles() {
  const data = await chrome.storage.local.get(STORAGE_KEYS);

  const presets = [
    {
      id: EYE_BREAK_ID,
      breakType: BREAK_TYPES.eye,
      name: 'Eye Rest Break',
      intervalMinutes: data.eyeBreakInterval,
      durationSeconds: data.eyeBreakDuration,
      character: data.selectedCharacter,
      enabled: true,
    },
    {
      id: LONG_BREAK_ID,
      breakType: BREAK_TYPES.long,
      name: 'Move & Create Break',
      intervalMinutes: data.longBreakInterval,
      durationSeconds: data.longBreakDuration,
      character: data.selectedCharacter,
      enabled: true,
    },
  ];

  const customs = (Array.isArray(data.customBreaks) ? data.customBreaks : []).map((cb) => ({
    id: cb.id,
    breakType: BREAK_TYPES.custom,
    name: cb.name || 'Custom Break',
    intervalMinutes: cb.intervalMinutes,
    durationSeconds: cb.durationSeconds,
    character: cb.character || data.selectedCharacter,
    enabled: cb.enabled !== false,
  }));

  return [...presets, ...customs];
}

/** Resolve a single profile by id, or null if it no longer exists. */
async function findBreakProfile(id) {
  const profiles = await getBreakProfiles();
  return profiles.find((profile) => profile.id === id) || null;
}

// ---------------------------------------------------------------------------
// Alarm scheduling
// ---------------------------------------------------------------------------

/**
 * Clear and (re)create repeating alarms for every enabled profile. Supports an
 * arbitrary number of concurrent custom timers, each on its own schedule.
 */
async function scheduleAllBreaks() {
  await chrome.alarms.clearAll();

  const profiles = await getBreakProfiles();
  let scheduled = 0;

  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const minutes = Math.max(1, Number(profile.intervalMinutes) || 1);
    chrome.alarms.create(`${BREAK_ALARM_PREFIX}${profile.id}`, { periodInMinutes: minutes });
    scheduled += 1;
  }

  console.info(`[BreakBuddy] ${scheduled} break alarm(s) scheduled`);
}

// ---------------------------------------------------------------------------
// Alarm firing
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(BREAK_ALARM_PREFIX)) {
    const id = alarm.name.slice(BREAK_ALARM_PREFIX.length);
    dispatchBreakById(id);
  } else {
    // Snooze / ad-hoc one-shot alarms fire their stored break once.
    handleScheduledBreakAlarm(alarm);
  }
});

/** Resolve a profile by id and broadcast its break across all windows. */
async function dispatchBreakById(id) {
  const profile = await findBreakProfile(id);
  if (!profile) return; // profile was deleted before the alarm fired
  console.info(`[BreakBuddy] "${profile.name}" break due (${profile.durationSeconds}s)`);
  broadcastProfile(profile);
}

// ---------------------------------------------------------------------------
// Multi-window broadcasting & messaging
// ---------------------------------------------------------------------------

/** Internal pages (chrome://, edge://, web store, ...) cannot host content scripts. */
const UNSUPPORTED_URL = /^(chrome|edge|chrome-extension|edge-extension|about|devtools|view-source|chrome-search):/;

/** Fallback subtitle for custom breaks that have no bespoke copy. */
const CUSTOM_BREAK_INSTRUCTIONS = 'Pause, reset, and come back fresher — this break is just for you.';

/**
 * Broadcast a resolved break profile (preset or custom) to every window.
 * Custom profiles carry their own title/instructions; presets let the content
 * script fall back to its built-in copy.
 * @param {object} profile
 */
function broadcastProfile(profile) {
  const isCustom = profile.breakType === BREAK_TYPES.custom;
  return broadcastBreak(profile.breakType, profile.durationSeconds, profile.character || profile.characterTheme, {
    profileId: profile.id,
    title: isCustom ? profile.name : undefined,
    instructions: isCustom ? profile.instructions || CUSTOM_BREAK_INSTRUCTIONS : undefined,
  });
}

/**
 * Broadcast a TRIGGER_BREAK message to every tab in every window.
 * Injects the content script on demand for tabs that predate installation
 * or live on pages where content scripts cannot be declared.
 * @param {'eye'|'long'|'custom'} breakType
 * @param {number} durationSeconds
 * @param {string} [characterTheme]
 * @param {{profileId?: string, title?: string, instructions?: string}} [options]
 */
async function broadcastBreak(breakType, durationSeconds, characterTheme, options = {}) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const theme = characterTheme || settings.selectedCharacter;

  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((tab) => tab.id !== undefined && tab.url && !UNSUPPORTED_URL.test(tab.url));

  const message = {
    type: 'TRIGGER_BREAK',
    breakType,
    durationSeconds,
    characterTheme: theme,
    profileId: options.profileId,
    title: options.title,
    instructions: options.instructions,
  };

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
  console.info(`[BreakBuddy] broadcast ${options.title || breakType} break to ${targets.length} tab(s)`);
}

/**
 * Persist updated preset settings, then rebuild every alarm from storage.
 * @param {object} newSettings
 */
async function applySettingsUpdate(newSettings) {
  const merged = { ...DEFAULT_SETTINGS, ...newSettings };
  await chrome.storage.local.set(merged);
  await scheduleAllBreaks();

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

    case 'UPDATE_ALL_BREAKS':
      // Rebuild the full alarm schedule from persisted storage (presets + customs).
      scheduleAllBreaks().then(() => sendResponse({ ok: true }));
      return true;

    case 'TRIGGER_MANUAL_BREAK': {
      // Fire a chosen profile immediately, without waiting for its alarm.
      const p = message.profile || {};
      broadcastProfile({
        id: p.id,
        breakType: p.breakType || BREAK_TYPES.custom,
        name: p.name || 'Break',
        durationSeconds: Number(p.durationSeconds) || DEFAULT_SETTINGS.eyeBreakDuration,
        character: p.characterTheme || p.character,
      });
      sendResponse({ ok: true });
      return false;
    }

    case 'SNOOZE': {
      // Delay this exact break (preset or custom) by N minutes, then re-fire it once.
      const snoozeMinutes = Math.max(1, Number(message.minutes) || 5);
      const profileId = message.profileId || message.breakType || BREAK_TYPES.eye;
      const descriptor = {
        breakType: message.breakType || BREAK_TYPES.eye,
        durationSeconds: Number(message.durationSeconds) || DEFAULT_SETTINGS.eyeBreakDuration,
        characterTheme: message.characterTheme,
        title: message.title,
        instructions: message.instructions,
      };

      chrome.alarms.create(`snooze:${profileId}`, { delayInMinutes: snoozeMinutes });
      // Remember the full break so snoozed custom profiles re-fire correctly.
      chrome.storage.session.set({ [`pendingSnooze:${profileId}`]: descriptor });
      sendResponse({ ok: true, snoozeMinutes });
      return false;
    }

    default:
      return false;
  }
});

/** Handle one-shot snooze alarms created by SNOOZE requests. */
async function handleScheduledBreakAlarm(alarm) {
  const match = /^snooze:(.+)$/.exec(alarm.name);
  if (!match) return;

  const profileId = match[1];
  const key = `pendingSnooze:${profileId}`;
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key];
  await chrome.storage.session.remove(key);
  if (!pending) return;

  broadcastBreak(pending.breakType, pending.durationSeconds, pending.characterTheme, {
    profileId,
    title: pending.title,
    instructions: pending.instructions,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  // Populate defaults on first install without overwriting existing user values.
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  await chrome.storage.local.set(stored);

  await scheduleAllBreaks();
  console.info('[BreakBuddy] installed — defaults populated and alarms scheduled');
});

chrome.runtime.onStartup.addListener(async () => {
  // Service worker restart safety net: make sure alarms still exist.
  const existing = await chrome.alarms.getAll();
  if (existing.length === 0) {
    await scheduleAllBreaks();
  }
});
