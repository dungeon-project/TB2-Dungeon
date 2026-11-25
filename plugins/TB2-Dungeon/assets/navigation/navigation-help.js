/** Adds presentation methods to the existing manager; no second navigation state. */
(() => {
class NavigationHelpMethods {
    /** First visit opens the map with a short guide; dismissal records completion locally. */
    showStartupGuide() {
        if (window.CoreFlasherStartup.read('welcome-seen')) return;
        this.openNavigationMap();
        const guide = document.createElement('dialog');
        guide.className = 'tb2-figure-dialog navigation-guide';
        guide.setAttribute('aria-labelledby', 'navigation-guide-title');
        guide.style.width = 'min(440px, 90vw)';
        guide.innerHTML = '<h2 id="navigation-guide-title" class="text-xl font-bold mb-3">Find your way</h2><p class="mb-3">Use the arrow keys or the bottom navigation buttons to move between cards. At the center, Up and Down move between the available areas. The bottom buttons name your next destination. Space moves one area at a time, reversing direction at the top and bottom.</p><p class="mb-3">Press M to open the map. Click a map card to explore while keeping the map open, or select a list entry to travel there and close it. M or Escape closes the map.</p><p class="mb-3">The red dot marks your location; a dashed outline marks your destination. Map travel follows the elevator route at a faster pace. Press H for all keyboard shortcuts. Shift + I opens Image Manager in the TeddyCloud plugin. Letter badges beside card titles show direct navigation keys. You can disable card shortcuts in Documentation; M, H, arrows and Space remain available. Keyboard shortcuts stay inactive while you type.</p><button type="button">Got it</button>';
        guide.querySelector('button').addEventListener('click', () => guide.close());
        // Area names follow the installed rooms, not the complete distribution's layout.
        const areas = TileManager.layerOrder.map(layer => this.areaName(layer)).join(', ');
        const introduction = guide.querySelector('p');
        introduction.textContent = introduction.textContent.replace('Documentation, Interfaces, Box Settings, Box Tools and Image Actions',areas);
        guide.addEventListener('close', () => {
            window.CoreFlasherStartup.write('welcome-seen', true);
            guide.remove();
            this.navigationMap?.querySelector('[aria-current]')?.focus();
        }, {once:true});
        document.body.appendChild(guide); guide.showModal();
    }

    /** A standalone help dialog, or an in-place help panel inside the already modal map. */
    toggleShortcutHelp() {
        if (this.shortcutHelp) { this.shortcutHelp.close(); return; }
        if (this.transition || this.routeTravel || document.querySelector('dialog[open]:not(.navigation-map), [role="dialog"][aria-modal="true"]:not(.navigation-map)')) return;
        const previousFocus = document.activeElement, map = this.navigationMap;
        const panel = document.createElement(map?.open ? 'section' : 'dialog');
        panel.className = 'shortcut-help';
        panel.setAttribute('aria-labelledby', 'shortcut-help-title');
        panel.innerHTML = '<h2 id="shortcut-help-title">Keyboard shortcuts</h2><p>No device actions. H / Esc to close.</p><dl></dl><p class="shortcut-help-state"></p><button type="button" class="layer-link"></button>';
        const refresh = () => {
            panel.querySelector('dl').replaceChildren();
            const entries = Object.entries(TileManager.cardShortcuts).filter(([key]) => this.shortcutTarget(key))
                .map(([key]) => [key.toUpperCase(), this.cardTitle(this.shortcutTarget(key))]);
            if (this.cardShortcutsEnabled) entries.push(['Shift + I', 'Image Manager (TeddyCloud)']);
            entries.push(['M', 'Navigation Map'], ['H', 'Keyboard shortcuts'], ['Arrow keys', 'Move to the neighboring card or area'], ['Space', 'Move between areas; reverse at either end']);
            for (const [key, title] of entries) {
                const term = document.createElement('dt'), name = document.createElement('dd');
                const badge = document.createElement('kbd'); badge.textContent = key;
                term.appendChild(badge); name.textContent = title; panel.querySelector('dl').append(term, name);
            }
            panel.querySelector('.shortcut-help-state').textContent = this.cardShortcutsEnabled
                ? 'Card shortcuts are enabled. Change this in Documentation.'
                : 'Card shortcuts are disabled. M, H, arrow keys and Space remain available.';
        };
        refresh();
        const button = panel.querySelector('button'); button.textContent = map?.open ? 'Back to map' : 'Close';
        // Reuse the existing modal rather than stacking another dialog above the map.
        const mapBody = map?.querySelector('.navigation-map-body');
        if (map?.open) { mapBody.hidden = true; map.appendChild(panel); }
        else { document.body.appendChild(panel); panel.showModal(); }
        const close = () => {
            if (mapBody) mapBody.hidden = false;
            panel.remove(); this.shortcutHelp = null;
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        };
        this.shortcutHelp = { close, refresh };
        button.addEventListener('click', close);
        panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
        const heading = panel.querySelector('h2');
        heading.tabIndex = -1; heading.focus({ preventScroll: true }); panel.scrollTop = 0;
    }

    /** Resolve only visible destinations; disabled actions do not disable navigation. */
    shortcutTarget(key) {
        const tile = this.tiles.find(candidate => candidate.element.id === TileManager.cardShortcuts[key]);
        return tile && this.isTileVisible(tile) ? tile : null;
    }

    /** CSS-generated badge text preserves existing title and sorting textContent consumers. */
    addShortcutBadge(element, id) {
        element.querySelector('.card-shortcut')?.remove();
        element.removeAttribute('aria-keyshortcuts');
        const key = Object.keys(TileManager.cardShortcuts).find(key => TileManager.cardShortcuts[key] === id);
        if (!this.cardShortcutsEnabled || !key || !this.shortcutTarget(key)) return;
        const badge = document.createElement('kbd');
        badge.className = 'card-shortcut'; badge.dataset.key = key.toUpperCase();
        badge.setAttribute('aria-hidden', 'true');
        element.appendChild(badge); element.setAttribute('aria-keyshortcuts', key.toUpperCase());
    }

    /** Apply the preference immediately without rebuilding cards or navigation state. */
    updateShortcutBadges() {
        for (const tile of this.tiles) {
            const heading = tile.element.querySelector('h1,h2');
            if (heading) this.addShortcutBadge(heading, tile.element.id);
        }
        this.refreshNavigationMap?.();
    }

}

// Copy method descriptors without introducing an extra controller or constructor.
const descriptors = Object.getOwnPropertyDescriptors(NavigationHelpMethods.prototype);
delete descriptors.constructor;
Object.defineProperties(TileManager.prototype, descriptors);
})();
