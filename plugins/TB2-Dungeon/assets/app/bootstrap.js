/** Load local extensions in manifest order without evaluating controller source strings. */
var tileManager;
(() => {
    const application = window.CoreFlasherApp;
    const commonFiles = [
        'assets/app/uuid-service.js', 'assets/app/entry-service.js',
        'assets/uuid-search-record.js',
        'assets/app/usb-presence.js', 'assets/app/state.js', 'assets/app/card.js', 'assets/app/box-identity-service.js',
        'assets/navigation/navigation-manager.js', 'assets/navigation/map-layout.js',
        'assets/navigation/navigation-map.js', 'assets/navigation/navigation-help.js'
    ];
    const cardFiles = application.manifest.flatMap(card => card.files);
    const existingResources = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
        .map(element => element.getAttribute('src') || element.getAttribute('href'))
        .filter(resource => new URL(resource, document.baseURI).origin === location.origin);
    // Lazy card media belongs to reset's resource inventory, not the startup loader.
    const cardAssets = application.manifest.flatMap(card => [...(card.assets || []), ...(card.retiredAssets || [])]);
    application.runtimeFiles = [...existingResources, ...commonFiles, ...cardFiles, ...cardAssets,
        'assets/app/card-registry.js', 'assets/app/card-manifest.js',
        'assets/app/app-context.js', 'assets/app/bootstrap.js'];

    /** Insert every script before load completes; async=false preserves dependency order. */
    function loadResource(path) {
        return new Promise((resolve, reject) => {
            const stylesheet = path.endsWith('.css');
            const resource = document.createElement(stylesheet ? 'link' : 'script');
            if (stylesheet) { resource.rel = 'stylesheet'; resource.href = path; }
            else { resource.async = false; resource.src = path; }
            resource.onload = resolve;
            resource.onerror = () => reject(new Error(`Required application file could not be loaded: ${path}`));
            document.head.appendChild(resource);
        });
    }

    application.ready = Promise.all([...commonFiles, ...cardFiles].map(loadResource)).then(async () => {
        // No card is mounted until all required definitions and services are available.
        application.context = new application.AppContext(application.registry);
        await application.extensions.load(application.context);
        const expectedIds = application.manifest.map(card => card.id);
        if (expectedIds.length !== application.registry.definitions.length ||
            expectedIds.some(id => !application.registry.get(id))) throw new Error('The card manifest is incomplete.');
        application.registry.validate(application.context);
        application.registry.mount(document.getElementById('mainCanvas'));
        tileManager = new TileManager();
        document.querySelectorAll('[data-image-manager]').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                tileManager.openImageManager(button.dataset.imageManager === 'save');
            });
        });

        // Preserve the original starting destination and start-enabled card ordering.
        const initialTile = window.CoreFlasherStartup.read('skip-documentation')
            ? tileManager.getTileAt(-1, 0) : tileManager.tiles.find(tile => tile.element.dataset.initial === 'true');
        tileManager.tiles.filter(tile => tile.element.dataset.startEnabled === 'true').forEach(tile => tile.enable());
        if (initialTile) { initialTile.enable(); tileManager.moveTo(initialTile.x, initialTile.y); }
        else tileManager.moveTo(0, 0);
        tileManager.refreshUsbTools();
        void application.context.usbPresence.bindLifecycle();
        application.context.entry.refresh();
        if (application.extensions.has('overworld')) {
            try { application.overworld.initialize(application.context); }
            catch (error) { application.extensions.disable('overworld',error); console.error('Overworld disabled:',error); }
        }
        application.extensions.mountOverview(document.querySelector('#tile-interface > div'));
        application.registry.instances.get('tile-documentation').refreshInstalledHelp();
        const requested = new URL(location.href).searchParams.get('destination');
        // An installed entrance takes precedence over every bookmark and startup preference.
        // Missing or failed optional packages still leave the ordinary Dungeon usable.
        if (application.extensions.has('overworld')) application.overworld.open();
        else if (requested && application.registry.instances.has(requested)) {
            const target = application.registry.instances.get(requested);
            if (tileManager.isTileVisible(target)) await tileManager.startCardTravel(target, tileManager.layerFor(target));
        } else tileManager.showStartupGuide();
        return tileManager;
    });
    application.ready.catch(error => {
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = `TB2 Dungeon could not start. ${error.message}`;
        document.getElementById('mainCanvas').replaceChildren(message);
        console.error('TB2 Dungeon startup failed:', error);
    });
})();
