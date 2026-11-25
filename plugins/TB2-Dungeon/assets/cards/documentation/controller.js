/* Documentation controller. Shared services are supplied by the card context. */
(() => {
// === Documentation and application-scoped reset ===

class CardController extends Tile {

    /** Reset only this app's data; never clear storage for the entire origin. */
    init() {
        const skip = this.element.querySelector('.js-skip-documentation');
        skip.checked = window.CoreFlasherStartup.read('skip-documentation');
        skip.addEventListener('click', event => event.stopPropagation());
        skip.addEventListener('change', () => {
            const saved = window.CoreFlasherStartup.write('skip-documentation', skip.checked);
            this.element.querySelector('.js-startup-status').textContent = saved ? '' : 'This browser cannot save startup preferences.';
            if (!saved) skip.checked = false;
        });
        const shortcuts = this.element.querySelector('.js-card-shortcuts');
        shortcuts.checked = !window.CoreFlasherStartup.read('card-shortcuts-disabled');
        shortcuts.addEventListener('click', event => event.stopPropagation());
        shortcuts.addEventListener('change', () => {
            const saved = window.CoreFlasherStartup.write('card-shortcuts-disabled', !shortcuts.checked);
            if (!saved) shortcuts.checked = this.tileManager.cardShortcutsEnabled;
            this.tileManager.cardShortcutsEnabled = shortcuts.checked;
            this.tileManager.updateShortcutBadges();
            this.element.querySelector('.js-startup-status').textContent = saved ? '' : 'This browser cannot save shortcut preferences.';
        });
        this.resetButton = this.element.querySelector('.js-reset-app');
        this.resetStatus = this.element.querySelector('.js-reset-status');
        this.resetButton.addEventListener('click', event => {event.stopPropagation();this.resetApp();});
        this._resetTimer = setInterval(() => {if (this.isFocused) this.update();}, 500);
    }
    /** Run after optional controllers initialize, so rejected packages have no stale guidance. */
    refreshInstalledHelp() {
        const guides = this.element.querySelector('.js-installed-extension-docs');
        guides.replaceChildren();
        for (const contribution of CoreFlasherApp.documentation || []) {
            if (!CoreFlasherApp.extensions.has(contribution.id)) continue;
            const section = document.createElement('section');
            section.dataset.extensionDoc = contribution.id;
            section.innerHTML = contribution.html;
            guides.append(section);
        }
        guides.hidden = !guides.childElementCount;
        const list = this.element.querySelector('.js-installed-areas');
        list.replaceChildren();
        for (const area of TileManager.layerOrder) {
            const row = document.createElement('li');
            row.textContent = `${this.tileManager.areaName(area)}: ` + this.tileManager.tiles
                .filter(card => card.definition.placement.layer === area || card.definition.placement.allowedLayers?.includes(area))
                .map(card => card.definition.title).join(', ') + '.';
            list.append(row);
        }
    }
    /** Do not abandon device I/O, file writes, active searches or open file pickers. */
    resetBlocked() {
        return CoreFlasherDumpUi.busy() || this.context.operations.resetBlocked();
    }
    update() {
        if (!this.resetButton) return;
        this.resetButton.disabled = !!this.operationRunning || !!this.resetBlocked();
        this.resetButton.title = this.resetButton.disabled ? 'Wait for running operations to finish.' : '';
    }
    /** Remove only cached requests for our explicit runtime files, including query variants. */
    async clearAppCache() {
        if (!window.caches) return;
        const current = new URL(window.location.href);
        const paths = new Set([current.pathname, ...[
            'index.html', ...(window.CoreFlasherApp?.runtimeFiles || []),
            'tc-image-storage.js','plugin-support.css','plugin-support.js'
        ].map(file => new URL(file, document.baseURI).pathname)]);
        // Shared cache containers can hold other applications: delete entries, not containers.
        for (const name of await window.caches.keys()) {
            const cache = await window.caches.open(name);
            for (const request of await cache.keys()) {
                const url = new URL(request.url);
                if (url.origin === current.origin && paths.has(url.pathname)) await cache.delete(request);
            }
        }
    }
    /** Close settled hardware handles before dropping local state and reloading the page. */
    async resetApp() {
        if (this.operationRunning || this.resetBlocked()) return;
        if (!window.confirm('Reset TB2 Dungeon?\n\nThis disconnects devices, discards the loaded image and all unsaved changes, and clears the saved UUID, search progress and preferences. Other apps and files on disk are unchanged.')) return;
        this.operationRunning = true;this.update();
        this.tileManager.canvas.inert = true;
        this.resetStatus.textContent = 'Disconnecting and resetting TB2 Dungeon…';
        try {
            this.context.usbPresence.stop();
            await this.context.hardware.disconnect();
            // Serial queries close their own reader/writer/port; the busy gate waits for that.
            await this.context.clearContentSessions();
            await this.clearAppCache();
            for (const key of [...this.context.uuid.storageKeys,
                FlipTdiClock.STORAGE_KEY, 'tb2_dev_mode', window.CoreFlasherStartup.key('welcome-seen'),
                window.CoreFlasherStartup.key('skip-documentation'), window.CoreFlasherStartup.key('card-shortcuts-disabled')]) {
                localStorage.removeItem(key);sessionStorage.removeItem(key);
            }
            // Reload clears in-memory images, drafts, directory handles and parser caches.
            const destination = new URL(window.location.href);
            destination.searchParams.delete('dev');destination.hash = '';
            window.location.replace(destination.href);
        } catch (error) {
            void this.context.usbPresence.start();
            this.resetStatus.textContent = `Reset stopped: ${error.message}`;
        } finally {
            this.operationRunning = false;this.tileManager.canvas.inert = false;this.update();
        }
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return false;
    }
}
CoreFlasherApp.cardControllers["tile-documentation"] = CardController;
})();
