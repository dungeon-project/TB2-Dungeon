/* Diagnostic Image (Production) controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    /** Own only image preparation and its matching verified flash; links never perform I/O. */
    init() {
        this.loadButton = this.element.querySelector('.js-fw-load');
        this.fileInput = this.element.querySelector('.js-fw-file');
        this.prepareButton = this.element.querySelector('.js-fw-prepare');
        this.statusElement = this.element.querySelector('.js-fw-status');
        this.errorElement = this.element.querySelector('.js-fw-error');
        this.operationRunning = false;
        this.selectionRunning = false;
        this.templateSlot = null;
        this.templateName = '';
        this.selectionRevision = 0;
        this.result = null;
        this.verifiedFlash = null;
        this.loadButton.addEventListener('click', event => {
            event.stopPropagation();
            if (this.operationRunning || this.selectionRunning) return;
            this.fileInput.value = '';
            this.fileInput.click();
        });
        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (file) void this.loadTemplate(file);
        });
        this.prepareButton.addEventListener('click', event => { event.stopPropagation(); this.prepare(); });
        // Preserve logical controller coordinates while presenting the new vertical route.
        for (const [selector, x, y] of [['.js-fw-dump',0,0],['.js-boot-content',0,2],['.js-boot-teddybench',-1,1],['.js-boot-uuid',1,2]]) {
            this.element.querySelector(selector).addEventListener('click', event => {
                event.stopPropagation(); this.tileManager?.moveTo(x,y);
            });
        }
        this._statusTimer = setInterval(() => { if (this.isFocused) this.update(); },Firmware0408.UI_REFRESH_MS);
    }
    /** Local preparation requires a complete writable image, independently of hardware backups. */
    reason(ignoreOwnBusy = false) {
        const image = window.interface, state = window.AppState;
        if (!ignoreOwnBusy && (this.operationRunning || this.selectionRunning)) return 'Another operation is running.';
        if ((!ignoreOwnBusy && CoreFlasherDumpUi.busy()) || state.flipTdiBusy || state.flipTdiWriteBusy ||
            this.context.operations.otherCardBusy(this)) return 'Another operation is running.';
        if (!this.templateSlot) return 'Load a 0.40.8 dump or resource file.';
        if (!image || image.size !== Firmware0408.SIZE || !CoreFlasherDumpUi.complete(image)) return 'Load a complete 16 MiB working image.';
        if (state.interfaceMode !== 'rw-buffered' || (!ignoreOwnBusy && image.readOnly)) return 'Enable Read / Write in Dump / Flash.';
        return '';
    }
    resultCurrent() {
        return !!this.result && this.result.image === window.interface && this.result.revision === window.AppState.interfaceRevision;
    }
    /** Called at the destructive full-flash boundary, including flashes of unrelated images. */
    fullFlashStarted() {
        this.verifiedFlash = null;
        this.update();
    }
    /** Accept only the exact candidate hash after the full-image writer's readback check. */
    fullFlashVerified(sha256) {
        const hash = String(sha256).toLowerCase();
        if (this.result?.report.outputSha256 === hash) {
            this.verifiedFlash = {sha256:hash, verifiedAt:new Date().toISOString(),
                image:window.interface, revision:window.AppState.interfaceRevision};
        }
        this.update();
    }
    focus() { super.focus(); this.update(); }
    /** Keep only the verified slot, never the complete user dump. Cancelled dialogs retain it. */
    async loadTemplate(file) {
        if (this.operationRunning) return;
        const revision = ++this.selectionRevision;
        this.selectionRunning = true;
        this.templateSlot = null;this.templateName = '';
        this.result = null;this.verifiedFlash = null;this.errorElement.hidden = true;
        this.update();
        this.statusElement.textContent = 'Checking diagnostic firmware…';
        try {
            if (file.size > Firmware0408.SIZE) throw new Error('File exceeds the 16 MiB dump size limit.');
            const bytes = new Uint8Array(await file.arrayBuffer());
            const slot = await Firmware0408.template(bytes);
            if (revision !== this.selectionRevision) return;
            this.templateSlot = slot;
            this.templateName = file.name;
        } catch (error) {
            if (revision !== this.selectionRevision) return;
            this.errorElement.textContent = `Firmware file rejected: ${error.message}`;
            this.errorElement.hidden = false;
        } finally {
            if (revision === this.selectionRevision) {
                this.selectionRunning = false;
                this.update();
            }
        }
    }
    /** Present one actionable status; all detailed validation remains inside the builder. */
    update() {
        if (!this.prepareButton) return;
        const reason = this.reason();
        this.loadButton.disabled = this.operationRunning || this.selectionRunning;
        this.prepareButton.disabled = !!reason;
        this.prepareButton.textContent = this.operationRunning ? 'Preparing image…' : 'Prepare image';
        if (this.operationRunning || this.selectionRunning) return;
        const flashCurrent = this.verifiedFlash?.image === window.interface &&
            this.verifiedFlash?.revision === window.AppState.interfaceRevision;
        this.statusElement.textContent = this.verifiedFlash && flashCurrent
            ? 'Image flashed and verified. Choose your next step.'
            : reason || (this.resultCurrent()
                ? 'Image prepared. Save or flash it in Dump / Flash.'
                : `0.40.8 firmware loaded from ${this.templateName}. Ready to prepare the working image.`);
        this.updateStyles();
    }
    /** Build privately, verify, then replace only the sparse write overlay in one step. */
    async prepare() {
        if (this.reason()) { this.update(); return; }
        const state = window.AppState, image = window.interface, revision = state.interfaceRevision;
        const slot = this.templateSlot;
        this.operationRunning = true;state.firmwareBuildBusy = true;
        this.result = null;this.verifiedFlash = null;this.errorElement.hidden = true;
        this.update();this.context.hardware.refresh?.();
        try {
            this.statusElement.textContent = 'Preparing working image…';
            const source = image.subarray(0,image.size).slice();
            // Build against a private snapshot; publishing remains the final synchronous step.
            const built = await Firmware0408.build(source,slot,Firmware0408.fileTree.bind(Firmware0408));
            const staged = Firmware0408.stage(image,built.bytes);
            const unchanged = image === window.interface && revision === state.interfaceRevision &&
                Firmware0408.equal(image.subarray(0,image.size),source);
            if (!unchanged || this.reason(true)) throw new Error('Image or prerequisites changed during preparation; nothing was applied.');
            image.writeBuffer = staged;
            state.interfaceRevision = Number(state.interfaceRevision || 0) + 1;
            state.sourceFileName = 'core-flasher-alternative-candidate.bin';
            state.littlefsParser = null;state.littlefsParserSource = null;
            if (typeof LFS_IMAGE_PARSERS !== 'undefined') LFS_IMAGE_PARSERS.delete(image);
            this.result = {image,revision:state.interfaceRevision,report:built.report};
        } catch (error) {
            this.errorElement.textContent = `Preparation stopped: ${error.message}`;this.errorElement.hidden = false;
        } finally {
            this.operationRunning = false;state.firmwareBuildBusy = false;
            this.context.hardware.refresh?.();
            this.tileManager?.broadcastUpdate(this);this.update();
        }
    }
}
CoreFlasherApp.cardControllers["tile-boot-image"] = CardController;
})();
