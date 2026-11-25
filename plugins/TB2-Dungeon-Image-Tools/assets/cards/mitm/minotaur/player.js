/* Minotaurus: dependency-free, transparent, one-shot website companion. */
(function (root) {
  "use strict";

  const defaults = Object.freeze({
    cellWidth: 384, cellHeight: 416, columns: 8,
    height: 130 * 5 / 6, bottom: 0, assetBase: "./assets/", stopPosition: 0.4,
    walkStridePx: 232, runStridePx: 320,
    walkSpeed: 0.7, runStartSpeed: 0.8, runSpeed: 2.2, runAcceleration: 1.6,
    brakeDistanceRatio: 0.055,
    enterMs: null, brakeMs: 240, turnMs: 720, stareMs: 700,
    inhaleMs: 420, snortMs: 800, lingerMs: 180,
    turnChargeMs: 1040, runMs: null,
  });
  const clipNames = ["walk-right", "stop-turn-front", "snort", "turn-charge", "run-right"];
  const phaseKeys = ["enter", "brake", "turn", "stare", "inhale", "snort", "linger", "turnCharge", "run"];

  /** Validate configurable timings and dimensions before loading any images. */
  function configuration(options = {}) {
    const config = { ...defaults, ...options };
    for (const key of [...phaseKeys.map((phase) => `${phase}Ms`), "walkStridePx", "runStridePx", "height"]) {
      if ((key === "enterMs" || key === "runMs") && config[key] === null) continue;
      if (!Number.isFinite(config[key]) || config[key] <= 0) throw new RangeError(`${key} must be positive`);
    }
    for (const key of ["walkSpeed", "runStartSpeed", "runSpeed", "runAcceleration", "brakeDistanceRatio"]) {
      if (!Number.isFinite(config[key]) || config[key] <= 0) throw new RangeError(`${key} must be positive`);
    }
    if (config.runStartSpeed > config.runSpeed) throw new RangeError("runStartSpeed must not exceed runSpeed");
    if (!Number.isFinite(config.stopPosition) || config.stopPosition <= 0 || config.stopPosition >= 1) {
      throw new RangeError("stopPosition must be between 0 and 1");
    }
    if (config.brakeDistanceRatio >= defaults.cellWidth / defaults.cellHeight / 2) {
      throw new RangeError("brakeDistanceRatio must leave a positive entrance distance");
    }
    if (!Number.isFinite(config.bottom) || config.bottom < 0) throw new RangeError("bottom must be nonnegative");
    // Logical pose geometry stays stable when the encoded assets are downscaled.
    config.cellWidth = defaults.cellWidth;
    config.cellHeight = defaults.cellHeight;
    config.columns = defaults.columns;
    return config;
  }

  /** Distance in figure heights: accelerate uniformly, then cruise at the speed limit. */
  function runDistance(seconds, config) {
    const rampSeconds = (config.runSpeed - config.runStartSpeed) / config.runAcceleration;
    const accelerating = Math.min(seconds, rampSeconds);
    return config.runStartSpeed * accelerating + config.runAcceleration * accelerating ** 2 / 2
      + config.runSpeed * Math.max(0, seconds - rampSeconds);
  }

  /** Solve travel time for both short departures and departures that reach the speed limit. */
  function runTravelMs(distance, config) {
    const heights = distance / config.height;
    const rampSeconds = (config.runSpeed - config.runStartSpeed) / config.runAcceleration;
    const rampDistance = runDistance(rampSeconds, config);
    const seconds = heights < rampDistance
      ? 2 * heights / (config.runStartSpeed + Math.sqrt(config.runStartSpeed ** 2 + 2 * config.runAcceleration * heights))
      : rampSeconds + (heights - rampDistance) / config.runSpeed;
    return seconds * 1000;
  }

  /** Resolve travel times from CSS width and displayed height. Speeds are heights/second. */
  function timing(width, config = defaults) {
    if (width === undefined && config.enterMs !== null && config.runMs !== null) return config;
    if (!Number.isFinite(width) || width <= 0) throw new RangeError("Automatic timing requires a positive viewport width");
    const halfSprite = config.height * config.cellWidth / config.cellHeight / 2;
    const stop = width * config.stopPosition;
    const entryDistance = stop + halfSprite - config.height * config.brakeDistanceRatio;
    const minimumRunMs = runTravelMs(width - stop + halfSprite, config);
    return { ...config,
      enterMs: config.enterMs ?? entryDistance / (config.height * config.walkSpeed) * 1000,
      // An explicit duration may slow the run but must never bypass its speed limit.
      runMs: Math.max(config.runMs ?? minimumRunMs, minimumRunMs),
    };
  }

  /** Total one-shot duration. Automatic timing requires the canvas CSS width. */
  function duration(config = defaults, width) {
    const resolved = timing(width, config);
    return phaseKeys.reduce((sum, phase) => sum + resolved[`${phase}Ms`], 0);
  }

  /** Preserve phase and its progress on resize, including an already completed scene. */
  function retime(time, before, after) {
    if (time >= duration(before)) return duration(after);
    let local = time;
    let start = 0;
    for (const phase of phaseKeys) {
      const key = `${phase}Ms`;
      if (local < before[key]) return start + local / before[key] * after[key];
      local -= before[key];
      start += after[key];
    }
    return duration(after);
  }

  /** Pure frame/timeline selection; also used for seeking and deterministic QA. */
  function sample(time, width, config = defaults) {
    if (!Number.isFinite(time) || !Number.isFinite(width) || width <= 0) {
      throw new RangeError("time must be finite and viewport width positive");
    }
    config = timing(width, config);
    const total = duration(config);
    if (time >= total) return { visible: false, done: true, phase: "done" };
    if (time < 0) return { visible: false, done: false, phase: "before" };
    let local = time;
    let phase = phaseKeys[0];
    for (const key of phaseKeys) {
      phase = key;
      if (local < config[`${key}Ms`]) break;
      local -= config[`${key}Ms`];
    }
    const progress = local / config[`${phase}Ms`];
    const spriteWidth = config.height * config.cellWidth / config.cellHeight;
    const stop = width * config.stopPosition;
    const start = -spriteWidth / 2;
    const end = width + spriteWidth / 2;
    const brakingDistance = config.height * config.brakeDistanceRatio;
    let x = stop;
    let clip = "snort";
    let frame = 0;
    switch (phase) {
      case "enter":
        x = start + (stop - brakingDistance - start) * progress;
        clip = "walk-right";
        // A complete cycle covers two alternating steps. Couple it to travel,
        // then end on a complete cycle so the braking pose follows coherently.
        {
          const stride = config.walkStridePx * config.height / config.cellHeight;
          const cycles = Math.max(1, Math.round((stop - brakingDistance - start) / stride));
          frame = Math.floor(progress * cycles * config.columns) % config.columns;
        }
        break;
      case "brake":
        x = stop - brakingDistance * (1 - progress) ** 2;
        clip = "stop-turn-front";
        frame = Math.min(1, Math.floor(progress * 2));
        break;
      case "turn":
        clip = "stop-turn-front";
        frame = Math.min(7, 2 + Math.floor(progress * 6));
        break;
      case "stare": frame = 0; break;
      case "inhale": frame = Math.min(2, Math.floor(progress * 3)); break;
      case "snort": frame = Math.min(7, 3 + Math.floor(progress * 5)); break;
      case "linger": frame = 7; break;
      case "turnCharge":
        clip = "turn-charge";
        frame = Math.min(7, Math.floor(progress * 8));
        break;
      case "run":
        clip = "run-right";
        {
          const naturalDuration = runTravelMs(end - stop, config);
          x = Math.min(end, stop + config.height * runDistance(local * naturalDuration / config.runMs / 1000, config));
          const stride = config.runStridePx * config.height / config.cellHeight;
          frame = Math.floor((x - stop) / stride * config.columns) % config.columns;
        }
        break;
    }
    return { visible: true, done: false, phase, clip, frame, x, spriteWidth };
  }

  /** Load one same-origin sprite with an actionable error on failure. */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Minotaurus sprite could not be loaded: ${url}`));
      image.src = url;
    });
  }

  /**
   * Mount on a canvas sized by CSS. Returns play/pause/seek/reset/destroy controls.
   * Autoplay is opt-in. Reduced-motion users get a still until they explicitly play.
   * @param {HTMLCanvasElement} canvas Target transparent canvas.
   * @param {object} options Asset URL, rendered height, timings and callbacks.
   * @returns {Promise<object>} Ready player; rejects when a sprite is unavailable.
   */
  async function mount(canvas, options = {}) {
    const config = configuration(options);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("A 2D canvas context is required");
    const images = Object.fromEntries(await Promise.all(clipNames.map(async (name) => [
      name, await loadImage(new URL(`${name}.webp`, new URL(config.assetBase, document.baseURI)).href),
    ])));
    let total = 0;
    let layout = null;
    let display = config;
    let elapsed = 0;
    let previous = null;
    let handle = null;
    let playing = false;
    let destroyed = false;
    let reducedStill = matchMedia("(prefers-reduced-motion: reduce)").matches;

    function refreshLayout() {
      if (destroyed) return null;
      const bounds = canvas.getBoundingClientRect();
      const height = Math.min(config.height, bounds.height - config.bottom);
      if (bounds.width <= 0 || height <= 0) return null;
      if (!layout || bounds.width !== layout.width || height !== display.height) {
        const next = timing(bounds.width, { ...config, height });
        if (layout) elapsed = retime(elapsed, display, next);
        display = next;
        total = duration(display);
        previous = null;
      }
      layout = bounds;
      return bounds;
    }

    function draw(bounds = refreshLayout()) {
      if (!bounds) return;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(bounds.width * ratio);
      const pixelHeight = Math.round(bounds.height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      // The same display scale applies to every state, including mobile layouts.
      const state = reducedStill
        ? { visible: true, clip: "snort", frame: 0, x: bounds.width * config.stopPosition,
          spriteWidth: display.height * config.cellWidth / config.cellHeight }
        : sample(elapsed, bounds.width, display);
      if (state.visible) {
        const image = images[state.clip];
        const frameWidth = image.naturalWidth / config.columns;
        context.drawImage(image, state.frame * frameWidth, 0,
          frameWidth, image.naturalHeight, state.x - state.spriteWidth / 2,
          bounds.height - display.height - config.bottom, state.spriteWidth, display.height);
      }
      options.onUpdate?.({ time: elapsed, duration: total, state, playing });
    }

    function pause() {
      playing = false;
      previous = null;
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
    }

    function tick(now) {
      if (!playing || destroyed) return;
      const bounds = refreshLayout();
      if (bounds && previous !== null) elapsed = Math.min(total, elapsed + now - previous);
      previous = bounds ? now : null;
      draw(bounds);
      if (bounds && elapsed >= total) {
        pause();
        options.onComplete?.();
      } else handle = requestAnimationFrame(tick);
    }

    function play() {
      if (destroyed) throw new Error("Minotaurus player has been destroyed");
      if (playing) return;
      refreshLayout();
      reducedStill = false;
      if (total > 0 && elapsed >= total) elapsed = 0;
      playing = true;
      previous = null;
      handle = requestAnimationFrame(tick);
    }

    function seek(time) {
      if (!Number.isFinite(time)) throw new RangeError("seek time must be finite");
      if (destroyed) throw new Error("Minotaurus player has been destroyed");
      refreshLayout();
      pause();
      reducedStill = false;
      elapsed = Math.max(0, Math.min(total, time));
      draw();
    }

    const resize = new ResizeObserver(() => draw());
    resize.observe(canvas);
    const visibility = () => { previous = null; };
    document.addEventListener("visibilitychange", visibility);
    draw();
    if (options.autoplay && !reducedStill) play();
    return {
      play, pause, seek,
      get duration() { refreshLayout(); return total; },
      reset: () => seek(0),
      get time() { return elapsed; },
      get playing() { return playing; },
      destroy() {
        pause();
        destroyed = true;
        resize.disconnect();
        document.removeEventListener("visibilitychange", visibility);
        context.clearRect(0, 0, canvas.width, canvas.height);
      },
    };
  }

  const api = Object.freeze({ mount, sample, duration, timing, configuration, defaults });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Minotaur = api;
})(globalThis);
