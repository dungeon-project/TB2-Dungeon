
/** Dump / Flash presentation and action availability, Canvas 1.7.57.
 * Does not issue SPI/USB requests, change images or infer verification from a download.
 */
window.CoreFlasherDumpUi = class CoreFlasherDumpUi {
    constructor(tile) {
        this.tile = tile;
        this.root = tile.element;
        this.operation = null;
        this.verification = null;
        this.busy = false;
        this.dirtyCache = null;
        this.refresh = () => {};
    }
    static complete(image) {
        return !!image && Number.isInteger(image.size) && image.size > 0 &&
            typeof image._isRangeCovered === 'function' &&
            image._isRangeCovered(0, image.size, image.readBuffer) &&
            !(image.sourceType === 'fliptdi-live' && !image.completeSnapshot);
    }
    static busy(ignoreImageManager = false) {
        const s = window.AppState || {};
        return !!((!ignoreImageManager && s.imageManagerBusy) || s.interfaceOpening || s.flipTdiBusy || s.flipTdiReadBusy ||
            s.flipTdiDumpBusy || s.flipTdiWriteBusy || s.dumpFlashUiBusy || s.firmwareBuildBusy || s.wifiBusy || s.offlineModeBusy ||
            window.interface?.operationBusy);
    }
    text(selector, value) {
        const el = this.root.querySelector(selector);
        if (el && el.textContent !== String(value)) el.textContent = String(value);
    }
    show(selector, visible) {
        const el = this.root.querySelector(selector);
        if (el) el.hidden = !visible;
    }
    size(bytes) {
        if (!Number.isFinite(bytes)) return '—';
        return bytes >= 1048576 ? `${Number((bytes / 1048576).toFixed(2))} MiB` :
            bytes >= 1024 ? `${Number((bytes / 1024).toFixed(2))} KiB` : `${bytes} B`;
    }
    dirtyCount(image) {
        if (!image) return 0;
        const rev = Number(window.AppState.interfaceRevision || 0);
        const c = this.dirtyCache;
        if (c?.image === image && c.revision === rev && c.writes === image.writeBuffer &&
            c.reads === image.readBuffer) return c.count;
        const addresses = new Set();
        for (const segment of image.writeBuffer || []) {
            if (!segment?.data?.length) continue;
            const end = Math.min(image.size, segment.address + segment.data.length);
            for (let a = Math.floor(segment.address / 4096) * 4096; a < end; a += 4096) addresses.add(a);
        }
        let count = 0;
        for (const a of addresses) {
            const end = Math.min(a + 4096, image.size);
            if (!image._isRangeCovered(a, end - a, image.readBuffer)) { count++; continue; }
            const before = image._materializeReadRange(a, end);
            const after = image._materializeRange(a, end);
            if (before.some((byte, i) => byte !== after[i])) count++;
        }
        this.dirtyCache = { image, revision: rev, writes: image.writeBuffer, reads: image.readBuffer, count };
        return count;
    }
    model(ignoreLocalBusy = false) {
        const s = window.AppState || {}, image = window.interface;
        const hardware = ['fliptdi', 'pico', 'esp32c3'].includes(s.sourceInterface);
        const ready = hardware && !!s.flipTdiDetectedId && !!s.flipTdiReady && !s.flipTdiFault;
        const full = CoreFlasherDumpUi.complete(image);
        const backup = s.flipTdiOriginalBackup instanceof Uint8Array &&
            s.flipTdiOriginalBackup.length === 0x1000000 && !!s.flipTdiOriginalBackupInfo?.sha256;
        const otherTileBusy = this.tile.context.operations.otherCardBusy(this.tile);
        // Final prechecks ignore only this action's own write lock, never another operation.
        const ownWrite = ignoreLocalBusy && this.busy && ['write', 'full', 'fullCurrent'].includes(this.operation?.kind);
        const imageBusy = image?.operationBusy && !(ownWrite && image.operationLease === this.imageLease);
        const busy = !!(s.interfaceOpening || s.imageManagerBusy || s.firmwareBuildBusy || imageBusy || s.flipTdiBusy || s.flipTdiReadBusy ||
            s.flipTdiDumpBusy || (s.flipTdiWriteBusy && !ownWrite) || s.wifiBusy || s.offlineModeBusy || otherTileBusy || (!ignoreLocalBusy && this.busy));
        const pending = !!image?.writeBuffer?.some(segment => segment?.data?.length);
        const dirty = this.dirtyCount(image);
        const rw = s.interfaceMode === 'rw-buffered';
        const noReader = 'Connect a supported reader to use this hardware action.';
        const busyReason = busy ? 'Another operation is running.' : '';
        const readerReason = busyReason || (!ready ? noReader : '');
        const writeReason = (FirmwareImage.requiresFullImage(image) && !FirmwareImage.isSingleSlotLayout(image)
            ? 'Full-image flash required. Use Write fulldump.' : '') || readerReason ||
            (!s.flipTdiHostWriteAllowed ? 'The reader has not enabled flash writing.' : '') ||
            (s.flipTdiPhysicalStateUnknown ? 'Flash state is unverified. Compare with Verify Flash or restore a full image.' : '') ||
            (!full || !image?.completeSnapshot ? 'A complete image is required.' : '') ||
            (!rw ? 'Enable Read / Write first.' : '') || (!dirty ? 'No pending changes.' : '') ||
            (typeof s.flipTdiCommitBufferedWrite !== 'function' ? 'Flash writer is unavailable.' : '');
        return { image, hardware, ready, full, backup, pending, dirty, busy, rw,
            reasons: {
                create: readerReason ||
                    (typeof s.flipTdiWithReadSession !== 'function' ? 'Flash reader is unavailable.' : ''),
                load: busyReason || (!s.sourceInterface || !['disk', 'fliptdi', 'pico', 'esp32c3'].includes(s.sourceInterface)
                    ? 'Select Disk or a hardware reader in Interface first.' : ''),
                download: busyReason || (!backup ? 'No backup available.' : ''),
                write: writeReason,
                discard: busyReason || (!pending ? 'No pending changes.' : ''),
                export: busyReason || (!image ? 'Load an image first.' : !full
                    ? 'Create or load a complete image before exporting.' : ''),
                verify: readerReason || (!full || image?.size !== 0x1000000 ? 'A complete 16 MiB image is required.' : '') ||
                    (typeof s.flipTdiWithReadSession !== 'function' ? 'Flash reader is unavailable.' : ''),
                full: readerReason ||
                    (!s.flipTdiHostWriteAllowed ? 'The reader has not enabled flash writing.' : '') ||
                    (!image ? 'Load a working image first.' : '') ||
                    (!rw ? 'Enable Read / Write first.' : '') ||
                    (pending ? 'Write or discard pending changes first.' : '') ||
                    (typeof s.flipTdiFlashFullImage !== 'function' ? 'Full-image writer is unavailable.' : ''),
                fullCurrent: readerReason ||
                    (!s.flipTdiHostWriteAllowed ? 'The reader has not enabled flash writing.' : '') ||
                    (!full || image?.size !== FirmwareImage.SIZE || !image?.completeSnapshot ? 'A complete working image is required.' : '') ||
                    (!rw ? 'Enable Read / Write first.' : '') ||
                    (typeof s.flipTdiFlashFullImage !== 'function' ? 'Full-image writer is unavailable.' : '')
            }
        };
    }
    allow(action, explain = true, ignoreLocalBusy = false) {
        const reason = this.model(ignoreLocalBusy).reasons[action];
        if (reason && explain && !this.busy) this.message('Action unavailable', reason, 'warning');
        return !reason;
    }
    start(kind, title) {
        if (this.busy) throw new Error('DUMP_FLASH_BUSY: another operation owns the page.');
        const image = window.interface, state = window.AppState;
        const revision = state.interfaceRevision, source = state.sourceInterface, mode = state.interfaceMode;
        const reads = image?.readBuffer, writes = image?.writeBuffer;
        this.assertImageCurrent = () => {
            if (image !== window.interface || revision !== state.interfaceRevision || source !== state.sourceInterface ||
                mode !== state.interfaceMode || reads !== image?.readBuffer || writes !== image?.writeBuffer) {
                throw new Error('The working image changed during the operation. Its changes were retained.');
            }
        };
        this.imageLease = image?.acquireOperation('device', this.assertImageCurrent) ||
            {assertCurrent: this.assertImageCurrent, release() {}};
        if (['verify', 'write', 'full', 'fullCurrent'].includes(kind)) {
            this.verification = null;
            this.text('.js-df-verification-summary', '');
        }
        this.busy = true;
        this.tile.operationRunning = true;
        window.AppState.dumpFlashUiBusy = true;
        this.operation = { kind, title, status: 'running', message: 'Preparing…', percent: null, detail: '' };
        this.renderOperation();
        this.revealOperation();
        this.refresh();
        this.tile.context.hardware.refresh?.();
    }
    progress(message, percent = null, detail = '') {
        if (!this.operation || !this.busy) return;
        Object.assign(this.operation, { message, percent, detail });
        this.renderOperation();
    }
    finish(message, status = 'success', detail = '') {
        if (!this.operation) return;
        Object.assign(this.operation, { message, status, detail,
            percent: status === 'success' ? 100 : this.operation.percent });
        this.renderOperation();
        this.revealOperation();
    }
    release() {
        this.imageLease?.release();
        this.imageLease = null;
        this.busy = false;
        this.tile.operationRunning = false;
        window.AppState.dumpFlashUiBusy = false;
        this.refresh();
        this.tile.context.operations.refreshDiagnostic();
    }
    message(title, message, status = 'info') {
        if (this.busy) return;
        this.operation = { kind: 'message', title, message, status, percent: null, detail: '' };
        this.renderOperation();
        this.revealOperation();
    }
    rememberVerification(result) {
        const image = window.interface;
        this.verification = { result, image, revision: window.AppState.interfaceRevision,
            writes: image?.writeBuffer, reads: image?.readBuffer, source: window.AppState.sourceInterface,
            controller: window.AppState.hardwareController,
            readContext: window.AppState.hardwareController?.captureReadContext?.() };
    }
    revealOperation() {
        if (!this.tile.isFocused) return;
        const scroll = this.root.querySelector('.cf-dump-layout');
        const result = this.root.querySelector('.js-df-operation');
        if (!scroll || !result || result.hidden) return;
        // Scroll only the tile content, never the canvas, document or host iframe.
        const bounds = scroll.getBoundingClientRect(), item = result.getBoundingClientRect();
        if (item.bottom > bounds.bottom - 12) scroll.scrollTop += item.bottom - bounds.bottom + 12;
    }
    renderOperation() {
        const op = this.operation;
        this.show('.js-df-operation', !!op);
        if (!op) return;
        this.root.querySelector('.js-df-operation').dataset.state = op.status;
        this.text('.js-df-operation-title', op.title);
        this.text('.js-df-operation-message', op.message);
        this.text('.js-df-operation-detail', op.detail || '');
        this.show('.js-df-operation-detail', !!op.detail);
        const measured = Number.isFinite(op.percent);
        this.show('.js-df-progress-wrap', measured && op.status === 'running');
        const bar = this.root.querySelector('.js-df-progress');
        if (bar && measured) {
            const value = Math.max(0, Math.min(100, op.percent));
            bar.style.width = `${value}%`;
            bar.parentElement.setAttribute('aria-valuenow', String(Math.round(value)));
        }
        this.text('.js-df-operation-badge', { running: 'IN PROGRESS', success: 'COMPLETE',
            error: 'FAILED', warning: 'ATTENTION', info: 'INFO', cancelled: 'STOPPED' }[op.status] || '');
    }
    render() {
        const s = window.AppState || {}, m = this.model(), image = m.image;
        const names = { disk: 'Disk', fliptdi: 'Flipper Zero', esp32c3: 'ESP32-C3', pico: 'Pico' };
        this.text('.js-df-source', names[s.sourceInterface] || 'No source selected');
        this.text('.js-df-connection', m.hardware ? (m.ready ? 'Connected' : 'Not ready') :
            s.sourceInterface === 'disk' ? 'File workflow' : 'No reader connected');
        this.text('.js-df-context-image', image ? (s.sourceFileName || 'Current image') : 'No image');
        this.text('.js-df-context-size', image ? this.size(image.size) : '—');
        this.text('.js-df-image-name', image ? (s.sourceFileName || 'Current image') : 'No image loaded');
        this.text('.js-df-image-size', image ? this.size(image.size) : '—');
        this.text('.js-df-image-complete', image ? (m.full ? 'Complete image' : 'Partially cached live image') : '');
        this.text('.js-df-changes-title', m.pending ? 'Changes ready to save' : 'No pending changes');
        this.text('.js-buffered-write-status', m.pending ? `${m.dirty} sector${m.dirty === 1 ? '' : 's'} · ${this.size(m.dirty * 4096)}` : '0 sectors');
        this.text('.js-df-changes-note', m.pending
            ? 'Prepared in memory. Not yet written to the device.'
            : 'Save the working image, or edit it using the image tools before writing to the box.');
        const info = s.flipTdiOriginalBackupInfo || {};
        this.text('.js-df-backup-name', m.backup ? info.filename || 'Original backup' : 'No backup selected');
        this.text('.js-df-backup-size', m.backup ? this.size(s.flipTdiOriginalBackup.length) : '—');
        const loaded = info.source === 'loaded-verified-backup';
        const readTwice = m.backup && !loaded && !!info.verifiedAt;
        this.text('.js-df-backup-origin', !m.backup ? 'Create a device backup or load an existing BIN.' :
            loaded ? 'Loaded from file · SHA-256 calculated locally.' : readTwice
                ? 'Created from two matching device reads.' : 'Existing backup · provenance not recorded.');
        this.text('.js-webusb-dump-verified', !m.backup ? 'NOT AVAILABLE' : loaded ? 'FILE LOADED' : readTwice ? 'TWO READS MATCHED' : 'AVAILABLE');
        this.text('.js-df-backup-note', m.backup
            ? 'This original backup is kept separate from the working image. Loading a file does not verify the current device.'
            : 'Keeping a recovery backup is recommended. A separate backup is optional.');
        this.text('.js-webusb-full-verify', m.backup ? 'Refresh Backup' : 'Create Backup');
        this.show('.js-df-hardware-note', !m.ready);
        this.show('.js-df-physical-warning', !!s.flipTdiPhysicalStateUnknown);
        const controls = { create: '.js-webusb-full-verify', load: '.js-webusb-load-verified',
            download: '.js-webusb-download-verified', write: '.js-write-now-btn', discard: '.js-discard-changes',
            export: '.js-df-save-image', verify: '.js-verify-current', full: '.js-full-image-flash', fullCurrent: '.js-write-fulldump' };
        for (const [action, selector] of Object.entries(controls)) {
            const el = this.root.querySelector(selector), reason = m.reasons[action];
            if (el) { el.disabled = !!reason; el.title = reason || ''; }
            const alreadyExplained = reason === 'Connect a supported reader to use this hardware action.' ||
                reason === 'No pending changes.' || reason === 'No backup available.';
            this.text(`.js-df-reason-${action}`, alreadyExplained ? '' : (reason || ''));
        }
        // Move the one full-image action into the primary slot for builder outputs.
        const fullRequired = FirmwareImage.requiresFullImage(image);
        const fullButton = this.root.querySelector('.js-write-fulldump');
        const fullSlot = this.root.querySelector(fullRequired ? '.js-primary-full-slot' : '.js-secondary-full-slot');
        if (fullButton && fullSlot && fullButton.parentElement !== fullSlot) fullSlot.appendChild(fullButton);
        this.show('.js-write-now-btn', !fullRequired || FirmwareImage.isSingleSlotLayout(image));
        if (fullRequired && !FirmwareImage.isSingleSlotLayout(image)) {
            this.text('.js-df-reason-write', m.reasons.fullCurrent || 'This prepared image requires a full-image write.');
        }
        const modeReason = m.busy ? 'Another operation is running.' : !image ? 'Load an image first.' :
            m.hardware && !m.full ? 'Load or read a complete working image to enable Read / Write.' : '';
        this.text('.js-df-mode-reason', modeReason);
        for (const input of this.root.querySelectorAll('.js-iface-mode')) {
            if (m.busy || !image) input.disabled = true;
        }
        const v = this.verification;
        if (v) {
            let sessionChanged = s.hardwareController !== v.controller || !m.ready;
            try { v.controller?.assertReadContext(v.readContext); }
            catch { sessionChanged = true; }
            const changed = image !== v.image || s.interfaceRevision !== v.revision ||
                image?.writeBuffer !== v.writes || image?.readBuffer !== v.reads ||
                s.sourceInterface !== v.source || sessionChanged;
            const message = !changed ? v.result : image === v.image && image?.readBuffer === v.reads && !sessionChanged
                ? 'Working image edited. Write Changes checks the device baseline and changed sectors before writing.'
                : 'Previous comparison belongs to an earlier image or device state.';
            this.text('.js-df-verification-summary', message);
            if (changed && this.operation?.kind === 'verify' && this.operation.status !== 'running') {
                this.operation.status = 'warning';
                this.operation.message = message;
                this.renderOperation();
            }
        }
        this.text('.js-webusb-options-chip', s.flipTdiDetectedId || 'not detected');
        this.text('.js-webusb-mode-badge', m.rw ? 'Read / Write' : 'Read Only');
        const stop = this.root.querySelector('.js-webusb-dump-stop');
        if (stop) {
            // Existing full-dump cancellation only. No new abort protocol is introduced.
            const available = !!s.flipTdiDumpBusy && this.operation?.kind === 'backup';
            stop.hidden = !available; stop.classList.toggle('hidden', !available);
            stop.disabled = !available || !!s.flipTdiDumpAbort;
        }
    }
};
