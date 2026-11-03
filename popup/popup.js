/**
 * BreakBuddy — settings popup controller
 * Manages preset timers and custom break profiles (CRUD) against
 * chrome.storage.local, dispatches manual break triggers, and keeps the
 * background alarm schedule in sync via UPDATE_ALL_BREAKS.
 */

const DEFAULT_SETTINGS = {
  eyeBreakInterval: 20,
  eyeBreakDuration: 20, // seconds
  longBreakInterval: 60,
  longBreakDuration: 300, // seconds
  selectedCharacter: 'cat',
};

const CHARACTERS = ['cat', 'dog', 'superhero'];
const CHARACTER_EMOJI = { cat: '🐱', dog: '🐶', superhero: '🦸' };

// --- DOM references --------------------------------------------------------
const $ = (id) => document.getElementById(id);

const tabs = { defaults: $('tab-defaults'), customs: $('tab-customs') };
const panels = { defaults: $('panel-defaults'), customs: $('panel-customs') };

const defaultsForm = $('defaults-form');
const eyeInterval = $('eye-break-interval');
const eyeDuration = $('eye-break-duration');
const longInterval = $('long-break-interval');
const longDuration = $('long-break-duration'); // shown in minutes
const characterSelect = $('character-theme');

const customList = $('custom-breaks-list');
const customEmpty = $('custom-empty');
const customCount = $('custom-count');
const addCustomBtn = $('add-custom-btn');

const modal = $('custom-modal');
const modalTitle = $('modal-title');
const customForm = $('custom-form');
const customIdInput = $('custom-id');
const customName = $('custom-name');
const customInterval = $('custom-interval');
const customDuration = $('custom-duration');
const customDurationUnit = $('custom-duration-unit');
const customCharacter = $('custom-character');

const statusEl = $('status');

// --- Small helpers ---------------------------------------------------------

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = `bb-status${kind ? ` ${kind}` : ''}`;
}

/** Read a positive integer from a numeric input, clamped to [1, max]. */
function readNumber(input, fallback, max) {
  const value = Math.floor(Number(input.value));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max || value);
}

/** Ask the background worker to rebuild every alarm from storage. */
function resyncAlarms() {
  return chrome.runtime.sendMessage({ type: 'UPDATE_ALL_BREAKS' }).catch(() => {
    /* background handler lands in a later phase — non-fatal for now */
  });
}

/** Human-readable duration ("45s" / "5m"). */
function formatDuration(seconds) {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  return `${seconds}s`;
}

// --- Tabs ------------------------------------------------------------------

function activateTab(name) {
  for (const [key, tab] of Object.entries(tabs)) {
    const active = key === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const [key, panel] of Object.entries(panels)) {
    const active = key === name;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  }
}

tabs.defaults.addEventListener('click', () => activateTab('defaults'));
tabs.customs.addEventListener('click', () => activateTab('customs'));

// --- Preset settings -------------------------------------------------------

async function loadPresets() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  eyeInterval.value = settings.eyeBreakInterval;
  eyeDuration.value = settings.eyeBreakDuration; // seconds
  longInterval.value = settings.longBreakInterval;
  longDuration.value = Math.max(1, Math.round(settings.longBreakDuration / 60)); // show minutes
  characterSelect.value = settings.selectedCharacter;
}

defaultsForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const settings = {
    eyeBreakInterval: readNumber(eyeInterval, DEFAULT_SETTINGS.eyeBreakInterval, 180),
    eyeBreakDuration: readNumber(eyeDuration, DEFAULT_SETTINGS.eyeBreakDuration, 600),
    longBreakInterval: readNumber(longInterval, DEFAULT_SETTINGS.longBreakInterval, 240),
    longBreakDuration: readNumber(longDuration, 5, 60) * 60, // minutes -> seconds
    selectedCharacter: characterSelect.value,
  };

  // Reflect the clamped values back into the inputs.
  eyeInterval.value = settings.eyeBreakInterval;
  eyeDuration.value = settings.eyeBreakDuration;
  longInterval.value = settings.longBreakInterval;
  longDuration.value = Math.round(settings.longBreakDuration / 60);

  await chrome.storage.local.set(settings);
  await resyncAlarms();
  setStatus('Presets saved — schedule updated ✓', 'success');
});

// --- Manual "Take Break Now" -----------------------------------------------

/** Build the descriptor for a preset from the last-saved settings. */
async function presetDescriptor(id) {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return id === 'eye'
    ? { id: 'eye', breakType: 'eye', name: 'Eye Rest Break', durationSeconds: s.eyeBreakDuration, characterTheme: s.selectedCharacter }
    : { id: 'long', breakType: 'long', name: 'Move & Create Break', durationSeconds: s.longBreakDuration, characterTheme: s.selectedCharacter };
}

async function triggerManual(descriptor) {
  await chrome.runtime
    .sendMessage({ type: 'TRIGGER_MANUAL_BREAK', profile: descriptor })
    .catch(() => {/* handler lands in a later phase */});
  setStatus(`Triggered “${descriptor.name}” now ⚡`, 'success');
}

document.querySelectorAll('[data-take-now]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const descriptor = await presetDescriptor(btn.dataset.takeNow);
    triggerManual(descriptor);
  });
});

// --- Custom breaks: read / render ------------------------------------------

async function getCustomBreaks() {
  const { customBreaks = [] } = await chrome.storage.local.get({ customBreaks: [] });
  return Array.isArray(customBreaks) ? customBreaks : [];
}

async function saveCustomBreaks(list) {
  await chrome.storage.local.set({ customBreaks: list });
  await resyncAlarms();
}

async function renderCustomBreaks() {
  const breaks = await getCustomBreaks();

  customList.replaceChildren();
  customCount.textContent = `${breaks.length} ${breaks.length === 1 ? 'break' : 'breaks'}`;
  customEmpty.hidden = breaks.length > 0;

  for (const profile of breaks) {
    customList.appendChild(buildRow(profile));
  }
}

/** Build a single <li> row for a custom break profile. */
function buildRow(profile) {
  const li = document.createElement('li');
  li.className = `bb-item${profile.enabled ? '' : ' is-disabled'}`;

  // Toggle switch
  const label = document.createElement('label');
  label.className = 'switch';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = profile.enabled;
  toggle.setAttribute('aria-label', `Enable ${profile.name}`);
  const slider = document.createElement('span');
  slider.className = 'slider';
  label.append(toggle, slider);

  // Title + meta
  const main = document.createElement('div');
  main.className = 'bb-item-main';
  const title = document.createElement('div');
  title.className = 'bb-item-title';
  title.textContent = `${CHARACTER_EMOJI[profile.character] ?? '⏰'} ${profile.name}`;
  const meta = document.createElement('div');
  meta.className = 'bb-item-meta';
  meta.textContent = `every ${profile.intervalMinutes}m · ${formatDuration(profile.durationSeconds)}`;
  main.append(title, meta);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'bb-item-actions';

  const now = document.createElement('button');
  now.type = 'button';
  now.className = 'bb-now';
  now.textContent = '⚡';
  now.title = 'Take this break now';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'bb-icon-btn';
  edit.textContent = '✎';
  edit.title = 'Edit';
  edit.setAttribute('aria-label', `Edit ${profile.name}`);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'bb-icon-btn danger';
  del.textContent = '🗑';
  del.title = 'Delete';
  del.setAttribute('aria-label', `Delete ${profile.name}`);

  actions.append(now, edit, del);
  li.append(label, main, actions);

  // Wire actions
  toggle.addEventListener('change', async () => {
    const list = await getCustomBreaks();
    const item = list.find((b) => b.id === profile.id);
    if (item) item.enabled = toggle.checked;
    await saveCustomBreaks(list);
    li.classList.toggle('is-disabled', !toggle.checked);
    setStatus(toggle.checked ? `“${profile.name}” enabled` : `“${profile.name}” paused`, 'success');
  });

  now.addEventListener('click', () => {
    triggerManual({
      id: profile.id,
      breakType: 'custom',
      name: profile.name,
      durationSeconds: profile.durationSeconds,
      characterTheme: profile.character,
    });
  });

  edit.addEventListener('click', () => openModal(profile));
  del.addEventListener('click', async () => {
    const list = await getCustomBreaks();
    await saveCustomBreaks(list.filter((b) => b.id !== profile.id));
    await renderCustomBreaks();
    setStatus(`“${profile.name}” deleted`, 'success');
  });

  return li;
}

// --- Custom breaks: create / edit modal ------------------------------------

function openModal(profile) {
  customForm.reset();
  if (profile) {
    modalTitle.textContent = 'Edit Custom Break';
    customIdInput.value = profile.id;
    customName.value = profile.name;
    customInterval.value = profile.intervalMinutes;
    // Prefer minutes when the stored duration divides evenly, else seconds.
    if (profile.durationSeconds >= 60 && profile.durationSeconds % 60 === 0) {
      customDurationUnit.value = 'min';
      customDuration.value = profile.durationSeconds / 60;
    } else {
      customDurationUnit.value = 'sec';
      customDuration.value = profile.durationSeconds;
    }
    customCharacter.value = profile.character;
  } else {
    modalTitle.textContent = 'Add Custom Break';
    customIdInput.value = '';
  }
  modal.hidden = false;
  customName.focus();
}

function closeModal() {
  modal.hidden = true;
}

addCustomBtn.addEventListener('click', () => openModal(null));

modal.querySelectorAll('[data-close-modal]').forEach((el) => {
  el.addEventListener('click', closeModal);
});

customForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const name = customName.value.trim();
  const intervalMinutes = readNumber(customInterval, 0, 600);
  const rawDuration = readNumber(customDuration, 0, 3600);
  const durationSeconds = customDurationUnit.value === 'min' ? rawDuration * 60 : rawDuration;

  // Validate before persisting — reject zero / negative / blank values.
  if (!name) return setStatus('Break name is required.', 'error');
  if (intervalMinutes < 1) return setStatus('Interval must be at least 1 minute.', 'error');
  if (durationSeconds < 1) return setStatus('Duration must be at least 1 second.', 'error');

  const character = CHARACTERS.includes(customCharacter.value) ? customCharacter.value : 'cat';
  const list = await getCustomBreaks();
  const editingId = customIdInput.value;

  if (editingId) {
    const item = list.find((b) => b.id === editingId);
    if (item) Object.assign(item, { name, intervalMinutes, durationSeconds, character });
    setStatus(`“${name}” updated ✓`, 'success');
  } else {
    list.push({
      id: `custom_${Date.now()}`,
      name,
      intervalMinutes,
      durationSeconds,
      character,
      enabled: true,
    });
    setStatus(`“${name}” added ✓`, 'success');
  }

  await saveCustomBreaks(list);
  await renderCustomBreaks();
  closeModal();
});

// --- Init ------------------------------------------------------------------

async function init() {
  await loadPresets();
  await renderCustomBreaks();
  activateTab('defaults');
}

init();
