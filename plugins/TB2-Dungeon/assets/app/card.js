class Tile {

    /**
     * Initialize tile state, bind navigation, and invoke the subclass lifecycle hooks.
     * @param {HTMLElement} element
     */
    constructor(element, context = window.CoreFlasherApp?.context) {
        this.context = context;
        this._disposers = [];
        this.element = element;
        this.x = Number(element.dataset.x || 0);
        this.y = Number(element.dataset.y || 0);
        this.enabled = element.dataset.initial === 'true';
        this.completed = false;
        this.isFocused = false;
        this.tileManager = null;
        this._isBlinking = false;
        this._lastBroadcastCycle = -1;
        this._lastLoggedBlinkCycle = -1;
        this.listen(this.element, 'click', () => {
            if (this.tileManager) {
                this.tileManager.navigateUser(this.x, this.y);
            }
        });
        // The registry initializes cards only after every controller is attached.
    }

    /** Initialize this card once after registration, without starting device work. */
    initialize() {
        if (this._initialized) return;
        this._initialized = true;
        this.init();
        this.updateStyles();
    }

    /** Bind a listener with explicit ownership, including document/window listeners. */
    listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this.own(() => target.removeEventListener(type, handler, options));
        return handler;
    }

    /** Register cleanup owned by this card, never by an active device operation. */
    own(dispose) { this._disposers.push(dispose); return dispose; }
    onEnter() { this.focus(); }
    onLeave() { this.blur(); }
    async reset() {}
    dispose() {
        for (const dispose of this._disposers.splice(0).reverse()) dispose();
        for (const timer of ['_resetTimer', '_statusTimer', '_syncTimer', '_infoTimer', '_refreshTimer']) {
            if (this[timer]) clearInterval(this[timer]);
            this[timer] = null;
        }
    }

    /** Attach the coordinator without triggering an update. */
    setManager(tileManager) {
        this.tileManager = tileManager;
    }

    /**
     * Retain the base no-op initialization hook for subclasses.
     * @returns {void}
     */
    init() {
    }

    /**
     * Return the tile's current enabled flag.
     * @returns {boolean}
     */
    isEnabled() {
        return this.element.dataset.requiresSource ? this.sourceAllowed() : this.enabled;
    }

    /** Admit ready hardware or a complete local image, including snapshots retained after disconnect. */
    sourceAllowed() {
        const requirement = this.element.dataset.requiresSource;
        if (!requirement || requirement === 'alternative') return true;
        const state = window.AppState || {};
        const active = !state.interfaceOpening && (
            CoreFlasherDumpUi.complete(window.interface) ||
            (['fliptdi', 'pico', 'esp32c3'].includes(state.sourceInterface) && !!state.flipTdiReady && !state.flipTdiFault));
        return active;
    }

    /**
     * Enable this tile, invoke its update hook, then refresh presentation.
     * @returns {void}
     */
    enable() {
        this.enabled = true;
        this.update();
        this.updateStyles();
    }

    /**
     * Clear the enabled flag and update presentation classes.
     * @returns {void}
     */
    disable() {
        this.enabled = false;
        this.updateStyles();
    }

    /**
     * Retain the base no-op shared-state update hook for subclasses.
     * @returns {void}
     */
    update() {
    }

    /**
     * Set focus and update presentation classes.
     * @returns {void}
     */
    focus() {
        this.isFocused = true;
        this.updateStyles();
    }

    /**
     * Clear focus and update presentation classes.
     * @returns {void}
     */
    blur() {
        this.isFocused = false;
        this.updateStyles();
    }

    /**
     * Apply state classes and emit attention diagnostics once per broadcast cycle.
     * @returns {void}
     */
    updateStyles() {
        if (this.element.dataset.requiresSource) {
            this.enabled = this.sourceAllowed();
            // Keep the card shell navigable while its controls remain unavailable.
            this.element.inert = false;
            for (const child of this.element.children) child.inert = !this.enabled;
            this.element.setAttribute('aria-disabled', String(!this.enabled));
        }
        const shouldFlash = this.enabled && !this.isFocused && this.isFlashing();
        this.element.classList.remove('tile-disabled', 'tile-enabled', 'tile-focused', 'tile-ready',
            'flash-activity');
        if (!this.enabled) {
            this.element.classList.add('tile-disabled');
            if (this.isFocused) this.element.classList.add('tile-focused');
        }
        else if (this.isFocused) {
            this.element.classList.add('tile-focused');
        }
        else if (shouldFlash) {
            this.element.classList.add('tile-enabled');
        }
        else {
            this.element.classList.add('tile-ready');
        }
        if (shouldFlash && !this._isBlinking
            && this._lastLoggedBlinkCycle !== this._lastBroadcastCycle) {
            const tileId = (this.element && this.element.id)
                ? this.element.id : `tile@(${this.x},${this.y})`;
            const reason = (typeof this.getBlinkReason === 'function')
                ? this.getBlinkReason() : 'no reason provided';
            console.info(`[TileBlink] ${tileId} started blinking: ${reason}`);
            this._lastLoggedBlinkCycle = this._lastBroadcastCycle;
        }
        this._isBlinking = shouldFlash;
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return false;
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        return 'generic blinking condition';
    }

    /**
     * Apply the warning class for the existing 1500 ms duration.
     * @returns {void}
     */
    flashWarning() {
        this.element.classList.add('flash-warning');
        setTimeout(() => this.element.classList.remove('flash-warning'), 1500);
    }

    /**
     * Apply the activity class for the existing 1500 ms duration.
     * @returns {void}
     */
    flashActivity() {
        this.element.classList.add('flash-activity');
        setTimeout(() => this.element.classList.remove('flash-activity'), 1500);
    }

    /**
     * Mark completion, show activity, and notify the attached coordinator.
     * @returns {void}
     */
    complete() {
        this.completed = true;
        this.flashActivity();
        if (this.tileManager) {
            this.tileManager.onStepComplete(this);
        }
    }
}
