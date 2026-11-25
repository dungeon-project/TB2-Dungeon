/* Interface controller. Shared services are supplied by the card context. */
(() => {
// === Source interface: file picker -> SparseImage -> image export ===

class CardController extends Tile {

    /** Keep unsupported readers disabled across opening and USB status updates.
     * @param {boolean} busy Whether source changes are temporarily blocked.
     */
    updateSourceButtons(busy) {
        const insecure = !window.isSecureContext;
        this.element.querySelector('.js-secure-context-help')?.classList.toggle('hidden', !insecure);
        this.element.querySelectorAll('.js-source-btn').forEach(button => {
            button.disabled = button.dataset.unavailable === 'true' || busy || (insecure && button.dataset.source !== 'disk');
        });
    }

    /** Update hardware identification after an explicit archive assignment. */
    refreshBoxRecognition(profile, applyUuid = true) {
        const recognition = this.boxRecognition;
        if (!profile || profile.flashChipId === recognition?.chipId || profile.id === recognition?.state.box?.id)
            recognition?.update(window.AppState.hardwareController, true, applyUuid);
    }

    /**
     * Initialize component fields, event handlers, and state synchronization.
     * @returns {void}
     */
    init() {
        // Without a scanner, the image archive owns key entry and box assignment.
        const uuidInput = this.element.querySelector('.js-dungeon-uuid');
        const uuidLoad = this.element.querySelector('.js-dungeon-uuid-load');
        const uuidSave = this.element.querySelector('.js-dungeon-uuid-save');
        const renderUuid = () => {
            const scannerInstalled = !!this.context.uuid.scanner;
            uuidInput.value = scannerInstalled ? this.context.uuid.currentInput : this.context.uuid.normalizedValue;
            const archive = typeof window.CoreFlasherImageStorage === 'function';
            uuidInput.disabled = !scannerInstalled || this.context.uuid.searchBusy;
            uuidSave.hidden = !scannerInstalled;
            uuidLoad.textContent = scannerInstalled ? 'Load UUID' : 'Open Image Manager';
            uuidLoad.disabled = !archive || this.context.uuid.searchBusy;
            uuidSave.disabled = uuidLoad.disabled || this.context.uuid.saveDisabled;
            this.element.querySelector('.js-dungeon-uuid-status').textContent = !scannerInstalled
                ? 'Without UUID Scanner, load a managed image or save this image in Image Manager, then save its box UUID in Box details. A standalone key cannot enable UUID-dependent tasks.' : archive
                ? 'Uses the shared active key. Saving changes box details only.'
                : 'Manual entry is available. Saved box UUIDs require the TeddyCloud plugin.';
        };
        this.listen(uuidInput,'input',()=>{if (this.context.uuid.scanner) this.context.uuid.setSerialNumberField(uuidInput.value,true);});
        this.listen(uuidLoad,'click',event=>{event.stopPropagation();this.tileManager.openImageManager(this.context.uuid.scanner ? {uuidMode:'load'} : false);});
        this.listen(uuidSave,'click',event=>{event.stopPropagation();this.tileManager.openImageManager({uuidMode:'save',uuid:this.context.uuid.normalizedValue});});
        this.own(this.context.subscribe('uuid',renderUuid));
        this.own(this.context.subscribe('update',renderUuid));
        this.own(this.context.subscribe('identity',renderUuid));
        renderUuid();

        const identity = this.element.querySelector('.js-box-identity');
        this.boxRecognition = new FlashBoxRecognition({
            storage: () => window.CoreFlasherImageStorage?.(),
            sourceStamp: () => [this.context.uuid.revision, window.interface, window.AppState.interfaceRevision],
            canApplyUuid: () => !window.AppState.interfaceOpening,
            validateUuid: uuid => this.context.identity.validateUuid(window.interface, uuid),
            loadUuid: uuid => { this.context.uuid.resetSearch(true); this.context.uuid.setSerialNumberField(uuid, true); },
            render: state => {
                identity.hidden = !state.status;
                identity.querySelector('.js-box-status').textContent = state.status + (state.box?.boxSerialNumber ? ` · Serial: ${state.box.boxSerialNumber}` : '');
                identity.querySelector('.js-box-chip-id').textContent = state.chipId ? `Flash chip ID: ${state.chipId}` : '';
                const picture = identity.querySelector('.js-box-picture');
                picture.replaceChildren();
                if (state.box) picture.appendChild(ImageManagerDialog.boxPicture({ picture: state.picture }));
                const button = identity.querySelector('.js-assign-box');
                button.hidden = !state.chipId;
                button.disabled = !state.assignable || CoreFlasherDumpUi.busy();
                button.textContent = state.box ? 'Change assignment' : 'Assign to box';
            }
        });
        this.own(() => this.boxRecognition.reset());
        const imageIdentity = document.createElement('p'); imageIdentity.className = 'cf-muted js-image-box-identity';
        identity.after(imageIdentity);
        this.own(this.context.subscribe('identity', state => {
            imageIdentity.textContent = state.error || (state.box ? `Working image: ${state.box.name}` : state.observed?.boxSerialNumber ? `Working image serial: ${state.observed.boxSerialNumber} · Unassigned` : '');
        }));
        identity.querySelector('.js-assign-box').addEventListener('click', event => {
            event.stopPropagation();
            const state = this.boxRecognition.state;
            if (!state.assignable || CoreFlasherDumpUi.busy()) return;
            this.tileManager.openImageManager({ chipId: state.chipId, boxId: state.box?.id || '' });
        });
        const sourceButtons = this.element.querySelectorAll('.js-source-btn');
        const fileInput = this.element.querySelector('#flashdump-file-input');
        const configBlock = this.element.querySelector('.js-source-config');
        const configTitle = this.element.querySelector('.js-config-title');
        const infoLoadedEl = this.element.querySelector('.js-iface-info-loaded');
        const infoNameEl = this.element.querySelector('.js-iface-info-name');
        const infoSizeEl = this.element.querySelector('.js-iface-info-size');
        const infoPendingEl = this.element.querySelector('.js-iface-info-pending');
        const infoReadableEl = this.element.querySelector('.js-iface-info-readable');
        const saveImageBtn = this.element.querySelector('.js-interface-save-image-btn');
        const dirtyNoteEl = this.element.querySelector('.js-interface-dirty-note');
        const openingOverlayEl = this.element.querySelector('.js-interface-opening-overlay');
        const genericReaderConfig = this.element.querySelector('.js-generic-reader-config');
        const flipTdiConfig = this.element.querySelector('.js-fliptdi-config');
        const prodConnectBtn = this.element.querySelector('.js-ftdi-prod-connect');
        const prodRetryBtn = this.element.querySelector('.js-ftdi-prod-retry');
        const prodDisconnectBtn = this.element.querySelector('.js-ftdi-prod-disconnect');
        const prodConnectionEl = this.element.querySelector('.js-ftdi-prod-connection');
        const prodChipEl = this.element.querySelector('.js-ftdi-prod-chip');
        const prodStatusEl = this.element.querySelector('.js-ftdi-prod-status');
        const prodErrorEl = this.element.querySelector('.js-ftdi-prod-error');
        const driverHelpEl = this.element.querySelector('.js-ftdi-driver-help');
        const prodImageNameEl = this.element.querySelector('.js-prod-iface-name');
        const prodImageSizeEl = this.element.querySelector('.js-prod-iface-size');
        const prodImageChangesEl = this.element.querySelector('.js-prod-iface-changes');
        const prodSaveImageBtn = this.element.querySelector('.js-prod-save-image-btn');
        const isWindowsHost = /Win/i.test(
            navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
        );
        const ftdiUi = {};
        for (const [name, selector] of Object.entries({
            gpioProbe: 'gpio-probe', probeState: 'probe-state', autoFlow: 'auto-flow', connect: 'connect', open: 'open', mpsse: 'mpsse',
            ctrlPins: 'ctrl-pins', prime: 'prime', gpio: 'gpio', waitChip: 'wait-chip',
            jedec: 'jedec', status1: 'status1', info: 'info', ifaces: 'ifaces', disconnect: 'disconnect',
            usb: 'usb', vidpid: 'vidpid', iface: 'interface', mpsseState: 'mpsse-state',
            ep1State: 'ep1-state', chipState: 'chip-state', operation: 'operation',
            gpioState: 'gpio-state', fault: 'fault', log: 'log'
        })) ftdiUi[name] = this.element.querySelector(`.js-ftdi-${selector}`);

        /** @param {string} message @returns {void} */
        const ftdiLog = message => {
            if (!ftdiUi.log) return;
            const lines = `${ftdiUi.log.textContent}\n[${new Date().toLocaleTimeString()}] ${message}`.split('\n');
            ftdiUi.log.textContent = lines.slice(-400).join('\n');
            ftdiUi.log.scrollTop = ftdiUi.log.scrollHeight;
        };
        let ftdi = null;
        let clockUi = null;
        let serprog = null;
        const activeHardware = () => window.AppState.hardwareController;
        // Retain existing backup/controller state keys; both transports share the same gates.
        const publishHardware = () => {
            const state = window.AppState, controller = activeHardware();
            state.flipTdiDetectedId = controller?.detectedId || null;
            state.flipTdiReady = !!controller?.ready;
            state.flipTdiHostWriteAllowed = !!controller?.ready && !!controller.writeCapabilityVerified;
            state.flipTdiHostWriteReason = controller?.writeCapabilityReason || '';
            state.flipTdiBusy = !!controller?.busy;
            state.flipTdiFault = controller?.fault || '';
            this.updateSourceButtons(CoreFlasherDumpUi.busy() || !!this._isOpening);
            if (!controller?.busy) syncFlipTdiSparseImage();
            // Finish live-image setup before capturing the UUID/image generation for recognition.
            if (!controller?.busy || !controller?.flashChipId || controller?.fault) this.boxRecognition.update(controller);
            identity.querySelector('.js-assign-box').disabled = !this.boxRecognition.state.assignable || CoreFlasherDumpUi.busy();
            this.context.operations.refreshMode();
            this.context.operations.refreshDiagnostic();
            this.context.operations.refreshUsbUuid();
            this.tileManager?.refreshSourceAccess();
            this.context.entry.refresh();
        };
        /** Share only readiness/busy state; never broadcast an unrelated parser refresh per packet. */
        const ftdiStatus = () => {
            if (!ftdi) return;
            const device = ftdi.device;
            const selected = window.AppState.sourceInterface === 'fliptdi';
            const iface = device?.configuration?.interfaces.find(item => item.interfaceNumber === 0);
            const opened = !!device?.opened && !!iface?.claimed;
            const externalBusy = !!window.AppState.flipTdiDumpBusy || !!window.AppState.flipTdiReadBusy || !!window.AppState.dumpFlashUiBusy || !!window.AppState.firmwareBuildBusy;
            const busy = ftdi.busy || externalBusy;
            const activeDetect = ['detection', 'wait-chip'].includes(ftdi.owner?.label);
            const activeProbe = ftdi.owner?.label === 'gpio-diagnosis';
            const validSpi = ftdi.mpsse && ftdi.primed && ftdi.idleVerified && !ftdi.fault;
            const text = (key, value) => { if (ftdiUi[key]) ftdiUi[key].textContent = value; };
            const disable = (key, value) => { if (ftdiUi[key]) ftdiUi[key].disabled = value; };
            text('usb', opened ? 'Connected' : device ? 'Selected' : 'Disconnected');
            text('vidpid', device ? '0403:6014' : '-');
            text('iface', iface ? `0 ${iface.claimed ? 'claimed' : 'not claimed'}` : '-');
            text('mpsseState', ftdi.mpsse ? (ftdi.idleVerified ? (ftdi.hwJedecVerified ? 'GPIO idle + native HW-SPI verified' : 'GPIO idle verified') : 'configured; GPIO check pending') : 'disabled');
            text('ep1State', ftdi.pending?.label === 'EP1 IN' && ftdi.fault ? 'READ PENDING / LOCKED' :
                ftdi.fault ? 'fault / locked' : ftdi.primed ? 'ready' : 'not primed');

            const phaseLabel = (() => {
                if (ftdi.fault) return 'Error';
                if (ftdi.phase === 'waiting native HW-SPI') return 'Waiting for chip power';
                if (ftdi.phase === 'verifying native bridge') return 'Checking flash connection';
                if (ftdi.phase === 'ready') return 'Ready';
                if (ftdi.owner?.stop) return 'Stopping...';
                if (busy) return 'Connecting...';
                return 'Idle';
            })();

            text('chipState',
                ftdi.detectedId ||
                (ftdi.hwJedecVerified ? 'EF 40 18' :
                String(ftdi.phase).startsWith('waiting') ? 'Waiting...' : 'Not detected'));
            text('operation', phaseLabel);

            if (prodConnectionEl) {
                prodConnectionEl.textContent = opened ? 'Connected' :
                    device ? 'Device selected' : 'Disconnected';
            }
            if (prodChipEl) {
                prodChipEl.textContent = ftdi.detectedId
                    ? 'W25Q128FV · 16 MiB'
                    : (ftdi.hwJedecVerified ? 'W25Q128FV · detecting...' : 'Not detected');
            }
            if (prodStatusEl) {
                prodStatusEl.textContent =
                    ftdi.fault ? 'Connection failed' :
                    ftdi.ready ? 'Ready' :
                    phaseLabel === 'Idle' ? 'Ready to connect' :
                    phaseLabel;
            }
            if (prodConnectBtn) {
                prodConnectBtn.textContent = activeDetect
                    ? (ftdi.owner.stop ? 'Stopping...' : 'Stop')
                    : (ftdi.ready ? 'Reconnect Flipper Zero' : 'Connect Flipper Zero');
                prodConnectBtn.disabled = !window.isSecureContext || !selected ||
                    (activeDetect ? ftdi.owner.stop : busy || !!ftdi.fault);
            }
            if (prodDisconnectBtn) {
                prodDisconnectBtn.disabled = busy || !device;
            }
            if (ftdi.ready) {
                driverHelpEl?.classList.add('hidden');
                prodErrorEl?.classList.add('hidden');
            }

            text('gpioState', ftdi.lastGpio === null ? '-' : FlipTdiWebUsb.hex([ftdi.lastGpio]));
            text('probeState', ftdi.probeSummary);
            text('gpioProbe', activeProbe ? (ftdi.owner.stop ? 'Stopping...' : 'Stop GPIO JEDEC Test') : 'Start GPIO JEDEC Test');
            disable('gpioProbe', !selected || (activeProbe ? ftdi.owner.stop : busy || !!ftdi.fault));
            text('fault', ftdi.fault);
            ftdiUi.fault?.classList.toggle('hidden', !ftdi.fault);
            text('autoFlow', activeDetect ? (ftdi.owner.stop ? 'Stopping...' : 'Stop') : (ftdi.ready ? 'Reconnect TB2' : 'Connect TB2'));
            text('waitChip', activeDetect ? (ftdi.owner.stop ? 'Stopping...' : 'Stop Waiting') : 'Wait For Chip');
            disable('autoFlow', !selected || (activeDetect ? ftdi.owner.stop : busy || !!ftdi.fault));
            disable('waitChip', !selected || (activeDetect ? ftdi.owner.stop : busy || !validSpi));
            disable('connect', busy || !!device || !!ftdi.fault || !selected);
            disable('open', busy || !device || !!ftdi.fault || !selected);
            disable('mpsse', busy || !opened || !!ftdi.fault || !selected);
            disable('prime', busy || !opened || !ftdi.mpsse || !!ftdi.fault || !selected);
            disable('ctrlPins', busy || !opened || !!ftdi.fault || !selected);
            disable('gpio', busy || !validSpi || !selected);
            disable('jedec', busy || !validSpi || !selected);
            disable('status1', busy || !ftdi.ready || !selected);
            // Descriptor inspection issues no USB requests and remains usable during reads.
            disable('info', !device);
            disable('ifaces', !device);
            disable('disconnect', busy || !device);
            clockUi?.render();
            if (activeHardware() === ftdi || !activeHardware()) publishHardware();
        };
        ftdi = new FlipTdiWebUsb({
            usb: navigator.usb,
            log: ftdiLog,
            changed: ftdiStatus,
            clockChangeAllowed: () => window.AppState.sourceInterface === 'fliptdi' &&
                !CoreFlasherDumpUi.busy(),
            confirmHighClock: selection => window.confirm(
                `${FlipTdiClock.format(selection.targetHz)} requires confirmation.\n\n` +
                'Confirm that you have identified the actual flash chip and checked that it supports this SPI clock. ' +
                'The JEDEC ID alone is not sufficient. Board and wiring reliability remain unverified.\n\n' +
                'Apply this clock?'),
            readAllowed: () => window.AppState.sourceInterface === 'fliptdi' &&
                ['readonly', 'rw-buffered'].includes(window.AppState.interfaceMode),
            writeAllowed: () => window.AppState.sourceInterface === 'fliptdi' &&
                window.AppState.interfaceMode === 'rw-buffered' &&
                !!window.AppState.flipTdiReady &&
                !!window.AppState.flipTdiHostWriteAllowed &&
                window.interface?.completeSnapshot === true,
            authorizeWrite: async (action, bytes) => {
                const state = window.AppState, image = window.interface, revision = state.interfaceRevision;
                if (action === 'flash-write') FirmwareImage.assertPartialWrite(image, true);
                const identityProof = await this.context.identity.writeProof(bytes, ftdi);
                const guard = () => {
                    identityProof();

                    if (action === 'flash-write') FirmwareImage.assertPartialWrite(window.interface, true);
                    if (image !== window.interface || revision !== state.interfaceRevision ||
                        (action === 'flash-write' && state.flipTdiPhysicalStateUnknown)) {
                        throw new Error('The working image or flash state changed. No further device writes are allowed.');
                    }
                };
                guard.beforeFirstWrite = identityProof.beforeFirstWrite;
                return guard;
            }
        });
        this._flipTdiController = ftdi;
        clockUi = new FlipTdiClockUi(this.element.querySelector('.js-ftdi-clock'), ftdi);
        const serialUi = {};
        for (const name of ['connect','disconnect','cancel','clock','apply','status','frequency','baud']) {
            serialUi[name] = this.element.querySelector(`.js-ser-${name}`);
        }
        /** Refresh controls from the actual adapter, including a locked, failed connection. */
        const serialStatus = () => {
            if (!serprog) return;
            const busy = CoreFlasherDumpUi.busy() || serprog.busy;
            const selected = ['pico','esp32c3'].includes(window.AppState.sourceInterface);
            const c3 = window.AppState.sourceInterface === 'esp32c3';
            const detecting = c3 && serprog.owner?.label === 'detection';
            serialUi.connect.textContent = detecting ? (serprog.owner.stop ? 'Stopping...' : 'Stop') :
                c3 ? (serprog.ready ? 'Reconnect ESP32-C3' : 'Connect ESP32-C3') : 'Connect';
            serialUi.connect.disabled = !selected || !navigator.serial || !window.isSecureContext ||
                (detecting ? serprog.owner.stop : busy || !!serprog.fault || (!c3 && !!serprog.port));
            serialUi.disconnect.disabled = busy || (!serprog.port && !serprog.fault);
            serialUi.cancel.disabled = !serprog.busy || !!serprog.owner?.stop;
            serialUi.clock.disabled = busy;
            serialUi.baud.disabled = busy || !!serprog.port;
            serialUi.apply.disabled = busy || !serprog.ready || !serprog.supports(20);
            serialUi.status.textContent = serprog.fault || (serprog.ready ? 'Connected · W25Q128 · 16 MiB' : serprog.phase);
            serialUi.frequency.textContent = serprog.clockHz ? `Adapter-reported SPI clock: ${FlipTdiClock.format(serprog.clockHz)} (not measured)` : 'Device default — frequency unknown';
            if (activeHardware() === serprog) publishHardware();
        };
        serprog = new Serprog({
            serial: navigator.serial, changed: () => { publishHardware(); serialStatus(); },
            connectAllowed: () => activeHardware() === serprog && !CoreFlasherDumpUi.busy() &&
                !ftdi.device && !this.context.operations.usbQueryActive,
            readAllowed: () => activeHardware() === serprog && ['readonly','rw-buffered'].includes(window.AppState.interfaceMode),
            writeAllowed: () => activeHardware() === serprog && window.AppState.interfaceMode === 'rw-buffered' &&
                serprog.ready && serprog.writeCapabilityVerified && window.interface?.completeSnapshot === true,
            clockChangeAllowed: () => activeHardware() === serprog && !CoreFlasherDumpUi.busy(),
            authorizeWrite: async (action, bytes) => {
                const state = window.AppState, image = window.interface, revision = state.interfaceRevision;
                if (action === 'flash-write') FirmwareImage.assertPartialWrite(image, true);
                const identityProof = await this.context.identity.writeProof(bytes, serprog);
                const guard = () => {
                    identityProof();
                    if (action === 'flash-write') FirmwareImage.assertPartialWrite(window.interface, true);
                    if (activeHardware() !== serprog || image !== window.interface || revision !== state.interfaceRevision ||
                        (action === 'flash-write' && state.flipTdiPhysicalStateUnknown)) {
                        throw new Error('The working image or flash state changed. No further device writes are allowed.');
                    }
                };
                guard.beforeFirstWrite = identityProof.beforeFirstWrite;
                return guard;
            },
            confirmHighClock: () => window.confirm('Apply 16 MHz? Confirm that the flash chip, board and wiring support this SPI clock.')
        });
        this._serprogController = serprog;
        this._refreshFlipTdiUi = () => { ftdiStatus(); serialStatus(); };
        // Public hardware operations resolve the active adapter, never a stale Flipper closure.
        window.AppState.flipTdiReadRange = (...args) => activeHardware().readRange(...args);
        window.AppState.flipTdiWithReadSession = action => activeHardware().withReadSession(action);
        window.AppState.flipTdiRequestStop = () => activeHardware()?.requestStop();
        window.AppState.flipTdiCommitBufferedWrite = (...args) => activeHardware().commitBufferedWrite(...args);
        window.AppState.flipTdiFlashFullImage = (...args) => activeHardware().flashFullImage(...args);
        const serialAction = (name, action) => serialUi[name].addEventListener('click', async event => {
            event.stopPropagation();
            if (serialUi[name].disabled) return;
            try { await action(); }
            catch (error) { serialUi.status.textContent = error.name === 'AbortError' && !serprog.fault ? 'Stopped' : error.message || 'Serial operation failed.'; }
        });
        serialAction('connect', () => {
            if (window.AppState.sourceInterface === 'esp32c3' && serprog.owner?.label === 'detection') {
                serprog.requestStop(); return;
            }
            return serprog.connect({profile: window.AppState.sourceInterface,
                baudRate: Number(serialUi.baud.value), clockHz: Number(serialUi.clock.value)});
        });
        serialAction('disconnect', () => serprog.disconnect());
        serialAction('cancel', () => serprog.requestStop());
        serialAction('apply', () => { serprog.clockTargetHz = Number(serialUi.clock.value); return serprog.applyClock(); });

        /** @param {string} key @param {function():Promise<unknown>} action */
        const bindFtdi = (key, action) => ftdiUi[key]?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            // Programmatic dispatch still passes through exclusive(), not just disabled buttons.
            try {
                Promise.resolve(action()).catch(error => {
                    ftdiLog(`${error.name === 'AbortError' || error.name === 'NotFoundError' ? 'CANCELLED' : 'FAILED'}: ${error.message || error}`);
                }).finally(ftdiStatus);
            } catch (error) { ftdiLog(`FAILED: ${error.message || error}`); }
        });
        bindFtdi('gpioProbe', () => {
            if (ftdi.owner?.label === 'gpio-diagnosis') {
                ftdi.requestStop();
                return Promise.resolve();
            }
            return ftdi.probeJedecViaGpio();
        });
        bindFtdi('connect', () => ftdi.connect());
        bindFtdi('open', () => ftdi.openAndClaim());
        bindFtdi('mpsse', () => ftdi.setMpsse());
        bindFtdi('prime', () => ftdi.primeEp1());
        bindFtdi('ctrlPins', () => ftdi.readPinsEp0());
        bindFtdi('gpio', () => ftdi.readGpio());
        bindFtdi('jedec', () => ftdi.readJedec());
        bindFtdi('status1', () => ftdi.readStatus());
        bindFtdi('disconnect', () => ftdi.disconnect());
        for (const key of ['autoFlow', 'waitChip']) {
            bindFtdi(key, () => {
                if (['detection', 'wait-chip'].includes(ftdi.owner?.label)) {
                    ftdi.requestStop();
                    return Promise.resolve();
                }
                return key === 'autoFlow' ? ftdi.autoDetect() : ftdi.waitForChip();
            });
        }
        bindFtdi('info', async () => {
            const device = ftdi.device;
            if (device) ftdiLog(`Device: manufacturer=${device.manufacturerName || '-'}, ` +
                `product=${device.productName || '-'}, serial=${device.serialNumber || '-'}, opened=${device.opened}`);
        });
        bindFtdi('ifaces', async () => {
            const interfaces = ftdi.device?.configuration?.interfaces || [];
            ftdiLog(JSON.stringify(interfaces.map(iface => ({
                interfaceNumber: iface.interfaceNumber, claimed: iface.claimed,
                alternates: iface.alternates.map(alt => ({
                    alternateSetting: alt.alternateSetting,
                    endpoints: alt.endpoints.map(ep => ({endpointNumber: ep.endpointNumber,
                        direction: ep.direction, type: ep.type, packetSize: ep.packetSize}))
                }))
            }))));
        });

        const showProductionConnectionError = (error) => {
            const raw = String(error?.message || error || 'Unknown WebUSB error');
            const cancelled = error?.name === 'NotFoundError';
            const webUsbUnavailable = /WebUSB unavailable/i.test(raw);

            const device = ftdi?.device || null;
            const iface = device?.configuration?.interfaces?.find(
                item => item.interfaceNumber === 0
            );
            const opened = !!device?.opened;
            const claimed = !!iface?.claimed;

            // Zadig/WinUSB is relevant only while Windows cannot open/claim the USB
            // interface. Once interface 0 is claimed, later JEDEC/SPI/chip failures are
            // definitely not a Windows-driver setup problem.
            const usbAccessFailure =
                isWindowsHost &&
                !!device &&
                (!opened || !claimed) &&
                /open|claim|access|permission|interface|configuration|device/i.test(raw);

            if (prodErrorEl) {
                prodErrorEl.textContent = cancelled
                    ? 'No TB2 Dungeon USB device was selected.'
                    : webUsbUnavailable
                        ? 'WebUSB is not available in this browser/context.'
                        : usbAccessFailure
                            ? 'The TB2 Dungeon USB interface could not be opened.'
                            : opened && claimed
                                ? 'The USB connection is open, but flash communication failed.'
                                : 'The Flipper Zero connection could not be opened.';
                prodErrorEl.classList.remove('hidden');
                prodErrorEl.title = raw;
            }

            if (driverHelpEl) {
                driverHelpEl.classList.toggle('hidden', !usbAccessFailure);
            }

            ftdiLog(`PRODUCTION_CONNECT_FAILED: ${error?.name || 'Error'}: ${raw}`);
        };

        const runProductionConnect = async () => {
            driverHelpEl?.classList.add('hidden');
            prodErrorEl?.classList.add('hidden');

            if (['detection', 'wait-chip'].includes(ftdi.owner?.label)) {
                ftdi.requestStop();
                return;
            }

            try {
                await ftdi.autoDetect();
            }
            catch (error) {
                showProductionConnectionError(error);
            }
            finally {
                ftdiStatus();
            }
        };

        prodConnectBtn?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            runProductionConnect();
        });

        prodRetryBtn?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (ftdi.fault) {
                window.location.reload();
                return;
            }
            runProductionConnect();
        });

        prodDisconnectBtn?.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await ftdi.disconnect();
                driverHelpEl?.classList.add('hidden');
                prodErrorEl?.classList.add('hidden');
            }
            catch (error) {
                showProductionConnectionError(error);
            }
            finally {
                ftdiStatus();
            }
        });
        // Browser navigation is left intact. Warn only when leaving would abandon an active I/O.
        this.listen(window, 'beforeunload', event => {
            if (activeHardware()?.busy) { event.preventDefault(); event.returnValue = ''; }
        });
        ftdiStatus();
        this._isOpening = false;
        let pendingFileDialog = false;

        /**
         * Synchronize opening state, controls, overlay, and tile availability.
         * @param {boolean} isOpening
         * @returns {void}
         */
        const setOpeningState = (isOpening) => {
            this._isOpening = Boolean(isOpening);
            window.AppState.interfaceOpening = this._isOpening;
            if (openingOverlayEl) {
                openingOverlayEl.classList.toggle('hidden', !this._isOpening);
            }
            this.updateSourceButtons(this._isOpening || ftdi.busy);
            if (saveImageBtn) {
                const currentImage = window.interface;
                const incompleteLive = currentImage?.sourceType === 'fliptdi-live'
                    && !currentImage.completeSnapshot;
                saveImageBtn.disabled = this._isOpening || !currentImage || incompleteLive;
            }
            if (this._isOpening) {
                this.disable();
            }
            else {
                this.enable();
            }
            this.updateStyles();
            if (!this._isOpening) this.context.identity.observe();
        };

        /**
         * Finish the picker while retaining the current image and its drafts.
         * @returns {void}
         */
        const finishDiskPicker = () => {
            setOpeningState(false);
            this.updateStyles();
            fileInput.value = '';
        };

        /**
         * Cancel an opening operation when the file picker returns no file.
         * @returns {void}
         */
        const finalizePickerWithoutFile = () => {
            const hasFile = !!(fileInput.files && fileInput.files.length > 0);
            if (!this._isOpening || hasFile) {
                return;
            }
            finishDiskPicker();
        };

        /**
         * Install the existing focus-based fallback for picker cancellation.
         * @returns {void}
         */
        const armFilePickerCloseFallback = () => {
            pendingFileDialog = true;

            /**
             * Remove the one-shot focus listener and finalize a pending file picker.
             * @returns {void}
             */
            const onWindowFocus = () => {
                window.removeEventListener('focus', onWindowFocus, true);
                if (!pendingFileDialog) {
                    return;
                }
                pendingFileDialog = false;
                finalizePickerWithoutFile();
            };
            this.listen(window, 'focus', onWindowFocus, true);
        };

        /**
         * Format the byte count using the existing 1024-based units and precision.
         * @param {number} value
         * @returns {string}
         */
        const formatBytes = (value) => {
            const bytes = Number(value || 0);
            if (!Number.isFinite(bytes) || bytes < 0) {
                return '0 B';
            }
            const units = ['B', 'KB', 'MB', 'GB'];
            let idx = 0;
            let amount = bytes;
            while (amount >= 1024 && idx < units.length - 1) {
                amount /= 1024;
                idx += 1;
            }
            const rounded = idx === 0 ? amount.toFixed(0) : amount.toFixed(2);
            return `${rounded} ${units[idx]} (${bytes} B)`;
        };

        /**
         * Refresh image metadata, pending writes, dirty indication, and export availability.
         * @param {SparseImage|null} image
         * @returns {void}
         */
        const updateImageInfo = (image) => {
            const hasImage = !!image;
            if (infoLoadedEl) {
                infoLoadedEl.innerText = hasImage ? 'yes' : 'no';
            }
            if (infoNameEl) {
                infoNameEl.innerText = hasImage ? (window.AppState.sourceFileName || '-') : '-';
            }
            if (infoSizeEl) {
                infoSizeEl.innerText = hasImage ? formatBytes(image.size) : '-';
            }
            if (infoReadableEl) {
                infoReadableEl.innerText = hasImage ? formatBytes(image.length || image.size
                    || 0) : '-';
            }
            if (infoPendingEl) {
                if (!hasImage) {
                    infoPendingEl.innerText = '-';
                }
                else {
                    const writeBuffer = Array.isArray(image.writeBuffer) ? image.writeBuffer : [];
                    const pendingBlocks = writeBuffer.length;
                    const pendingBytes = writeBuffer.reduce((sum, seg) => sum + ((seg && seg.data
                        && seg.data.length) || 0), 0);
                    infoPendingEl.innerText = `${formatBytes(
                        pendingBytes)} in ${pendingBlocks} block(s)`;
                }
            }
            const prodWriteBuffer = Array.isArray(image?.writeBuffer) ? image.writeBuffer : [];
            const prodPendingBytes = prodWriteBuffer.reduce(
                (sum, segment) => sum + (segment?.data?.length || 0), 0
            );
            if (prodImageNameEl) {
                prodImageNameEl.textContent = hasImage
                    ? (window.AppState.sourceFileName || 'Current image')
                    : '-';
            }
            if (prodImageSizeEl) {
                prodImageSizeEl.textContent = hasImage ? formatBytes(image.size) : '-';
            }
            if (prodImageChangesEl) {
                prodImageChangesEl.textContent = prodPendingBytes > 0
                    ? `${prodWriteBuffer.length} pending change${prodWriteBuffer.length === 1 ? '' : 's'}`
                    : 'No pending changes';
                prodImageChangesEl.classList.toggle('text-amber-300', prodPendingBytes > 0);
                prodImageChangesEl.classList.toggle('text-zinc-400', prodPendingBytes === 0);
            }
            if (prodSaveImageBtn) {
                const incompleteLive = image?.sourceType === 'fliptdi-live'
                    && !image.completeSnapshot;
                prodSaveImageBtn.disabled = this._isOpening || !hasImage;
            }

            if (dirtyNoteEl) {
                const writeBuffer = Array.isArray(image?.writeBuffer)
                    ? image.writeBuffer
                    : [];
                const hasPendingWrites = writeBuffer.some(segment =>
                    segment?.data?.length > 0
                );

                // A parser/cache revision is not a firmware modification. In particular,
                // loading/promoting a verified backup replaces the baseline and invalidates
                // parser caches but leaves writeBuffer empty. Only an actual buffered overlay
                // should display "Firmware image has changed".
                const showDirty = hasImage && hasPendingWrites;

                dirtyNoteEl.classList.toggle('hidden', !showDirty);
                if (saveImageBtn) {
                    const incompleteLive = image?.sourceType === 'fliptdi-live'
                        && !image.completeSnapshot;
                    saveImageBtn.disabled = this._isOpening || !hasImage || incompleteLive;
                    saveImageBtn.classList.toggle('save-image-dirty', showDirty);
                }
            }
        };

        /**
         * Insert the existing _patched suffix before the source filename extension.
         * @returns {string}
         */
        const buildDownloadName = () => {
            const base = window.AppState.sourceFileName || 'interface_image.bin';
            if (!base.includes('.')) {
                return `${base}_patched.bin`;
            }
            const lastDot = base.lastIndexOf('.');
            return `${base.slice(0, lastDot)}_patched${base.slice(lastDot)}`;
        };

        /**
         * Publish the image, reset parser caching, update revisions, and notify tiles.
         * @param {SparseImage|null} image
         * @returns {void}
         */
        const setInterfaceImage = (image, uuid = '', lease = null) => {
            const previousImage = window.interface;
            if (lease) {
                if (previousImage) previousImage.assertOperation(lease);
                else lease.assertCurrent();
            }
            else if (previousImage?.operationBusy || window.AppState.dumpFlashUiBusy || window.AppState.flipTdiWriteBusy) {
                throw new Error('Finish the current image operation before replacing its source.');
            }
            const hardware = activeHardware();
            const provedReplacement = previousImage !== image && hardware?.baselineProof?.image === image;
            if (provedReplacement) hardware.assertReadContext(hardware.baselineProof.context);
            window.interface = image;
            window.AppState.interfaceImage = image;
            window.AppState.littlefsParser = null;
            window.AppState.littlefsParserSource = null;
            updateImageInfo(image);
            if (previousImage !== image) {
                // A completed device operation may already have proved this exact replacement.
                // Ordinary file/archive publication never has such a proof.
                if (!provedReplacement) hardware?.forgetBaseline?.();
                // Clear scan state on every replacement; local/archive loads supply their own UUID.
                this.context.uuid.resetSearch?.(false);
                window.AppState.interfaceRevision = Number(window.AppState.interfaceRevision || 0)
                    + 1;
                window.AppState.interfaceSavedRevision = Number(window.AppState.interfaceRevision
                    || 0);
                if (image) {
                    window.AppState.interfaceLoadRevision = Number(
                        window.AppState.interfaceLoadRevision || 0) + 1;
                }
            }
            if (previousImage !== image) this.context.uuid.setSerialNumberField(uuid, true);
            if (this.tileManager) {
                this.tileManager.broadcastUpdate(this);
            }
        };
        /**
         * Create a read-only 16 MiB SparseImage backed by the verified FlipTDI reader.
         * Missing ranges are expanded to whole 4 KiB sectors before USB I/O.
         * @returns {SparseImage}
         */
        function createFlipTdiLiveSparseImage() {
            const controller = activeHardware();
            const FLASH_SIZE = 0x1000000;
            const SECTOR_SIZE = 0x1000;

            const image = new SparseImage(
                FLASH_SIZE,
                async (address, size) => {
                    if (activeHardware() !== controller) {
                        throw new Error('The live reader session changed. Reconnect and read the image again.');
                    }
                    if (!window.AppState.flipTdiReady ||
                        typeof window.AppState.flipTdiReadRange !== 'function') {
                        throw new Error('FLIPTDI_SPARSE_OFFLINE: live flash reader is not ready.');
                    }
                    if (!Number.isInteger(address) || !Number.isInteger(size) ||
                        address < 0 || size < 1 || address + size > FLASH_SIZE) {
                        throw new Error('FLIPTDI_SPARSE_RANGE: invalid flash range.');
                    }
                    // Publication invalidates prior evidence; bind the cache when its first read starts.
                    const readContext = image.liveReadContext ||= controller.captureReadContext();
                    controller.assertReadContext(readContext);

                    const alignedStart = Math.floor(address / SECTOR_SIZE) * SECTOR_SIZE;
                    const alignedEnd = Math.min(
                        FLASH_SIZE,
                        Math.ceil((address + size) / SECTOR_SIZE) * SECTOR_SIZE
                    );
                    const alignedLength = alignedEnd - alignedStart;
                    const data = await window.AppState.flipTdiReadRange(
                        alignedStart,
                        alignedLength
                    );
                    if (activeHardware() !== controller) {
                        throw new Error('The live reader session changed during the read. Read the current device again.');
                    }
                    controller.assertReadContext(readContext);

                    if (!(data instanceof Uint8Array) || data.length !== alignedLength) {
                        throw new Error(
                            `FLIPTDI_SPARSE_SHORT_READ: ${data?.length ?? 0}/${alignedLength}`
                        );
                    }
                    return { address: alignedStart, data };
                },
                null,
                null,
                SECTOR_SIZE
            );

            image.readOnly = true;
            image.sourceType = 'fliptdi-live';
            image.completeSnapshot = false;
            image.verifiedSha256 = null;
            return image;
        }

        /**
         * Publish or retire the live SparseImage according to current connection state.
         * A verified full snapshot survives disconnect; an incomplete live cache does not.
         * @returns {void}
         */
        function syncFlipTdiSparseImage() {
            const controller = activeHardware();
            if (controller?.busy || CoreFlasherDumpUi.busy()) return;

            const selected = !!controller;
            let image = window.AppState.flipTdiLiveImage || null;

            if (selected && controller.ready) {
                if (CoreFlasherDumpUi.complete(window.interface)) return;
                if (image && !image.completeSnapshot && image.liveReadContext) {
                    try { controller.assertReadContext(image.liveReadContext); }
                    catch {
                        image = null;
                        window.AppState.flipTdiLiveImage = null;
                        ftdiLog('[SPARSE] Incomplete live cache discarded because the device context changed.');
                    }
                }
                if (!image) {
                    image = createFlipTdiLiveSparseImage();
                    window.AppState.flipTdiLiveImage = image;
                    window.AppState.sourceFileName = 'W25Q128FV_live.bin';
                    setInterfaceImage(image);
                    ftdiLog('[SPARSE] Live read-only SparseImage published (16 MiB, 4 KiB aligned reads).');
                }
                else if (window.interface !== image) {
                    window.AppState.sourceFileName = image.completeSnapshot
                        ? 'W25Q128FV_verified.bin'
                        : 'W25Q128FV_live.bin';
                    setInterfaceImage(image);
                }
                return;
            }

            if (image && !image.completeSnapshot) {
                if (window.interface === image) {
                    setInterfaceImage(null);
                }
                window.AppState.flipTdiLiveImage = null;
                if (selected) window.AppState.sourceFileName = null;
                ftdiLog('[SPARSE] Incomplete live cache discarded because the device is offline.');
            }
        }

        /**
         * Publish a new complete snapshot with owned storage and the verified read's device context.
         * The recovery backup keeps separate bytes; publication replaces parser and tile references.
         * @param {Uint8Array} bytes
         * @param {object} info
         * @param {object} readContext
         * @param {object|null} lease
         * @returns {Promise<SparseImage>}
         */
        const promoteVerifiedDumpToSparseImage = async (bytes, info = {}, readContext, lease = null) => {
            const FLASH_SIZE = 0x1000000;
            if (!(bytes instanceof Uint8Array) || bytes.length !== FLASH_SIZE) {
                throw new Error('SPARSE_PROMOTE_INVALID: expected one complete 16 MiB dump.');
            }

            const image = SparseImage.fromBuffer(bytes.slice());
            image.readOnly = true;
            image.sourceType = 'fliptdi-verified';
            image.completeSnapshot = true;
            image.verifiedSha256 = String(info.sha256 || '');

            const controller = activeHardware();
            if (!await controller.rememberBaseline(image, bytes, readContext)) throw new Error('Device dump no longer belongs to the active reader.');
            setInterfaceImage(image, '', lease);
            window.AppState.flipTdiLiveImage = image;
            window.AppState.sourceFileName = info.filename || 'W25Q128FV_verified.bin';

            ftdiLog(`[SPARSE] Verified 16 MiB snapshot promoted to cache; SHA-256 ${image.verifiedSha256 || '-'}.`);
            return image;
        };

        window.AppState.flipTdiPromoteVerifiedDump = promoteVerifiedDumpToSparseImage;


        /**
         * Select the source button associated with the requested source identifier.
         * @param {string} source
         * @returns {void}
         */
        const setActiveButton = (source) => {
            sourceButtons.forEach(btn => {
                btn.classList.toggle('source-btn-active', btn.dataset.source === source);
            });
        };

        /**
         * Set the reader configuration heading without altering the reader settings.
         * @param {string} source
         * @returns {void}
         */
        const setConfigForSource = (source) => {
            if (source === 'esp32c3') {
                configTitle.innerText = 'ESP32-C3 Reader Configuration';
            }
            else if (source === 'pico') {
                configTitle.innerText = 'Pico Reader Configuration';
            }
            else if (source === 'fliptdi') {
                configTitle.innerText = 'Flipper Zero based SPI flash reader';
            }
            // Help follows the selected firmware profile; it never programs GPIO assignments.
            const pico = source === 'pico';
            this.element.querySelector('.js-ser-help-pico').classList.toggle('hidden', !pico);
            this.element.querySelector('.js-ser-help-esp32c3').classList.toggle('hidden', source !== 'esp32c3');
            this.element.querySelector('.js-ser-help').open = false;
            const pins = pico ? {cs:'GP1 (header 2)',miso:'GP4 (header 6)',mosi:'GP3 (header 5)',clock:'GP2 (header 4)'}
                : {cs:'GPIO4 (configured)',miso:'GPIO5 (configured)',mosi:'GPIO7 (configured)',clock:'GPIO6 (configured)'};
            for (const [signal, label] of Object.entries(pins)) this.element.querySelector(`.js-ser-pin-${signal}`).textContent = label;
            if (genericReaderConfig) genericReaderConfig.classList.toggle('hidden', source === 'fliptdi');
            if (flipTdiConfig) flipTdiConfig.classList.toggle('hidden', source !== 'fliptdi');
        };
        sourceButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                if (CoreFlasherDumpUi.busy()) {
                    ftdiLog('SOURCE_CHANGE_BLOCKED: complete or stop the active USB operation first.');
                    return;
                }
                const source = btn.dataset.source;
                if (source === 'disk') {
                    setOpeningState(true); fileInput.value = '';
                    armFilePickerCloseFallback(); fileInput.click(); return;
                }
                try {
                    const previous = activeHardware();
                    if (previous?.device || previous?.port || previous?.fault) await previous.disconnect();
                } catch (error) {
                    serialUi.status.textContent = `Could not disconnect the previous adapter: ${error.message}`;
                    ftdiLog(serialUi.status.textContent); return;
                }
                window.AppState.sourceInterface = source;
                window.AppState.hardwareController = source === 'fliptdi' ? ftdi : ['pico','esp32c3'].includes(source) ? serprog : null;
                if (!CoreFlasherDumpUi.complete(window.interface)) {
                    window.AppState.interfaceMode = 'readonly';
                    window.AppState.sourceFileName = null;
                    setInterfaceImage(null);
                }
                window.AppState.flipTdiLiveImage = null;
                serialUi.baud.value = '115200';
                serialUi.clock.value = source === 'esp32c3' ? '8000000' : '2000000';
                this._refreshFlipTdiUi();
                setActiveButton(source);
                this.updateStyles();
                setConfigForSource(source);
                configBlock.classList.remove('hidden');
            });
        });
        fileInput.addEventListener('cancel', () => {
            pendingFileDialog = false;
            finalizePickerWithoutFile();
        });
        fileInput.addEventListener('change', async () => {
            pendingFileDialog = false;
            const file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
            if (!file) {
                finishDiskPicker();
                return;
            }
            try {
                if (window.interface?.operationBusy || window.AppState.dumpFlashUiBusy || window.AppState.flipTdiBusy || window.AppState.imageManagerBusy) {
                    throw new Error('Finish the current image operation before loading another file.');
                }
                setOpeningState(true);
                const previous = window.interface, revision = window.AppState.interfaceRevision;
                const buffer = await file.arrayBuffer();
                if (buffer.byteLength !== FirmwareImage.SIZE) throw new Error('Select a complete 16 MiB image.');
                const image = SparseImage.fromBuffer(buffer); image.completeSnapshot = true;
                const uuid = await this.readLocalImageUuid(image);
                if (previous !== window.interface || revision !== window.AppState.interfaceRevision)
                    throw new Error('The working image changed while reading the file. Select it again.');
                if (!this.context.image.confirmReplace()) return;
                if (!activeHardware()?.device && !activeHardware()?.port) {
                    window.AppState.sourceInterface = 'disk'; setActiveButton('disk'); configBlock.classList.add('hidden');
                }
                window.AppState.sourceFileName = file.name;
                window.AppState.interfaceMode = 'readonly'; image.readOnly = true;
                setInterfaceImage(image, uuid);
                this.element.querySelector('.js-image-load-error').textContent = '';
            }
            catch (err) {
                this.element.querySelector('.js-image-load-error').textContent = `Image not loaded: ${err.message}`;
            }
            finally {
                setOpeningState(false);
            }
            this.updateStyles();
            fileInput.value = '';
        });
        const exportCurrentImage = () => {
            if (CoreFlasherDumpUi.busy()) throw new Error('Another operation is running.');
            const image = window.interface;
            if (!CoreFlasherDumpUi.complete(image)) {
                throw new Error('Create or load a complete image before exporting.');
            }
            const bytes = image.subarray(0, image.size);
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = buildDownloadName();
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            window.AppState.interfaceSavedRevision = Number(window.AppState.interfaceRevision || 0);
            updateImageInfo(image);
            if (this.tileManager) {
                this.tileManager.broadcastUpdate(this);
            }
            return a.download;
        };
        this._exportCurrentImage = exportCurrentImage;
        this._publishImage = (image, uuid = '', lease = null) => {
            if (!lease && CoreFlasherDumpUi.busy()) throw new Error('Another image or device operation is running.');
            setInterfaceImage(image, uuid, lease);
        };
        /** Load verified archive bytes through the local-file workflow, never as a backup proof. */
        this._loadArchiveImage = async (bytes, name, signal, uuid = '', boxId = '') => {
            if (uuid && !/^500100[0-9A-F]{10}$/.test(uuid)) throw new Error('Invalid box UUID. Review the box details first.');
            if (!(bytes instanceof Uint8Array) || bytes.length !== FirmwareImage.SIZE) throw new Error('Select a complete 16 MiB image.');
            if (CoreFlasherDumpUi.busy(true)) throw new Error('Another image or device operation is running.');
            const sourceStamp = this.context.identity.stamp();
            const previous = window.interface, hardware = activeHardware();
            const source = window.AppState.sourceInterface, mode = window.AppState.interfaceMode;
            const assertImage = () => {
                if (!this.context.identity.current(sourceStamp)) throw new Error('The source changed. Load the archived image again.');
                if (signal?.aborted) throw new Error('Operation cancelled.');
            };
            // This public API also owns the source when called outside Image Manager's dialog.
            const lease = previous?.acquireOperation('device', assertImage) || {assertCurrent:assertImage, release() {}};
            try {
                setOpeningState(true);
                const candidate = SparseImage.fromBuffer(bytes.slice().buffer); candidate.completeSnapshot = true; candidate.archiveBoxId = boxId;
                const profiles = await this.context.identity.profiles();
                let observed = {};
                try { observed = await this.context.identity.inspect(candidate); }
                catch { /* An unknown filesystem remains loadable; archive identity is still checked below. */ }
                if (observed.uuid && uuid && observed.uuid !== uuid) throw new Error('Image UUID and saved box UUID do not match.');
                if (profiles) BoxIdentity.resolve(profiles, {...observed, ...(uuid ? {uuid} : {}), boxId});
                await this.context.identity.validateUuid(candidate, uuid);
                lease.assertCurrent();
                if (!this.context.image.confirmReplace()) return false;
                lease.assertCurrent();
                if (hardware !== activeHardware() || source !== window.AppState.sourceInterface || mode !== window.AppState.interfaceMode) {
                    throw new Error('The interface changed. Load the archived image again.');
                }
                const image = candidate;
                image.completeSnapshot = image.size === FirmwareImage.SIZE; image.readOnly = true;
                if (!hardware?.device && !hardware?.port) { window.AppState.sourceInterface = 'disk'; window.AppState.hardwareController = null; }
                window.AppState.flipTdiLiveImage = null; window.AppState.interfaceMode = 'readonly';
                window.AppState.sourceFileName = name; setActiveButton(window.AppState.sourceInterface);
                if (window.AppState.sourceInterface === 'disk') configBlock.classList.add('hidden');
                document.querySelectorAll('.js-iface-mode').forEach(input => { input.checked = input.value === 'readonly'; });
                setInterfaceImage(image, uuid, lease); this._refreshFlipTdiUi(); this.updateStyles(); return true;
            } finally {
                lease.release();
                setOpeningState(false);
            }
        };
        saveImageBtn.addEventListener('click', () => {
            try { exportCurrentImage(); }
            catch (error) { console.error('Image export refused:', error); }
        });

        prodSaveImageBtn?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!prodSaveImageBtn.disabled) this.tileManager?.moveTo(0, 0);
        });
        this._infoTimer = setInterval(() => {
            updateImageInfo(window.interface || null);
            this.context.identity.observe();
        }, 500);
        setOpeningState(false);
        updateImageInfo(window.interface || null);
    }

    /** Read only a root UUID from the incoming image; missing UUIDs never inherit another box's key. */
    async readLocalImageUuid(image) {
        if (!CoreFlasherDumpUi.complete(image)) return '';
        try {
            const parser = new LittleFSParser(image, FirmwareImage.LFS, image.size - FirmwareImage.LFS);
            await parser.initialize();
            const entry = await parser.fs._resolvePath('/uuid');
            if (entry?.entry?.type !== 0x001) return '';
            const bytes = await parser.readFile('/uuid');
            const uuid = new TextDecoder().decode(bytes).toUpperCase();
            return bytes.length === 16 && /^500100[0-9A-F]{10}$/.test(uuid) ? uuid : '';
        } catch (error) {
            // A raw image can still be opened when its filesystem is unavailable; no key is assumed.
            this.localUuidReadWarning = 'No UUID could be read from the incoming image.';
            return '';
        }
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return !window.AppState.sourceInterface && !this._isOpening;
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        if (!window.AppState.sourceInterface) {
            return 'source interface not selected yet';
        }
        return 'interface tile flashing condition met';
    }
}
CoreFlasherApp.cardControllers["tile-interface"] = CardController;
})();
