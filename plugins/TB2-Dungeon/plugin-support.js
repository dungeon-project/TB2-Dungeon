/** TB2 Dungeon / TeddyCloud plugin 1.0.10.
 * Presentation adapter and optional, explicit image archive access; Canvas v1.0.10.
 */
(() => {
    'use strict';
    const PLUGIN_VERSION = '1.0.10';
    const CANVAS_VERSION = '1.0.10';
    const PRODUCT_LABEL = `TB2 Dungeon ${CANVAS_VERSION} · Plugin ${PLUGIN_VERSION}`;
    // The original Canvas bootstrap reads this existing key. An explicit child
    // query always takes precedence over a same-origin parent's query.
    try {
        const own = new URL(location.href).searchParams.get('dev');
        if (own !== '0' && own !== '1' && window.parent !== window) {
            const parent = new URL(window.parent.location.href);
            if (parent.origin === location.origin) {
                const flag = parent.searchParams.get('dev');
                if (flag === '1') localStorage.setItem('tb2_dev_mode', '1');
                if (flag === '0') localStorage.removeItem('tb2_dev_mode');
            }
        }
    } catch (_error) { /* No cross-origin parent or storage access is required. */ }

    /** Let CSS, not competing height writers, size this one same-origin iframe.
     * TeddyCloud may continue assigning a measured inline pixel height. A scoped
     * stylesheet wins the cascade without a MutationObserver rewriting that style
     * on every frame. The parent container remains the 100% height reference.
     */
    function installFrameHeightSync() {
        const attribute = 'data-core-flasher-height-owner';
        const owner = `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        let frame = null;
        let stylesheet = null;
        let previousAttribute = null;

        function detach() {
            stylesheet?.remove();
            stylesheet = null;
            if (frame?.getAttribute(attribute) === owner) {
                if (previousAttribute === null) frame.removeAttribute(attribute);
                else frame.setAttribute(attribute, previousAttribute);
            }
            frame = null;
            previousAttribute = null;
        }

        function attach() {
            let current = null;
            try { current = window.frameElement; }
            catch (_error) { /* Standalone/cross-origin: no parent access. */ }
            if (current === frame && stylesheet?.isConnected) return;
            detach();
            if (!current?.isConnected) return;
            try {
                const doc = current.ownerDocument;
                const style = doc.createElement('style');
                style.setAttribute('data-core-flasher-frame-style', owner);
                style.textContent = `iframe[${attribute}="${owner}"] {
                    height: 100% !important;
                    display: block !important;
                }`;
                frame = current;
                previousAttribute = frame.getAttribute(attribute);
                frame.setAttribute(attribute, owner);
                (doc.head || doc.documentElement).appendChild(style);
                stylesheet = style;
            } catch (_error) {
                detach();
            }
        }

        window.addEventListener('load', attach, { once: true });
        window.addEventListener('pageshow', attach);
        window.addEventListener('pagehide', detach);
        attach();
    }
    document.documentElement.classList.add('core-flasher-plugin-root');
    installFrameHeightSync();

    function manager() {
        try { return typeof tileManager === 'undefined' ? null : tileManager; }
        catch (_error) { return null; }
    }
    function sessionState() {
        const app = window.AppState || {};
        const m = manager();
        const tiles = m?.tiles || [];
        const reader = m?.getTileAt(-1, 0)?._flipTdiController;
        return {
            busy: !!(app.interfaceOpening || app.flipTdiBusy || app.flipTdiReadBusy ||
                app.flipTdiDumpBusy || app.flipTdiWriteBusy || reader?.busy ||
                tiles.some(t => t.operationRunning || t.packageBusy || t.loading || t._busy || t.app?.running)),
            connected: !!reader?.device?.opened,
            pending: !!window.interface?.writeBuffer?.some(s => s?.data?.length) ||
                tiles.some(t => t.dirty || t._dirty),
            image: !!window.interface
        };
    }
    function homeUrl() {
        let home = new URL('/web/', location.href);
        try {
            const parent = new URL(window.parent !== window
                ? window.parent.location.href : document.referrer || location.href);
            const prefix = parent.pathname.match(/^(.*\/web)(?:\/|$)/);
            if (parent.origin === location.origin && prefix) home = new URL(prefix[1] + '/', location.href);
        } catch (_error) { /* Standard same-origin TeddyCloud path remains. */ }
        return home.href;
    }
    function policyAllowsUsb() {
        const policy = document.permissionsPolicy || document.featurePolicy;
        try {
            if (!policy?.allowsFeature) return null;
            if (policy.features && !policy.features().includes('usb')) return null;
            return policy.allowsFeature('usb');
        } catch (_error) { return null; }
    }
    function start() {
        // Correct the visible product name without touching Canvas controllers,
        // existing DOM IDs or storage keys used by the application.
        document.title = PRODUCT_LABEL;
        const versionLabel = document.querySelector('.production-version');
        if (versionLabel) versionLabel.textContent = PRODUCT_LABEL;
        if (document.getElementById('tb2-plugin-toolbar')) return;
        const nav = document.createElement('nav');
        nav.id = 'tb2-plugin-toolbar';
        nav.setAttribute('aria-label', 'TeddyCloud plugin');
        nav.innerHTML = `
            <a class="tb2-plugin-home" target="_top">TeddyCloud</a>
            <a class="tb2-plugin-direct" target="_blank" rel="noopener noreferrer">Open separately</a>
            <details>
                <summary>Plugin help</summary>
                <div class="tb2-plugin-panel">
                    <h2>TB2 Dungeon · Canvas ${CANVAS_VERSION}</h2>
                    <p>Plugin ${PLUGIN_VERSION} contains the complete existing Canvas tool. Image Manager uploads images only after confirmation. Other certificate and device workflows remain local.</p>
                    <p class="tb2-plugin-notice" role="status"></p>
                    <p>Use a trusted HTTPS TeddyCloud address for USB, WebCrypto and WebGPU. The original Windows WinUSB/Zadig help is in Interface.</p>
                    <p>If the embedding policy blocks USB, disconnect the reader and use <strong>Open separately</strong>. It starts a new session: loaded images, edits and USB handles are not transferred.</p>
                    <p>Use <strong>Dump / Flash</strong> for backups, image export, Write Changes, Verify Flash and Flash Full Image. Loaded backups are labelled separately from matching device reads.</p>
                    <p>File Manager and WiFi Manager are available in the standard view. Settings and File Editor are available in the advanced view. The keyscanner selects a .crypt file automatically.</p>
                    <p>Dev view: <code>?dev=1</code>. Disable: <code>?dev=0</code>. The existing saved Dev flag remains supported.</p>
                    <p>Install the complete plugin folder, including its assets. Hardware compatibility requires verification on the connected device.</p>
                    <pre class="tb2-plugin-diagnostic" hidden></pre>
                    <button class="tb2-plugin-close" type="button">Close help</button>
                </div>
            </details>
            <section class="tb2-plugin-panel tb2-plugin-navigation-panel" hidden
                aria-labelledby="tb2-plugin-navigation-title">
                <h2 id="tb2-plugin-navigation-title"></h2>
                <p class="tb2-plugin-navigation-message" role="status"></p>
                <button class="tb2-plugin-navigation-close" type="button">Close</button>
            </section>`;
        document.body.appendChild(nav);
        const home = nav.querySelector('.tb2-plugin-home');
        const direct = nav.querySelector('.tb2-plugin-direct');
        const help = nav.querySelector('details');
        const summary = nav.querySelector('summary');
        const notice = nav.querySelector('.tb2-plugin-notice');
        const diagnostic = nav.querySelector('.tb2-plugin-diagnostic');
        const navigationPanel = nav.querySelector('.tb2-plugin-navigation-panel');
        const navigationTitle = nav.querySelector('#tb2-plugin-navigation-title');
        const navigationMessage = nav.querySelector('.tb2-plugin-navigation-message');
        const navigationClose = nav.querySelector('.tb2-plugin-navigation-close');
        let navigationTrigger = null;

        // Navigation warnings are independent of setup help. Neither opening nor
        // closing this notice changes the reader, pending edits or navigation guard.
        function closeNavigationNotice(restoreFocus = false) {
            const wasVisible = !navigationPanel.hidden;
            navigationPanel.hidden = true;
            navigationTitle.textContent = '';
            navigationMessage.textContent = '';
            if (restoreFocus && wasVisible) navigationTrigger?.focus({ preventScroll: true });
            navigationTrigger = null;
        }
        function showNavigationNotice(state, trigger) {
            help.open = false;
            navigationTrigger = trigger;
            navigationTitle.textContent = state.busy ? 'Operation in progress' : 'USB reader is connected';
            navigationMessage.textContent = state.busy
                ? 'Finish or stop the current operation before leaving or opening another session.'
                : 'Disconnect the USB reader before leaving or opening another session.';
            navigationPanel.hidden = false;
            navigationClose.focus({ preventScroll: true });
        }
        home.href = homeUrl();
        const directUrl = new URL(location.href);
        directUrl.hash = '';
        directUrl.searchParams.set('dev', window.DEV_MODE ? '1' : '0');
        direct.href = directUrl.href;
        function renderHelp() {
            const messages = [];
            const usbPolicy = policyAllowsUsb();
            if (!window.isSecureContext) {
                messages.push('This is not a secure context. Use trusted HTTPS before USB access, UUID search or cryptographic operations. A new tab does not fix HTTP.');
            } else if (usbPolicy === false) {
                messages.push('The embedding policy blocks WebUSB. The parent must permit USB, or open the plugin separately. This is not a Windows driver diagnosis.');
            } else if (!navigator.usb) {
                messages.push('WebUSB is unavailable in this browser/context. The existing disk tools remain present.');
            }
            try { localStorage.getItem('tb2_dev_mode'); }
            catch (_error) { messages.push('Browser storage is blocked; the existing UUID and Dev state need storage access.'); }
            try {
                const frame = window.frameElement;
                if (frame?.hasAttribute('sandbox')) {
                    const missing = ['allow-downloads', 'allow-modals'].filter(p => !frame.sandbox.contains(p));
                    if (missing.length) messages.push(`The iframe lacks ${missing.join(' and ')}. Downloads or confirmations may be blocked; open the plugin separately.`);
                }
            } catch (_error) { /* Cross-origin policies cannot be inspected. */ }
            notice.textContent = messages.join(' ');
            notice.hidden = messages.length === 0;
            summary.textContent = messages.length ? 'Plugin help · check setup' : 'Plugin help';
            diagnostic.hidden = !window.DEV_MODE;
            if (window.DEV_MODE) diagnostic.textContent = [
                `Frame: ${window.parent === window ? 'top-level' : 'embedded'}`,
                `Secure context: ${!!window.isSecureContext}`,
                `USB API: ${!!navigator.usb}; policy: ${usbPolicy === null ? 'not inspectable' : usbPolicy}`,
                `WebGPU API: ${!!navigator.gpu} (adapter not probed)`,
                `WebCrypto: ${!!window.crypto?.subtle}`
            ].join('\n');
        }
        function allowNavigation(event, separate) {
            const state = sessionState();
            if (state.busy || state.connected) {
                event.preventDefault();
                showNavigationNotice(state, event.currentTarget);
                return;
            }
            closeNavigationNotice();
            const warning = separate
                ? (state.image || state.pending ? 'The new tab starts without the current image or edits. The current tab stays open. Continue?' : '')
                : (state.pending ? 'Leave TB2 Dungeon? Buffered changes and unsaved editor drafts will be lost.' : '');
            if (warning && !window.confirm(warning)) event.preventDefault();
        }
        home.addEventListener('click', e => allowNavigation(e, false));
        direct.addEventListener('click', e => allowNavigation(e, true));
        summary.addEventListener('click', () => closeNavigationNotice());
        help.addEventListener('toggle', () => {
            if (help.open) { closeNavigationNotice(); renderHelp(); }
        });
        nav.querySelector('.tb2-plugin-close').addEventListener('click', () => { help.open = false; summary.focus(); });
        navigationClose.addEventListener('click', () => closeNavigationNotice(true));
        nav.addEventListener('keydown', e => {
            // The original Canvas handler refocuses views: keep toolbar keys out of it.
            e.stopPropagation();
            if (e.key === 'Escape') {
                if (!navigationPanel.hidden) closeNavigationNotice(true);
                else if (help.open) { help.open = false; summary.focus(); }
            }
        });
        renderHelp();

        // Only an actual viewport change requires recentering. In particular,
        // scrollbar/attention/border changes inside tiles are not resize triggers.
        // Never call moveTo()/focus(): that could reload an open editor.
        let scheduled = 0;
        let observer = null;
        let attached = false;
        let lastWidth = -1;
        let lastHeight = -1;
        const viewport = document.querySelector('.viewport');

        function recenter() {
            if (scheduled) return;
            scheduled = requestAnimationFrame(() => {
                scheduled = 0;
                const width = window.innerWidth;
                const height = window.innerHeight;
                if (width === lastWidth && height === lastHeight) return;
                const m = manager();
                const el = m?.getTileAt(m.currentX, m.currentY)?.element;
                if (!m?.canvas || !el || !width || !height) return;
                lastWidth = width;
                lastHeight = height;
                // The upstream layer manager owns both depth and grid positioning.
                // Settle an interrupted transition and center without refocusing editors.
                if (m.transition) m.finishTransition(m.transition);
                const tile = m.getTileAt(m.currentX, m.currentY);
                if (tile) m.centerTile(tile, true);
            });
        }
        function detachViewport() {
            if (scheduled) cancelAnimationFrame(scheduled);
            scheduled = 0;
            observer?.disconnect();
            observer = null;
            window.removeEventListener('resize', recenter);
            attached = false;
        }
        function attachViewport() {
            if (attached) return;
            attached = true;
            lastWidth = lastHeight = -1;
            window.addEventListener('resize', recenter, { passive: true });
            if (viewport && typeof ResizeObserver === 'function') {
                observer = new ResizeObserver(recenter);
                observer.observe(viewport, { box: 'border-box' });
            }
            recenter();
        }
        window.addEventListener('pageshow', attachViewport);
        window.addEventListener('pagehide', detachViewport);
        attachViewport();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
    else start();
})();
