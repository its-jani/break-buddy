/**
 * BreakBuddy — content script
 * Injects the full-screen Shadow DOM break overlay into every page and
 * responds to TRIGGER_BREAK broadcasts from the background service worker.
 */

(() => {
  if (window.__breakBuddyContentLoaded) return; // guard against double injection
  window.__breakBuddyContentLoaded = true;

  const ROOT_ID = 'break-buddy-root';
  const ACTIVE_CLASS = 'break-buddy-active';

  /** Interval id of the currently running countdown (if any). */
  let activeTimer = null;

  const BREAK_COPY = {
    eye: {
      title: 'Eye Rest Break',
      instructions: 'Look at something 20 feet (about 6 meters) away for 20 seconds.',
      emoji: '\u{1F440}', // 👀
    },
    long: {
      title: 'Move & Create Break',
      instructions: 'Stand up, stretch, grab some water — let your body and mind wander for 5 minutes.',
      emoji: '\u{1F3C3}', // 🏃
    },
    custom: {
      title: 'Time for a Break',
      instructions: 'Step away for a moment and come back refreshed.',
      emoji: '\u{2615}', // ☕
    },
  };

  /** Format seconds as mm:ss for the countdown display (e.g. 300 -> "05:00"). */
  function formatCountdown(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** Remove the overlay (if present), clear its timers, and unlock the page. */
  function dismissOverlay() {
    if (activeTimer !== null) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    document.getElementById(ROOT_ID)?.remove();
    document.documentElement.classList.remove(ACTIVE_CLASS);
  }

  /** Character themes that have a matching assets/<theme>_walk.webm file. */
  const VALID_CHARACTERS = ['cat', 'dog', 'superhero'];

  /**
   * Load the walking character animation into the overlay stage.
   * Falls back to the static emoji if the WebM is missing or unsupported.
   * @param {HTMLElement} stage
   * @param {string} characterTheme
   * @param {HTMLElement} emojiFallback
   */
  function populateStage(stage, characterTheme, emojiFallback) {
    const theme = VALID_CHARACTERS.includes(characterTheme) ? characterTheme : 'cat';
    const src = chrome.runtime.getURL(`assets/${theme}_walk.webm`);

    const video = document.createElement('video');
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.src = src;
    video.alt = '';

    // Hide the emoji placeholder while the buddy animation is visible.
    video.addEventListener('playing', () => {
      emojiFallback.style.display = 'none';
    });

    // Broken/missing asset — keep the emoji and drop the video quietly.
    video.addEventListener('error', () => {
      video.remove();
    });

    stage.replaceChildren(video);
  }

  /**
   * Build and attach the full-screen break overlay inside an isolated
   * Shadow DOM root so page CSS cannot bleed in or leak out.
   * @param {'eye'|'long'|'custom'} breakType
   * @param {number} durationSeconds
   * @param {string} characterTheme 'cat' | 'dog' | 'superhero'
   * @param {{title?: string, instructions?: string, profileId?: string}} [options]
   */
  function createBreakOverlay(breakType, durationSeconds, characterTheme, options = {}) {
    dismissOverlay(); // never stack two overlays

    const copy = BREAK_COPY[breakType] ?? BREAK_COPY.custom;
    // Custom profiles override the title/subtitle; presets keep their built-in copy.
    const titleText = options.title || copy.title;
    const instructionsText = options.instructions || copy.instructions;

    // --- Host element ------------------------------------------------------
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'z-index:2147483647',
      'pointer-events:auto', // locks the overlay down and blocks the page beneath
      'margin:0',
      'padding:0',
      'border:0',
      'display:block',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });

    // --- Scoped styles -----------------------------------------------------
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; display: block; position: fixed; inset: 0; }

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      .bb-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(10, 10, 15, 0.88);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1.5rem;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f2f4f8;
        text-align: center;
      }

      .bb-character-emoji {
        font-size: clamp(4rem, 12vw, 8rem);
        line-height: 1;
        animation: bb-float 2.4s ease-in-out infinite;
      }

      .bb-title {
        font-size: clamp(1.8rem, 4vw, 2.75rem);
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .bb-instructions {
        max-width: 34rem;
        font-size: clamp(1rem, 2vw, 1.2rem);
        line-height: 1.6;
        color: #b8c0cf;
        padding: 0 1.5rem;
      }

      .bb-countdown {
        font-variant-numeric: tabular-nums;
        font-size: clamp(2.5rem, 6vw, 4.5rem);
        font-weight: 800;
        letter-spacing: 0.05em;
        color: #7dd3fc;
        text-shadow: 0 0 24px rgba(125, 211, 252, 0.35);
      }

      .bb-stage {
        /* Dynamic media container — character animation is rendered here. */
        min-height: 8rem;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .bb-stage video {
        width: min(46vw, 420px);
        height: auto;
        filter: drop-shadow(0px 10px 15px rgba(0, 0, 0, 0.5));
      }

      .bb-actions {
        display: flex;
        gap: 0.75rem;
        margin-top: 0.5rem;
        flex-wrap: wrap;
        justify-content: center;
      }

      .bb-btn {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 0.65rem 1.5rem;
        font-size: 1rem;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }

      .bb-btn:hover { transform: translateY(-1px); }
      .bb-btn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }

      .bb-btn--snooze {
        background: rgba(125, 211, 252, 0.16);
        color: #bae6fd;
        border-color: rgba(125, 211, 252, 0.4);
      }

      .bb-btn--snooze:hover { background: rgba(125, 211, 252, 0.28); }

      .bb-btn--skip {
        background: transparent;
        color: #9aa3b2;
      }

      .bb-btn--skip:hover { background: rgba(255, 255, 255, 0.06); color: #d7dbe2; }

      .bb-note {
        font-size: 0.85rem;
        color: #7c8595;
        min-height: 1.2em;
      }

      @keyframes bb-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-12px); }
      }
    `;

    // --- Structure -----------------------------------------------------------
    const backdrop = document.createElement('div');
    backdrop.className = 'bb-backdrop';

    const emoji = document.createElement('div');
    emoji.className = 'bb-character-emoji';
    emoji.textContent = copy.emoji;

    const title = document.createElement('h1');
    title.className = 'bb-title';
    title.textContent = titleText;

    const instructions = document.createElement('p');
    instructions.className = 'bb-instructions';
    instructions.textContent = instructionsText;

    const countdown = document.createElement('div');
    countdown.className = 'bb-countdown';
    countdown.setAttribute('role', 'timer');
    countdown.setAttribute('aria-live', 'polite');
    countdown.textContent = formatCountdown(durationSeconds);

    const stage = document.createElement('div');
    stage.className = 'bb-stage';
    stage.dataset.character = characterTheme || 'cat';

    // --- Character media --------------------------------------------------
    populateStage(stage, characterTheme, emoji);

    // --- Snooze / Skip controls ----------------------------------------------
    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'bb-btn bb-btn--snooze';
    snoozeBtn.textContent = 'Snooze (5m)';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'bb-btn bb-btn--skip';
    skipBtn.textContent = 'Skip Break';

    const note = document.createElement('div');
    note.className = 'bb-note'; // inline feedback for snooze/skip

    snoozeBtn.addEventListener('click', () => {
      // Ask the background worker to delay this break by 5 minutes, then
      // tear the overlay down immediately.
      try {
        chrome.runtime.sendMessage(
          {
            type: 'SNOOZE',
            breakType,
            profileId: options.profileId,
            minutes: 5,
            durationSeconds,
            characterTheme,
            title: options.title,
            instructions: options.instructions,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              note.textContent = 'Could not reach BreakBuddy — break not snoozed.';
              return;
            }
            note.textContent = `Snoozed ${response?.snoozeMinutes ?? 5} minutes.`;
          }
        );
      } catch {
        note.textContent = 'Could not reach BreakBuddy — break not snoozed.';
      }
      dismissOverlay();
    });

    skipBtn.addEventListener('click', () => {
      dismissOverlay(); // cleanly clears the countdown interval + removes the DOM node
    });

    const actions = document.createElement('div');
    actions.className = 'bb-actions';
    actions.append(snoozeBtn, skipBtn);

    backdrop.append(emoji, title, instructions, countdown, stage, actions, note);
    shadow.append(style, backdrop);
    document.body.appendChild(host);
    document.documentElement.classList.add(ACTIVE_CLASS);

    // --- Countdown ------------------------------------------------------------
    let remaining = Math.max(1, Math.floor(durationSeconds));

    activeTimer = setInterval(() => {
      remaining -= 1;
      countdown.textContent = formatCountdown(Math.max(0, remaining));
      if (remaining <= 0) {
        dismissOverlay();
      }
    }, 1000);

    return { host, shadow, get timer() { return activeTimer; }, dismiss: dismissOverlay };
  }

  // --- Messaging ---------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'TRIGGER_BREAK') {
      createBreakOverlay(message.breakType, message.durationSeconds, message.characterTheme, {
        title: message.title,
        instructions: message.instructions,
        profileId: message.profileId,
      });
      sendResponse({ ok: true });
    }
    return false;
  });

  // Exposed for debugging / later phases.
  window.__breakBuddy = { createBreakOverlay, dismissOverlay, formatCountdown };
})();
