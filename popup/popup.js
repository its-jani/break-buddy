/**
 * BreakBuddy — settings popup logic
 * Loads persisted settings on open, and on save writes them back to
 * chrome.storage.local + notifies the background worker to reset alarms.
 */

const DEFAULT_SETTINGS = {
  eyeBreakInterval: 20,
  longBreakInterval: 60,
  selectedCharacter: 'cat',
};

const eyeInput = document.getElementById('eye-break-interval');
const longInput = document.getElementById('long-break-interval');
const characterSelect = document.getElementById('character-theme');
const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');

/** Populate the form from chrome.storage.local. */
async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  eyeInput.value = settings.eyeBreakInterval;
  longInput.value = settings.longBreakInterval;
  characterSelect.value = settings.selectedCharacter;
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `bb-status${kind ? ` ${kind}` : ''}`;
}

/** Clamp/validate a minute input, falling back to the default when invalid. */
function readMinutes(input, fallback) {
  const value = Math.floor(Number(input.value));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, Number(input.max) || 240);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const settings = {
    eyeBreakInterval: readMinutes(eyeInput, DEFAULT_SETTINGS.eyeBreakInterval),
    longBreakInterval: readMinutes(longInput, DEFAULT_SETTINGS.longBreakInterval),
    selectedCharacter: characterSelect.value,
  };

  // Keep the visible inputs in sync with the clamped values.
  eyeInput.value = settings.eyeBreakInterval;
  longInput.value = settings.longBreakInterval;

  try {
    await chrome.storage.local.set(settings);

    // Tell the background worker so it tears down and re-creates the alarms.
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });

    setStatus('Saved — breaks rescheduled ✓', 'success');
  } catch (error) {
    console.error('[BreakBuddy popup] failed to save settings', error);
    setStatus('Could not save settings.', 'error');
  }
});

loadSettings();
