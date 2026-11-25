/** Named application ports. Providers retain ownership of all existing state. */
class AppContext {
    constructor(registry) {
        this.registry = registry;
        this.manager = null;
        this.listeners = new Map();
        const lifecycle = ['isEnabled', 'enable', 'disable', 'update', 'updateStyles'];
        this.filesystem = this.port('tile-file-manager', [...lifecycle,
            'hexToBytes', 'decryptCryptBlob', 'encryptPlainAsCryptBlob', 'deriveKeyHkdf',
            'parseBlob', 'decryptAesCbcRaw', 'validateZeroPadding',
            'selectSettingsForEditor', 'refreshExplorer', 'downloadBytes']);
        this.settings = this.port('tile-settings-editor', [...lifecycle,
            'parseSettingsBuffer', 'serializeRecords']);
        this.settings.preferences = {
            read: name => window.CoreFlasherStartup.read(name),
            write: (name, enabled) => window.CoreFlasherStartup.write(name, enabled),
        };
        this.uuid = new DungeonUuidService(this);

        this.image = this.port('tile-interface', {
            readUuid: 'readLocalImageUuid', exportCurrent: '_exportCurrentImage', publish: '_publishImage', loadArchive: '_loadArchiveImage',
        });
        this.image.setEditMode = mode => this.provider('tile-interface-options')?.setEditMode(mode);
        // Cards retain their drafts; image replacement is the shared discard decision.
        this.image.confirmReplace = () => {
            const dirty = window.interface?.writeBuffer?.some(segment => segment.data?.length) ||
                this.manager?.tiles.some(card => card.hasDraft?.());
            return !dirty || window.confirm('Replace the working image? Unapplied drafts and buffered changes will be discarded.');
        };
        Object.defineProperty(this.image, 'current', { get: () => window.interface });
        this.hardware = this.port('tile-interface', { refresh: '_refreshFlipTdiUi', refreshBoxRecognition: 'refreshBoxRecognition' });
        Object.defineProperty(this.hardware, 'serprogConnected', {
            get: () => !!this.provider('tile-interface')?._serprogController?.port,
        });
        this.hardware.disconnect = async () => {
            const controller = this.provider('tile-interface');
            for (const transport of [controller?._flipTdiController, controller?._serprogController]) {
                if (transport?.device || transport?.port || transport?.fault) await transport.disconnect();
            }
        };

        // Different callers intentionally use different busy gates; preserve those exact predicates.
        this.operations = {
            busy: () => window.CoreFlasherDumpUi.busy(),
            refreshMode: () => this.provider('tile-interface-options')?._updateModeUI?.(),
            refreshDiagnostic: () => this.provider('tile-boot-image')?.update(),
            refreshUsbUuid: () => this.provider('tile-firmware-0408')?.update(),
            fullFlashStarted: () => this.provider('tile-boot-image')?.fullFlashStarted?.(),
            fullFlashVerified: hash => this.provider('tile-boot-image')?.fullFlashVerified?.(hash),
            resetBlocked: () => this.uuid.searchBusy || this.manager?.tiles.some(card => card.operationRunning || card.packageBusy ||
                card._busy || card.loading || card._isOpening || card.picking || card.app?.running),
            otherCardBusy: excluded => this.manager?.tiles.some(card => card !== excluded &&
                (card.operationRunning || card.packageBusy || card._busy || card.loading || card._isOpening)),
            beginImageEdit: (card, image, assertSelection = null) => {
                if (this.operations.busy() || this.operations.otherCardBusy(card)) throw new Error('Another image operation is running.');
                const revision = window.AppState.interfaceRevision, uuidRevision = this.uuid.revision;
                const validate = () => {
                    if (image !== this.image.current || revision !== window.AppState.interfaceRevision ||
                        uuidRevision !== this.uuid.revision || image.readOnly || window.AppState.interfaceMode !== 'rw-buffered') {
                        throw new Error('The image, edit permission or UUID changed. Reload before saving.');
                    }
                    assertSelection?.();
                };
                validate();
                const lease = image.acquireOperation('edit', validate);
                const wasRunning = card.operationRunning;
                card.operationRunning = true;
                const release = lease.release;
                let active = true;
                lease.release = () => {
                    if (active) { active = false; release(); card.operationRunning = wasRunning; }
                };
                return lease;
            },
        };
        Object.defineProperty(this.operations, 'usbQueryActive', {
            get: () => this.provider('tile-firmware-0408')?.usbQueryAbort,
        });
        this.navigation = {
            editor: this.port('tile-file-editor', lifecycle),
            mitm: this.port('tile-mitm-setup', lifecycle),
            moveTo: (x, y) => this.manager?.moveTo(x, y),
            moveToCard: id => {
                const card = this.provider(id);
                if (!card) return window.CoreFlasherApp.extensions.showOverview();
                return this.manager.startCardTravel(card, this.manager.layerFor(card));
            },
        };
        this.dialogs = { confirm: message => window.confirm(message) };
        this.identity = new BoxIdentityService(this);
        this.entry = new DungeonEntryService(this);
        this.usbPresence = new Tb2UsbPresence({serial: navigator.serial, secureContext: window.isSecureContext,
            onChange: () => this.manager?.refreshUsbTools()});
        this.usbPresence.report = message => this.manager?.showUsbToolStatus(message);
        this.services = Object.fromEntries(['image', 'filesystem', 'hardware', 'operations', 'uuid', 'identity',
            'navigation', 'settings', 'dialogs', 'usbPresence', 'entry'].map(name => [name, this[name]]));
    }

    /** Attach after construction and before initialization, so every provider is discoverable. */
    attach(manager) { this.manager = manager; }

    /** Subscribe without owning state; register the returned cleanup with the card's own(). */
    subscribe(event, listener) {
        if (typeof listener !== 'function') throw new TypeError('A context listener must be a function.');
        const listeners = this.listeners.get(event) || new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) this.listeners.delete(event);
        };
    }

    /** Notify in registration order; failures stay visible to the caller. */
    emit(event, detail) {
        for (const listener of [...(this.listeners.get(event) || [])]) listener(detail);
    }

    dispose() {
        window.CoreFlasherApp?.overworld?.dispose();
        this.usbPresence.dispose(); this.listeners.clear(); this.manager = null;
    }

    /** Controller lookup is confined to this bridge; consumers receive only explicit ports. */
    provider(id) {
        if (this.manager?.cardsInitializing) return undefined;
        return this.registry?.instances?.get(id) || this.manager?.tiles?.find(card => card.element?.id === id);
    }

    /** Resolve methods lazily because lifecycle initialization may install them on the instance. */
    port(id, methods) {
        const port = {};
        const mapping = Array.isArray(methods) ? Object.fromEntries(methods.map(name => [name, name])) : methods;
        Object.defineProperty(port, 'available', { get: () => !!this.provider(id) });
        for (const [name, method] of Object.entries(mapping)) {
            Object.defineProperty(port, name, { get: () => {
                const controller = this.provider(id);
                return typeof controller?.[method] === 'function' ? controller[method].bind(controller) : undefined;
            } });
        }
        return port;
    }

    /** Dispose browser-owned content resources in the same card order used during reset. */
    async clearContentSessions() {
        for (const card of this.manager.tiles) {
            card.contentBrowser?.dispose();
            await card.contentBrowser?.catalog.clear();
        }
    }
}
CoreFlasherApp.AppContext = AppContext;
