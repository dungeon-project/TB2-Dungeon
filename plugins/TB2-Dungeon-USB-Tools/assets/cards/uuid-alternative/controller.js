/* Detect UUID (Alternative) controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    /** USB access remains independent of preparation and survives a fresh page session. */
    init() {
        this.context.identity?.bindStatus(this);
        this.usbPorts = []; this.selectedUsbPort = null;
        this.listen(this.element.querySelector('.js-usb-device'), 'change', event => {
            this.selectedUsbPort = event.target.value === '' ? null : this.usbPorts[Number(event.target.value)] || null; this.update();
        });
        this.own(this.context.subscribe('usb-presence', () => {
            if (this.queryPort && !this.context.usbPresence.state.ports.includes(this.queryPort)) this.usbQueryAbort?.abort();
            this.update();
        }));
        this.operationRunning = false;
        this.serialCompleted = false;
        this._statusTimer = setInterval(() => { if (this.isFocused) this.update(); },FirmwareImage.UI_REFRESH_MS);
        this.element.querySelector('.js-fw-serial').addEventListener('click',event=>{event.stopPropagation();this.readUsbUuid();});
        this.element.querySelector('.js-fw-serial-cancel').addEventListener('click',event=>{event.stopPropagation();this.usbQueryAbort?.abort();});
        this.element.querySelector('.js-usb-uuid-save').addEventListener('click',event=>{
            event.stopPropagation();this.saveUuid();
        });
        this.listen(this.element.querySelector('.js-usb-uuid-load'), 'click', event => {
            event.stopPropagation();
            this.tileManager.openImageManager({ uuidMode: 'load' });
        });
        // Manual edits and USB results both publish through the keyscanner's shared UUID state.
        this.element.querySelector('#usb-found-uuid').addEventListener('input',event=>{
            this.context.uuid.setSerialNumberField(event.target.value,true);
        });
        this.element.querySelector('.js-fw-mitm').addEventListener('click',async event=>{
            event.stopPropagation();
            if(this.operationRunning || this.usbQueryAbort || CoreFlasherDumpUi.busy())return;
            if(this.mitmReason())return;
            const target = this.context.navigation.mitm.available ? this.context.navigation.mitm : null;
            if(target){target.enable();void this.context.navigation.moveToCard('tile-mitm-setup');}
            else void CoreFlasherApp.extensions.showOverview();
        });
    }
    /** The query publishes its UUID and optional serial; unrelated response fields are discarded. */
    async readUsbUuid() {
        if (this.context.hardware.serprogConnected) return;
        if(this.operationRunning || this.usbQueryAbort || CoreFlasherDumpUi.busy() || !navigator.serial || !window.isSecureContext)return;
        if (!this.context.usbPresence.allowed()) return;
        const port = this.selectedUsbPort;
        if (!port || !this.context.usbPresence.state.ports.includes(port) || port.connected !== true) return;
        this.usbLost = false; this.queryPort = port;
        this.usbQueryAbort=new AbortController();this.serialCompleted=false;this.serialError='';
        this.serialAttempt = (this.serialAttempt || 0) + 1;
        this.serialResultMessage = '';
        this.operationRunning=true;this.update();
        try {
            const result=await McuUsbSerial.readPort(port,this.usbQueryAbort.signal,McuUsbSerial.TIMEOUT_MS,true);
            if (this.usbQueryAbort.signal.aborted || port.connected !== true) throw new Error('USB query cancelled after disconnect.');
            const uuid=typeof result === 'string' ? result : result.uuid;
            const scanner = this.context.uuid.available ? this.context.uuid : null;
            const unchanged = scanner.currentInput === uuid;
            scanner.setSerialNumberField(uuid,true);
            // A fresh completion remains visible even when the UUID itself did not change.
            this.serialResultMessage = unchanged ? 'UUID confirmed again; matches the active UUID.' : 'UUID received and set as the active UUID.';
            this.serialCompleted=true;
            this.context.identity?.acceptUsb(typeof result === 'string' ? {uuid} : result);
            if (result.boxSerialNumber) this.serialResultMessage += ` Box serial number: ${result.boxSerialNumber}.`;
        } catch(error) {
            this.serialError=error.message;
        } finally {
            this.serialFinishedAt = new Date().toLocaleTimeString('en-GB');
            this.usbQueryAbort=null;this.queryPort=null;this.operationRunning=false;this.update();
            if (this.usbLost) this.context.usbPresence.report(`Detect UUID (Alternative): ${this.serialError || this.serialResultMessage}`);
        }
    }
    onUsbLost() { this.usbLost = true; this.usbQueryAbort?.abort(); }
    refreshUsbPorts() {
        const ports = this.context.usbPresence.state.ports, select = this.element.querySelector('.js-usb-device');
        if (ports.length !== this.usbPorts.length || ports.some((port, index) => port !== this.usbPorts[index])) {
            if (!ports.includes(this.selectedUsbPort) || (this.usbPorts.length < 2 && ports.length > 1)) this.selectedUsbPort = null;
            this.usbPorts = [...ports];
            if (ports.length === 1) this.selectedUsbPort = ports[0];
            select.replaceChildren(new Option('Select a TB2 USB interface', ''));
            ports.forEach((port, index) => select.add(new Option(`TB2 USB ${index + 1}`, String(index))));
            select.value = this.selectedUsbPort ? String(ports.indexOf(this.selectedUsbPort)) : '';
        }
        this.element.querySelector('.js-usb-device-label').hidden = ports.length < 2;
        select.disabled = !!this.usbQueryAbort;
        this.element.querySelector('.js-usb-device-status').textContent = !ports.length
            ? 'No visible connected TB2 interface. Check TB2 USB tools in Interface.'
            : !this.selectedUsbPort ? 'Select the TB2 USB interface to query.' : 'Detected USB interface ready.';
    }
    /** Archive the shared UUID without modifying the working image. */
    async saveUuid() {
        if (this.operationRunning || CoreFlasherDumpUi.busy() || this.context.uuid.saveDisabled) return;
        this.tileManager.openImageManager({ uuidMode: 'save', uuid: this.context.uuid.currentInput });
    }
    /** Shared UUID input is authoritative, including incomplete manual edits. */
    activeUuid() {
        return this.context.uuid.persistedValue;
    }
    /** Navigation never grants write permissions or requires a decryption key. */
    mitmReason() { return ''; }
    /** A UUID file is a fallback only, tied to the current image and revision. */
    uuidFileCurrent() {
        return !!this.uuidFile?.valid && this.uuidFile.image === window.interface &&
            this.uuidFile.revision === Number(window.AppState.interfaceRevision || 0);
    }
    async checkUuidFile(force = false) {
        const image = window.interface, revision = Number(window.AppState.interfaceRevision || 0);
        if (!CoreFlasherDumpUi.complete(image) || CoreFlasherDumpUi.busy()) {
            this.uuidFile = null; return;
        }
        if (this.uuidCheckPending || (!force && this.uuidFile?.image === image && this.uuidFile.revision === revision)) return;
        this.uuidCheckPending = true;
        const checked = {image, revision, valid:false};
        try {
            const parser = new LittleFSParser(image,FirmwareImage.LFS,image.size-FirmwareImage.LFS);
            await parser.initialize();
            const entry = await parser.fs._resolvePath('/uuid');
            if (entry?.entry?.type === 0x001) {
                const bytes = await parser.readFile('/uuid');
                const uuid = new TextDecoder().decode(bytes);
                checked.valid = bytes.length === 16 && /^[0-9a-f]{16}$/i.test(uuid);
                if (checked.valid) checked.uuid = uuid.toUpperCase();
            }
            this.uuidFileError = '';
        } catch (error) {
            this.uuidFileError = `UUID file could not be checked: ${error.message}`;
        } finally {
            if (image === window.interface && revision === Number(window.AppState.interfaceRevision || 0)) this.uuidFile = checked;
            this.uuidCheckPending = false;
            this.update();
        }
    }
    focus() { super.focus(); this.update(); }
    /** Gate only the individual actions, never this independently usable USB card. */
    update() {
        this.refreshUsbPorts();
        this.updateStyles();
        // Mirror the active shared UUID; never maintain a competing copy in this card.
        const scanner = this.context.uuid.available ? this.context.uuid : null;
        // This card updates before the scanner during broadcasts, so read persisted state directly.
        const uuid = this.context.uuid.currentInput;
        const field = this.element.querySelector('#usb-found-uuid');
        if (field.value !== uuid) this.element.querySelector('.js-usb-uuid-save-status').textContent = '';
        field.value = uuid;
        this.element.querySelector('.js-usb-uuid-result').classList.toggle('valid', /^[0-9A-F]{16}$/.test(uuid));
        scanner?.refreshUuidSaveButton();
        this.element.querySelector('.js-usb-uuid-save').disabled = this.operationRunning || CoreFlasherDumpUi.busy() || !scanner || scanner.saveDisabled;
        this.element.querySelector('.js-usb-uuid-load').disabled = this.operationRunning || CoreFlasherDumpUi.busy() || !window.CoreFlasherImageStorage;
        const serialSupported=!!window.isSecureContext && !!navigator.serial;
        const adapterConnected = !!this.context.hardware.serprogConnected;
        // Keep wiring instructions stable and report every attempt in a separate live status panel.
        const queryPanel = this.element.querySelector('.js-usb-query-panel');
        queryPanel.hidden = !this.serialAttempt && serialSupported && !adapterConnected;
        queryPanel.style.borderColor = this.serialError ? '#ed9999' : this.usbQueryAbort ? '#f2c37c' : '#9bd3ac';
        this.element.querySelector('.js-usb-query-status').textContent = !serialSupported
            ? 'Open this website in Chrome or Edge over a secure connection.'
            : adapterConnected ? 'Disconnect the serprog adapter before reading the MCU UUID over USB-C.'
            : this.usbQueryAbort ? `USB query #${this.serialAttempt} in progress. Waiting for the detected USB-C interface response…`
            : this.serialError ? `USB query #${this.serialAttempt} failed at ${this.serialFinishedAt}: ${this.serialError}`
            : `USB query #${this.serialAttempt} completed at ${this.serialFinishedAt}. ${this.serialResultMessage} Serial disconnected.`;
        this.element.querySelector('.js-usb-query-progress').hidden = !this.usbQueryAbort;
        this.element.querySelector('.js-fw-serial').textContent = this.usbQueryAbort ? 'Reading UUID…' : this.serialCompleted ? 'Read UUID again' : 'Read MCU UUID via USB-C';
        this.element.querySelector('.js-fw-serial').disabled = this.operationRunning || !!this.usbQueryAbort || !serialSupported || !this.selectedUsbPort || adapterConnected || CoreFlasherDumpUi.busy();
        this.element.querySelector('.js-fw-serial-cancel').hidden = !this.usbQueryAbort;
        const mitmButton=this.element.querySelector('.js-fw-mitm');
        mitmButton.disabled = !!this.mitmReason();
        mitmButton.textContent = 'Continue to MITM';
        mitmButton.title = this.mitmReason();
    }
}
CoreFlasherApp.cardControllers["tile-firmware-0408"] = CardController;
})();
