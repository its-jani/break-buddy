/**
 * BreakBuddy — content script
 * Injects a fully transparent Shadow DOM break layer into every page and
 * responds to TRIGGER_BREAK broadcasts from the background service worker.
 *
 * The page itself is never dimmed: there is no tint, no veil, and no blur
 * anywhere in the layer. The buddy walks in from outside the viewport, fills
 * the centre of the tab, and the giant countdown / snooze / skip controls sit
 * directly above it. Only the action buttons are interactive — everything else
 * in the layer is pointer-transparent, and an invisible blocker absorbs clicks
 * so the page underneath cannot be used during the break.
 *
 * Character media note: the shipped WebM walks are opaque 16:9 clips with a
 * black background (no alpha plane). They play exactly once and hold the final
 * resting frame rather than looping.
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
   * Load the walking character animation into the overlay stage.
   * The clip plays once and is held on its final resting frame.
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
    video.loop = false; // walk once, then hold the resting frame
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

    // Walk once and stop: pause just short of the clip's end so the buddy
    // stays parked on the final resting frame for the rest of the break.
    video.addEventListener('timeupdate', () => {
      const tail = Number(video.duration);
      if (!Number.isFinite(tail) || video.paused) return;
      if (video.currentTime >= tail - 0.15) {
        video.pause();
        video.currentTime = tail; // land exactly on the last frame
      }
    });

    // Safety net for streams where duration is unknown or timeupdate is throttled.
    video.addEventListener('ended', () => video.pause());

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
    // Transparent and pointer-events:none, so only the opt-in children (the
    // blocker and the action buttons) ever receive a click.
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

      /* Buddy + giant countdown are centred as one stack over the viewport. */
      .bb-dock {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        padding: 2vh 2vw;
        overflow: hidden; /* the giant type never spills past the viewport */
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #f2f4f8;
        text-align: center;
      }

      .bb-stage {
        /* Stage media. Framing is stripped back — no border, plate, or card
           shadow — so the clip reads as the break, not as a widget. */
        position: relative;
        flex: 0 0 auto;
        width: min(85vw, 750px);
        min-height: 5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: translateX(-100vw); /* start outside the viewport... */
        animation: bb-walk-in 2.5s cubic-bezier(0.22, 0.68, 0.24, 1) forwards;
      }

      .bb-stage video {
        display: block;
        width: 100%;
        max-height: 46vh;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        object-position: 50% 62%; /* the buddy sits low-centre in the source frame */
      }

      /* Mirror the buddy so it faces the direction it travels when needed. */
      .bb-stage[data-flip="1"] video {
        transform: scaleX(-1);
      }

      .bb-character-emoji {
        /* Absolute so the fallback never resizes the stage. */
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: clamp(4rem, 18vw, 12rem);
        line-height: 1;
      }

      /* --- Break info + giant timer ----------------------------------------- */
      .bb-card {
        /* Not interactive: only the action buttons opt back into pointer events. */
        pointer-events: none;
        flex: 0 0 auto;
        width: min(85vw, 750px);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        opacity: 0;
        transform: translateY(0.6rem);
        animation: bb-badge-in 450ms ease-out 2.1s forwards; /* lands as the buddy settles */
      }

      .bb-title {
        font-size: clamp(3rem, 6vw, 4.5rem);
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 2px;
        line-height: 1.05;
        color: #ffffff;
        text-shadow: 0 2px 6px rgba(0, 0, 0, 0.85), 0 0 28px rgba(0, 0, 0, 0.55);
      }

      .bb-instructions {
        max-width: 30ch;
        font-size: clamp(1rem, 2.2vw, 1.5rem);
        font-weight: 700;
        line-height: 1.35;
        color: #e6edf6;
        text-shadow: 0 2px 6px rgba(0, 0, 0, 0.85);
      }

      .bb-countdown {
        font-variant-numeric: tabular-nums;
        font-size: clamp(6rem, 16vw, 8rem);
        font-weight: 900;
        letter-spacing: 2px;
        line-height: 1;
        color: #38bdf8;
        text-shadow: 0 4px 14px rgba(0, 0, 0, 0.85), 0 0 46px rgba(56, 189, 248, 0.45);
      }

      .bb-actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .bb-btn {
        pointer-events: auto; /* the only interactive surface in the layer */
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 999px;
        padding: 0.7rem 1.7rem;
        font-size: 1.05rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-family: inherit;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }

      .bb-btn:hover { transform: translateY(-1px); }
      .bb-btn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }

      .bb-btn--snooze {
        background: #0ea5e9;
        color: #04222f;
        border-color: rgba(255, 255, 255, 0.45);
      }

      .bb-btn--snooze:hover { background: #38bdf8; }

      .bb-btn--skip {
        background: rgba(15, 23, 42, 0.78);
        color: #e2e8f0;
      }

      .bb-btn--skip:hover { background: rgba(15, 23, 42, 0.92); color: #ffffff; }

      .bb-note {
        font-size: 1rem;
        font-weight: 700;
        color: #bae6fd;
        text-shadow: 0 2px 6px rgba(0, 0, 0, 0.85);
        min-height: 1.2em;
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
        .bb-card {
          gap: 0.25rem;
        }

        .bb-title {
          font-size: clamp(2.25rem, 9vw, 3rem);
        }

        .bb-countdown {
          font-size: clamp(4rem, 20vw, 6rem);
        }

        .bb-btn {
          padding: 0.55rem 1.2rem;
          font-size: 0.95rem;
        }
      }

      /* Walk in from far outside the viewport to the resting spot in the
         centre of the tab. The stage travels as one unit, media and all. */
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

    // --- Break info + giant timer (only the buttons are interactive) ---------
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
    // Wheel/touch input on the transparent blocker is absorbed so the page
    // underneath cannot scroll; the layer's own text is pointer-transparent.
    blocker.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
    blocker.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });

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
