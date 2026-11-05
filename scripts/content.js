/**
 * BreakBuddy — content script
 * Injects a fully transparent Shadow DOM break layer into every page and
 * responds to TRIGGER_BREAK broadcasts from the background service worker.
 *
 * The page itself is never dimmed: there is no tint, no veil, and no blur
 * anywhere in the layer. A buddy walks in from outside the viewport, settles
 * at the bottom of the screen, and the countdown / snooze / skip controls live
 * in a small floating badge beside it. Clicks are still swallowed for the
 * whole break — pointer-events are disabled on the layer and re-enabled only
 * on the transparent click-blocker and the floating UI.
 *
 * Character media note: the shipped WebM walks are opaque 16:9 clips with a
 * black background (no alpha plane), so they are presented inside a small
 * contained video tile instead of being allowed to cover the viewport.
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
  const VALID_CHARACTERS = ['cat1', 'cat2'];
  const DEFAULT_CHARACTER = 'cat1';

  /**
   * False once the extension has been reloaded/uninstalled, which leaves this
   * script orphaned and every chrome.runtime call throwing synchronously.
   */
  function isContextAlive() {
    try {
      return !!(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * Load the walking character animation into the overlay tile.
   * Falls back to the static emoji if the WebM is missing or unsupported.
   * @param {HTMLElement} stage
   * @param {string} characterTheme
   * @param {HTMLElement} emojiFallback
   */
  function populateStage(stage, characterTheme, emojiFallback) {
    const theme = VALID_CHARACTERS.includes(characterTheme) ? characterTheme : DEFAULT_CHARACTER;
    const src = chrome.runtime.getURL(`assets/${theme}_walk.webm`);

    const video = document.createElement('video');
    video.autoplay = true;
    video.loop = true; // the walk is an in-place cycle — keep it stepping
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

    stage.appendChild(video);
  }

  /**
   * Build and attach the transparent break layer inside an isolated Shadow DOM
   * root so page CSS cannot bleed in or leak out.
   * @param {'eye'|'long'|'custom'} breakType
   * @param {number} durationSeconds
   * @param {string} characterTheme 'cat1' | 'cat2'
   * @param {{title?: string, instructions?: string, profileId?: string}} [options]
   */
  function createBreakOverlay(breakType, durationSeconds, characterTheme, options = {}) {
    dismissOverlay(); // never stack two overlays

    const copy = BREAK_COPY[breakType] ?? BREAK_COPY.custom;
    // Custom profiles override the title/subtitle; presets keep their built-in copy.
    const titleText = options.title || copy.title;
    const instructionsText = options.instructions || copy.instructions;

    // --- Host element ------------------------------------------------------
    // Transparent and pointer-events:none by default, so page content shows
    // through untouched everywhere except the blocker and the floating UI.
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'z-index:2147483647',
      'pointer-events:none', // pass clicks through unless a child opts back in
      'margin:0',
      'padding:0',
      'border:0',
      'display:block',
      'background:transparent',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });

    // --- Scoped styles -----------------------------------------------------
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; display: block; position: fixed; inset: 0; }

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      /* Fully transparent click blocker: it swallows pointer input for the
         whole break while leaving every pixel of the page visible. */
      .bb-blocker {
        position: absolute;
        inset: 0;
        background: transparent;
        pointer-events: auto;
        touch-action: none;
      }

      /* Character tile + badge ride in together along the bottom of the viewport. */
      .bb-dock {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 4vh;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        gap: 1rem;
        padding: 0 1.25rem;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f2f4f8;
        text-align: left;
      }

      .bb-stage {
        /* Contained video tile. The shipped walks are opaque, so the media is
           framed as a deliberate small card instead of covering the viewport. */
        position: relative;
        flex: 0 0 auto;
        min-width: 5rem;
        min-height: 5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 6px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 16px;
        background: #0b0d12;
        box-shadow: 0 14px 32px rgba(0, 0, 0, 0.32);
        overflow: hidden;
        transform: translateX(-100vw); /* start outside the viewport... */
        animation: bb-walk-in 2.5s cubic-bezier(0.22, 0.68, 0.24, 1) forwards;
      }

      .bb-stage video {
        display: block;
        width: min(34vw, 240px);
        aspect-ratio: 16 / 9;
        height: auto;
        object-fit: cover;
        object-position: 50% 62%; /* the buddy sits low-centre in the source frame */
        border-radius: 10px;
      }

      /* Mirror the buddy so it faces the direction it travels when needed. */
      .bb-stage[data-flip="1"] video {
        transform: scaleX(-1);
      }

      .bb-character-emoji {
        /* Absolute so the fallback never resizes the tile — the badge and the
           buddy stay aligned whether the WebM loads or not. */
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: clamp(2.5rem, 8vw, 4.5rem);
        line-height: 1;
      }

      /* --- Minimalist floating badge -------------------------------------- */
      .bb-card {
        pointer-events: auto;
        flex: 0 1 19rem;
        max-width: 20rem;
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        padding: 0.85rem 1rem;
        border-radius: 16px;
        background: rgba(17, 22, 31, 0.88);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
        opacity: 0;
        transform: translateY(0.6rem);
        animation: bb-badge-in 450ms ease-out 2.1s forwards; /* lands as the buddy settles */
      }

      .bb-title {
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: #f2f4f8;
      }

      .bb-instructions {
        font-size: 0.8rem;
        line-height: 1.45;
        color: #b8c0cf;
      }

      .bb-countdown {
        font-variant-numeric: tabular-nums;
        font-size: 1.9rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        line-height: 1.1;
        color: #7dd3fc;
      }

      .bb-actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .bb-btn {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 0.4rem 0.9rem;
        font-size: 0.82rem;
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

      .bb-btn--skip:hover { background: rgba(255, 255, 255, 0.08); color: #d7dbe2; }

      .bb-note {
        font-size: 0.75rem;
        color: #7dd3fc;
        min-height: 1.1em;
      }

      @media (prefers-reduced-motion: reduce) {
        .bb-stage,
        .bb-card {
          animation: none !important;
          transform: none !important;
          opacity: 1 !important;
        }
      }

      @media (max-width: 720px) {
        .bb-dock {
          flex-direction: column;
          align-items: center;
          gap: 0.75rem;
        }

        .bb-stage video {
          width: min(58vw, 200px);
        }

        .bb-card {
          flex: 0 0 auto;
          width: min(92vw, 22rem);
          max-width: none;
          align-items: center;
          text-align: center;
        }
      }

      /* Walk in from far outside the viewport to the resting spot along the
         bottom edge. The tile travels as one unit, media and all. */
      @keyframes bb-walk-in {
        from { transform: translateX(-100vw); }
        to { transform: translateX(0); }
      }

      @keyframes bb-badge-in {
        from { opacity: 0; transform: translateY(0.6rem); }
        to { opacity: 1; transform: translateY(0); }
      }

      @keyframes bb-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-8px); }
      }
    `;

    // --- Structure -----------------------------------------------------------
    // Transparent blocker: keeps the page visible but unclickable.
    const blocker = document.createElement('div');
    blocker.className = 'bb-blocker';

    const dock = document.createElement('div');
    dock.className = 'bb-dock';

    const stage = document.createElement('div');
    stage.className = 'bb-stage';
    stage.dataset.character = VALID_CHARACTERS.includes(characterTheme)
      ? characterTheme
      : DEFAULT_CHARACTER;

    const emoji = document.createElement('div');
    emoji.className = 'bb-character-emoji';
    emoji.textContent = copy.emoji;
    stage.appendChild(emoji);

    // --- Character media --------------------------------------------------
    populateStage(stage, characterTheme, emoji);

    // --- Floating badge ------------------------------------------------------
    const card = document.createElement('div');
    card.className = 'bb-card';

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
      // Ask the background worker to delay this break by 5 minutes. The badge
      // stays up briefly so the confirmation is readable, then tears down.
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
            } else {
              note.textContent = `Snoozed ${response?.snoozeMinutes ?? 5} minutes.`;
            }
            setTimeout(dismissOverlay, 900);
          }
        );
      } catch {
        note.textContent = 'Could not reach BreakBuddy — break not snoozed.';
        setTimeout(dismissOverlay, 900);
      }
    });

    skipBtn.addEventListener('click', () => {
      dismissOverlay(); // cleanly clears the countdown interval + removes the DOM node
    });

    const actions = document.createElement('div');
    actions.className = 'bb-actions';
    actions.append(snoozeBtn, skipBtn);

    card.append(title, instructions, countdown, actions, note);
    dock.append(stage, card);
    shadow.append(style, blocker, dock);
    document.body.appendChild(host);
    document.documentElement.classList.add(ACTIVE_CLASS);

    // --- Interaction isolation -------------------------------------------
    // The badge never scrolls the page, and wheel/touch input on the
    // transparent blocker cannot reach the document underneath.
    blocker.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
    blocker.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
    card.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });

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
  if (!isContextAlive()) {
    // Orphaned script from a previous build: drop the guard flag so the
    // reloaded extension can inject a fresh, connected copy into this page.
    window.__breakBuddyContentLoaded = false;
    return;
  }

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
