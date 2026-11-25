/** Present the offline Overworld guide inside the shared Dungeon application. */
(() => {
    const GUIDE_PATH = 'assets/guide/index.html';
    const GUIDE_STYLE_PATH = 'assets/overworld-guide.css';
    const SUPPLEMENT_FILENAMES = Object.freeze([
        'flipper-zero-sop8-verkabelung.html',
        'flipper-zero-winusb-zadig.html',
        'raspberry-pi-pico-sop8-verkabelung.html',
        'esp32-c3-sop8-verkabelung.html',
        'esp32-c3-platinen.html',
    ]);
    const RETURN_SCENE_PATH = 'assets/return-scene.html';
    const ENTRANCE_HASH = '#enter-the-dungeon';
    const SKIP_PREFERENCE = 'skip-overworld';
    const TC_LANGUAGE_KEY = 'i18nextLng';
    const RETURN_DARKEN_MS = 800;
    const RETURN_FIRE_FADE_MS = 300;
    const interfaceSources = Object.freeze({image:'disk', flipper:'fliptdi', pico:'pico', esp:'esp32c3'});
    const returnBackText = Object.freeze({de:'Zurück zur Overworld', en:'Back to Overworld',
        fr:'Retour à l’Overworld', es:'Volver a Overworld'});
    const preferenceText = {
        de: {label:'Overworld künftig überspringen', error:'Diese Browser-Einstellung konnte nicht gespeichert werden.'},
        en: {label:'Skip Overworld on future visits', error:'This browser cannot save startup preferences.'},
        fr: {label:"Ignorer l’Overworld lors des prochaines visites", error:'Ce navigateur ne peut pas enregistrer ce choix.'},
        es: {label:'Omitir Overworld en futuras visitas', error:'Este navegador no puede guardar esta preferencia.'},
    };
    let context, dialog, frame, errorPanel, errorMessage, recovery, guideDocument;
    let preferenceInput, preferenceLabel, preferenceStatus;
    let frameSourceObserver, pendingOpenFrame, returnTimer;
    let warnedLanguageStorage = false;

    /** TeddyCloud caches its i18next language on the shared plugin origin. */
    function supportedLanguage(value) {
        const language = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_]/, 1)[0] : '';
        return Object.hasOwn(preferenceText, language) ? language : 'en';
    }

    function teddyCloudLanguage() {
        try { return supportedLanguage(localStorage.getItem(TC_LANGUAGE_KEY)); }
        catch (error) {
            if (!warnedLanguageStorage) {
                console.warn('TeddyCloud language preference is unavailable; using English.', error);
                warnedLanguageStorage = true;
            }
            return 'en';
        }
    }

    /** A TC language change in another same-origin frame also updates an open guide. */
    function onTeddyCloudLanguageChange(event) {
        if (event.key !== TC_LANGUAGE_KEY || !dialog?.open || !guideDocument) return;
        const language = supportedLanguage(event.newValue);
        const selectedLanguage = guideDocument.querySelector('.language-switcher [aria-pressed="true"]')?.dataset.lang ||
            guideDocument.documentElement.lang;
        if (selectedLanguage === language) return;
        if (guideDocument.querySelector('#dungeon-return')) setReturnLanguage(language);
        else guideDocument.querySelector(`.language-switcher [data-lang="${language}"]`)?.click();
    }

    /** The guide owns its visuals; the base remains the only owner of interface state. */
    function openInterface(source) {
        dialog.close();
        void context.entry.openInterface();
        if (!source) return;
        const button = document.querySelector(`#tile-interface .js-source-btn[data-source="${source}"]`);
        if (!button) throw new Error(`Interface source button is missing: ${source}`);
        button.click();
    }

    function onGuideClick(event) {
        const returnScene = guideDocument.querySelector('#dungeon-return');
        if (returnScene) {
            const scene = guideDocument.querySelector('#dungeon-scene');
            if (scene.dataset.phase !== 'ready') { finishReturnAnimation(); return; }
            const language = event.target.closest?.('[data-lang]')?.dataset.lang;
            if (language) { setReturnLanguage(language); return; }
            if (event.target.closest?.('.dungeon-back')) showGuide();
            return;
        }
        const item = event.target.closest?.('#dungeon-scene[data-phase="ready"] .dungeon-item');
        if (item) openInterface(interfaceSources[item.dataset.device]);
    }

    function onReturnKeydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); showGuide(); }
        else if (['Enter', ' '].includes(event.key) &&
            guideDocument.querySelector('#dungeon-scene')?.dataset.phase !== 'ready') {
            event.preventDefault();
            finishReturnAnimation();
        }
    }

    function onRecoveryClick() { openInterface(); }

    /** Keep the mandatory visual route through the Dungeon entrance. */
    function onCancel(event) { event.preventDefault(); }

    function updatePreferenceLabel() {
        const text = preferenceText[guideDocument.documentElement.lang] || preferenceText.en;
        preferenceLabel.textContent = text.label;
        if (preferenceStatus.textContent) preferenceStatus.textContent = text.error;
    }

    function onPreferenceChange() {
        const saved = context.settings.preferences.write(SKIP_PREFERENCE, preferenceInput.checked);
        if (!saved) {
            preferenceInput.checked = !preferenceInput.checked;
            preferenceStatus.textContent = (preferenceText[guideDocument.documentElement.lang] || preferenceText.en).error;
        } else preferenceStatus.textContent = '';
    }

    /** Add the opt-in control to the source scene without changing the copied export. */
    function mountPreference() {
        const controls = guideDocument.querySelector('#dungeon-scene .dungeon-controls');
        const label = guideDocument.createElement('label');
        label.className = 'dungeon-skip-label';
        preferenceInput = guideDocument.createElement('input');
        preferenceInput.type = 'checkbox';
        preferenceInput.checked = context.settings.preferences.read(SKIP_PREFERENCE);
        preferenceLabel = guideDocument.createElement('span');
        preferenceStatus = guideDocument.createElement('span');
        preferenceStatus.className = 'dungeon-skip-status';
        preferenceStatus.setAttribute('role', 'status');
        label.append(preferenceInput, preferenceLabel, preferenceStatus);
        controls.insertBefore(label, controls.querySelector('.language-switcher'));
        preferenceInput.addEventListener('change', onPreferenceChange);
        guideDocument.addEventListener('tb2:languagechange', updatePreferenceLabel);
        updatePreferenceLabel();
        const stylesheet = guideDocument.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = CoreFlasherApp.extensions.asset('overworld', GUIDE_STYLE_PATH);
        guideDocument.head.append(stylesheet);
    }

    function unbindGuide() {
        clearTimeout(returnTimer);
        returnTimer = null;
        guideDocument?.removeEventListener('click', onGuideClick);
        guideDocument?.removeEventListener('tb2:languagechange', updatePreferenceLabel);
        guideDocument?.removeEventListener('keydown', onReturnKeydown);
        preferenceInput?.removeEventListener('change', onPreferenceChange);
        preferenceInput = preferenceLabel = preferenceStatus = null;
    }

    /** The base changes the provisional blank frame hash when entering from Documentation. */
    function onFrameSourceChange() {
        if (!dialog.open || new URL(frame.src).hash !== ENTRANCE_HASH) return;
        dialog.classList.add('dungeon-overworld--returning', 'dungeon-overworld--entrance-loading');
        cancelAnimationFrame(pendingOpenFrame);
        pendingOpenFrame = null;
        frame.src = CoreFlasherApp.extensions.asset('overworld', RETURN_SCENE_PATH);
    }

    /** Load the full guide only after the visitor leaves the empty return cave. */
    function showGuide() {
        dialog.classList.add('dungeon-overworld--entrance-loading');
        const guideUrl = new URL(CoreFlasherApp.extensions.asset('overworld', GUIDE_PATH));
        guideUrl.searchParams.set('lang', guideDocument.documentElement.lang);
        frame.src = guideUrl.href;
    }

    function setReturnLanguage(language) {
        guideDocument.documentElement.lang = language;
        guideDocument.querySelector('.dungeon-back').textContent = returnBackText[language];
        for (const button of guideDocument.querySelectorAll('[data-lang]'))
            button.setAttribute('aria-pressed', String(button.dataset.lang === language));
        updatePreferenceLabel();
    }

    function finishReturnAnimation() {
        clearTimeout(returnTimer);
        returnTimer = null;
        const scene = guideDocument.querySelector('#dungeon-scene');
        scene.dataset.fire = 'visible';
        scene.dataset.phase = 'ready';
        scene.querySelector('.dungeon-controls').hidden = false;
    }

    /** The return page contains only fire and controls before its first paint. */
    function startReturnAnimation() {
        const scene = guideDocument.querySelector('#dungeon-scene');
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) finishReturnAnimation();
        else returnTimer = setTimeout(() => {
            scene.dataset.phase = 'fire';
            scene.dataset.fire = 'visible';
            returnTimer = setTimeout(finishReturnAnimation, RETURN_FIRE_FADE_MS);
        }, RETURN_DARKEN_MS);
        scene.focus({preventScroll: true});
    }

    /** Keep GitHub destinations outside the guide frame. */
    function openOutsideGuideLinks() {
        for (const link of guideDocument.querySelectorAll('a[href]')) {
            const destination = new URL(link.href);
            const github = destination.hostname === 'github.com' || destination.hostname.endsWith('.github.com');
            if (!github) continue;
            link.target = '_blank';
            link.relList.add('noopener', 'noreferrer');
        }
    }

    /** TC embeds the Dungeon window; the guide iframe exists in both display modes. */
    function hideEmbeddedLanguageSelectors() {
        if (window.self === window.top) return;
        for (const switcher of guideDocument.querySelectorAll('.language-switcher'))
            switcher.style.setProperty('display', 'none', 'important');
    }

    /** Rebind after local guide navigation, including bundled supplemental pages. */
    function onGuideLoad() {
        unbindGuide();
        guideDocument = frame.contentDocument;
        if (!dialog.open || frame.src.startsWith('about:blank')) return;
        const guideLoaded = guideDocument?.querySelector('#overworld');
        const returnLoaded = guideDocument?.querySelector('#dungeon-return');
        const supplementLoaded = guideDocument?.querySelector('#inhalt') &&
            SUPPLEMENT_FILENAMES.some(filename => guideDocument.location.pathname.endsWith(`/${filename}`));
        if (!guideLoaded && !returnLoaded && !supplementLoaded) {
            errorMessage.textContent = 'The Overworld guide could not be loaded. You can still choose an interface.';
            errorPanel.hidden = false;
            return;
        }
        guideDocument.addEventListener('click', onGuideClick);
        if (returnLoaded) guideDocument.addEventListener('keydown', onReturnKeydown);
        hideEmbeddedLanguageSelectors();
        openOutsideGuideLinks();
        if (guideLoaded || returnLoaded) mountPreference();
        if (returnLoaded) setReturnLanguage(teddyCloudLanguage());
        errorMessage.textContent = '';
        errorPanel.hidden = true;
        if (returnLoaded) startReturnAnimation();
        else dialog.classList.remove('dungeon-overworld--returning');
        dialog.classList.remove('dungeon-overworld--entrance-loading');
    }

    /** Unload the frame so scene timers stop when the entrance is dismissed. */
    function onClose() {
        // A queued close event from the previous opening must not unload a reopened guide.
        if (dialog.open) return;
        cancelAnimationFrame(pendingOpenFrame);
        pendingOpenFrame = null;
        unbindGuide();
        guideDocument = null;
        dialog.classList.remove('dungeon-overworld--returning', 'dungeon-overworld--entrance-loading');
        frame.src = 'about:blank';
    }

    function initialize(appContext) {
        context = appContext;
        dialog = document.createElement('dialog');
        dialog.className = 'dungeon-overworld';
        dialog.innerHTML = '<div class="dungeon-overworld__error" hidden><p data-guide-error role="alert"></p><button type="button" data-recovery>Open interface</button></div><iframe title="TB2 Dungeon Overworld guide"></iframe>';
        document.body.append(dialog);
        frame = dialog.querySelector('iframe');
        frameSourceObserver = new MutationObserver(onFrameSourceChange);
        frameSourceObserver.observe(frame, {attributes:true, attributeFilter:['src']});
        errorPanel = dialog.querySelector('.dungeon-overworld__error');
        errorMessage = dialog.querySelector('[data-guide-error]');
        recovery = dialog.querySelector('[data-recovery]');
        frame.addEventListener('load', onGuideLoad);
        dialog.addEventListener('close', onClose);
        dialog.addEventListener('cancel', onCancel);
        recovery.addEventListener('click', onRecoveryClick);
        window.addEventListener('storage', onTeddyCloudLanguageChange);
    }

    function open() {
        if (document.querySelector('dialog[open]')) return;
        const destination = new URL(location.href).searchParams.get('destination');
        if (context.settings.preferences.read(SKIP_PREFERENCE) && destination !== 'overworld') {
            // Bootstrap has already chosen Documentation or Interface from its own startup preference.
            return;
        }
        errorMessage.textContent = '';
        errorPanel.hidden = true;
        dialog.classList.remove('dungeon-overworld--returning', 'dungeon-overworld--entrance-loading');
        frame.src = 'about:blank';
        dialog.showModal();
        pendingOpenFrame = requestAnimationFrame(() => {
            pendingOpenFrame = null;
            if (dialog.open && !dialog.classList.contains('dungeon-overworld--returning')) {
                const guideUrl = new URL(CoreFlasherApp.extensions.asset('overworld', GUIDE_PATH));
                guideUrl.searchParams.set('lang', teddyCloudLanguage());
                frame.src = guideUrl.href;
            }
        });
    }

    function dispose() {
        cancelAnimationFrame(pendingOpenFrame);
        unbindGuide();
        frameSourceObserver?.disconnect();
        frame?.removeEventListener('load', onGuideLoad);
        dialog?.removeEventListener('close', onClose);
        dialog?.removeEventListener('cancel', onCancel);
        recovery?.removeEventListener('click', onRecoveryClick);
        window.removeEventListener('storage', onTeddyCloudLanguageChange);
        dialog?.remove();
        frameSourceObserver = frame = dialog = guideDocument = context = null;
    }

    CoreFlasherApp.overworld = {initialize, open, dispose};
})();
