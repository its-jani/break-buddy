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
 * Fire a break of the given type. Placeholder wiring — multi-window tab
 * broadcasting is implemented in the messaging layer (see broadcastBreak).
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
      // Snooze / ad-hoc alarms are handled by the messaging layer.
      handleScheduledBreakAlarm(alarm);
      break;
  }
});

/** Fallback hook for non-repeating alarms (snooze) until messaging layer lands. */
function handleScheduledBreakAlarm(alarm) {
  console.info(`[BreakBuddy] alarm fired: ${alarm.name}`);
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
