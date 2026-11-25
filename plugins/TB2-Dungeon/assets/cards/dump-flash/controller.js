/* Dump / Flash controller. Shared services are supplied by the card context. */
(() => {
// === Interface options: access-mode UI and explicit flush ===

class CardController extends Tile {

    /**
     * Initialize component fields, event handlers, and state synchronization.
     * @returns {void}
     */
    init() {
        this.context.identity?.bindStatus(this, 'image');
        this.wasActivated = false;
        this._lastSeenLoadedImageRevision = Number(window.AppState.interfaceLoadRevision || 0);
        this._hasUnseenInterfaceChange = false;
        const writeNowBtn = this.element.querySelector('.js-write-now-btn');
        const fullImageFlashBtn = this.element.querySelector('.js-full-image-flash');
        const fullImageInput = this.element.querySelector('.js-full-image-input');
        const verifyCurrentBtn = this.element.querySelector('.js-verify-current');
        const verifyCurrentStatus = this.element.querySelector('.js-verify-current-status');
        const verifyCurrentProgress = this.element.querySelector('.js-verify-current-progress');
        const modeInputs = this.element.querySelectorAll('.js-iface-mode');
        const modeRows = this.element.querySelectorAll('.js-iface-mode-row');
        const bufferedStatus = this.element.querySelector('.js-buffered-write-status');
        const webUsbNote = this.element.querySelector('.js-webusb-readonly-note');
        const webUsbPanel = this.element.querySelector('.js-webusb-readonly-panel');
        const webUsbChip = this.element.querySelector('.js-webusb-options-chip');
        const webUsbReadToolsState = this.element.querySelector('.js-webusb-read-tools-state');
        const webUsbReadAddress = this.element.querySelector('.js-webusb-read-address');
        const webUsbReadLength = this.element.querySelector('.js-webusb-read-length');
        const webUsbRead256 = this.element.querySelector('.js-webusb-read-256');
        const webUsbRead4k = this.element.querySelector('.js-webusb-read-4k');
        const webUsbReadRange = this.element.querySelector('.js-webusb-read-range');
        const webUsbReadProgress = this.element.querySelector('.js-webusb-read-progress');
        const webUsbReadResultState = this.element.querySelector('.js-webusb-read-result-state');
        const webUsbReadHexdump = this.element.querySelector('.js-webusb-read-hexdump');
        const webUsbFullVerify = this.element.querySelector('.js-webusb-full-verify');
        const webUsbDumpStop = this.element.querySelector('.js-webusb-dump-stop');
        const webUsbDumpProgress = this.element.querySelector('.js-webusb-dump-progress');
        const webUsbDumpStatus = this.element.querySelector('.js-webusb-dump-status');
        const fullImageProgress = webUsbDumpProgress;
        const fullImageStatus = webUsbDumpStatus;
        const webUsbDumpHash1 = this.element.querySelector('.js-webusb-dump-hash1');
        const webUsbDumpHash2 = this.element.querySelector('.js-webusb-dump-hash2');
        const webUsbDumpVerified = this.element.querySelector('.js-webusb-dump-verified');
        const webUsbDownloadVerified = this.element.querySelector('.js-webusb-download-verified');
        const webUsbLoadVerified = this.element.querySelector('.js-webusb-load-verified');
        const webUsbLoadVerifiedInput = this.element.querySelector('.js-webusb-load-verified-input');
        const discardChangesBtn = this.element.querySelector('.js-discard-changes');
        const writeProgressWrap = this.element.querySelector('.js-write-progress-wrap');
        const writeProgress = this.element.querySelector('.js-write-progress');
        const writeStatus = this.element.querySelector('.js-write-status');
        const modeBadge = this.element.querySelector('.js-webusb-mode-badge');
        const immediateModeRow = this.element.querySelector('.js-immediate-mode-row');
        const webUsbReadButtons = [webUsbRead256, webUsbRead4k, webUsbReadRange].filter(Boolean);
        window.AppState.interfaceMode = window.AppState.interfaceMode || 'readonly';
        const ui = new CoreFlasherDumpUi(this);
        this._dumpUi = ui;
        this.offlineMode = new OfflineModeController(this);
        const saveWorkingImageBtn = this.element.querySelector('.js-df-save-image');
        saveWorkingImageBtn.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            if (!ui.allow('export')) return;
            try {
                const name = this.context.image.exportCurrent();
                ui.message('Image export', `Download started: ${name}. Pending changes and original backup are unchanged.`);
            } catch (error) { ui.message('Image export failed', String(error.message || error), 'error'); }
        });

        const sectorsEqual = (left, right) => {
            if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) ||
                left.length !== right.length) return false;
            for (let i = 0; i < left.length; i++) {
                if (left[i] !== right[i]) return false;
            }
            return true;
        };

        const collectDirtySectors = (image = window.interface) => {
            if (!image || !image.completeSnapshot || !Array.isArray(image.writeBuffer) ||
                image.writeBuffer.length === 0) return [];
            const SECTOR = 0x1000;
            const candidates = new Set();
            for (const segment of image.writeBuffer) {
                if (!segment?.data?.length) continue;
                const first = Math.floor(segment.address / SECTOR) * SECTOR;
                const last = Math.floor((segment.address + segment.data.length - 1) / SECTOR) * SECTOR;
                for (let address = first; address <= last; address += SECTOR) candidates.add(address);
            }
            const result = [];
            for (const address of [...candidates].sort((a, b) => a - b)) {
                const before = image._materializeReadRange(address, address + SECTOR);
                const after = image._materializeRange(address, address + SECTOR);
                if (!sectorsEqual(before, after)) result.push({address, before, after});
            }
            return result;
        };

        const buildExpectedImage = (image, dirtySectors) => {
            if (!image?.completeSnapshot || !image._isRangeCovered(0, image.size, image.readBuffer)) {
                throw new Error('A complete verified baseline is required before writing.');
            }
            const expected = image._materializeReadRange(0, image.size);
            for (const sector of dirtySectors) expected.set(sector.after, sector.address);
            return expected;
        };

        const resetParsersAfterImageChange = (image) => {
            window.AppState.littlefsParser = null;
            window.AppState.littlefsParserSource = null;
            window.AppState.interfaceRevision = Number(window.AppState.interfaceRevision || 0) + 1;
            if (typeof LFS_IMAGE_PARSERS !== 'undefined') LFS_IMAGE_PARSERS.delete(image);
            this.tileManager?.broadcastUpdate(this);
        };

        /** Reject a late editor/source change before replacing any buffered image state. */
        const assertWorkingImage = (image, expected) => {
            ui.assertImageCurrent();
            if (expected && !FirmwareImage.equal(image.subarray(0, image.size), expected)) {
                throw new Error('The working image bytes changed during the operation. Changes were retained.');
            }
        };

        /** Adopt an exact device read using owned bytes; keep the old overlay on a stale receipt. */
        const adoptVerifiedReadback = async (image, actual, readContext, expected, hash = null) => {
            assertWorkingImage(image, expected);
            const controller = window.AppState.hardwareController;
            const revision = window.AppState.interfaceRevision;
            const wasSaved = window.AppState.interfaceSavedRevision === revision;
            const previous = Object.fromEntries(['readBuffer', 'writeBuffer', 'readDataCallback',
                'writeDataCallback', 'flushPrepareCallback', 'completeSnapshot', 'sourceType', 'verifiedSha256']
                .map(key => [key, image[key]]));
            const reads = [{address: 0, data: actual.slice()}], writes = [];
            Object.assign(image, {readBuffer: reads, writeBuffer: writes, readDataCallback: null,
                writeDataCallback: null, flushPrepareCallback: null, completeSnapshot: true,
                sourceType: 'fliptdi-verified', verifiedSha256: hash});
            try {
                if (!await controller.rememberBaseline(image, actual, readContext)) throw new Error('Device readback does not match the working baseline.');
                if (window.interface !== image || window.AppState.interfaceRevision !== revision ||
                    window.AppState.hardwareController !== controller || image.readBuffer !== reads || image.writeBuffer !== writes) {
                    throw new Error('The source changed before the verified image could be accepted.');
                }
                controller.assertReadContext(readContext);
            } catch (error) {
                if (image.readBuffer === reads && image.writeBuffer === writes) Object.assign(image, previous);
                controller.forgetBaseline();
                throw error;
            }
            resetParsersAfterImageChange(image);
            if (wasSaved) window.AppState.interfaceSavedRevision = window.AppState.interfaceRevision;
        };

        /**
         * Reflect the shared interface mode in the radio inputs.
         * @returns {void}
         */
        const updateModeUI = () => {
            const isWebUsb = ['fliptdi', 'pico', 'esp32c3'].includes(window.AppState.sourceInterface);
            const image = window.interface;
            const hasVerifiedBackup = !FirmwareImage.backupReason(window.AppState);
            // Buffered edits are local; hardware admission applies only when flashing.
            const bufferedAvailable = CoreFlasherDumpUi.complete(image);

            if (isWebUsb && window.AppState.interfaceMode === 'rw-immediate') {
                window.AppState.interfaceMode = 'readonly';
            }
            if (isWebUsb && window.AppState.interfaceMode === 'rw-buffered' && !bufferedAvailable) {
                window.AppState.interfaceMode = 'readonly';
            }

            document.querySelectorAll('.js-enable-edit').forEach(button => {
                button.hidden = window.AppState.interfaceMode === 'rw-buffered';
                button.disabled = !bufferedAvailable || CoreFlasherDumpUi.busy();
            });
            this.element.dataset.category = window.AppState.interfaceMode === 'readonly' ? 'edit' : 'flash';
            modeInputs.forEach(input => {
                if (isWebUsb && input.value === 'rw-buffered') {
                    input.disabled = !bufferedAvailable;
                } else if (isWebUsb && input.value === 'rw-immediate') {
                    input.disabled = true;
                } else {
                    input.disabled = false;
                }
                input.checked = input.value === window.AppState.interfaceMode;
            });

            modeRows.forEach(row => {
                const mode = row.dataset.mode;
                const disabled = isWebUsb &&
                    ((mode === 'rw-buffered' && !bufferedAvailable) || mode === 'rw-immediate');
                row.classList.toggle('opacity-35', disabled);
                row.classList.toggle('cursor-not-allowed', disabled);
            });
            immediateModeRow?.classList.toggle('hidden', isWebUsb);

            if (image) {
                // Operation leases guard concurrent work; the selected mode owns edit permission.
                image.readOnly = window.AppState.interfaceMode === 'readonly';
            }

            if (webUsbPanel) webUsbPanel.classList.toggle('hidden', !isWebUsb);
            if (webUsbChip) {
                webUsbChip.textContent = String(window.AppState.flipTdiDetectedId || 'not detected');
            }
            if (modeBadge) {
                modeBadge.textContent = window.AppState.interfaceMode === 'rw-buffered'
                    ? (window.DEV_MODE ? 'Buffered' : 'Read / Write')
                    : 'Read Only';
            }

            const dumpBusy = Boolean(window.AppState.flipTdiDumpBusy);
            const writeBusy = Boolean(window.AppState.flipTdiWriteBusy);
            const ioBusy = Boolean(window.AppState.flipTdiBusy) ||
                Boolean(window.AppState.flipTdiReadBusy) || dumpBusy || writeBusy || ui.busy;
            const ready = isWebUsb && Boolean(window.AppState.flipTdiDetectedId) &&
                Boolean(window.AppState.flipTdiReady) && !window.AppState.flipTdiFault;
            const dirty = collectDirtySectors(image);
            const genericPending = Array.isArray(image?.writeBuffer) &&
                image.writeBuffer.some(segment => segment?.data?.length);

            if (webUsbFullVerify) {
                webUsbFullVerify.disabled = !ready || ioBusy;
                webUsbFullVerify.textContent = hasVerifiedBackup
                    ? 'Refresh Backup' : 'Create Backup';
            }
            if (webUsbDumpStop) {
                webUsbDumpStop.disabled = !dumpBusy;
                webUsbDumpStop.classList.toggle('hidden', !dumpBusy);
            }
            if (webUsbLoadVerified) {
                webUsbLoadVerified.disabled = ioBusy;
            }
            if (webUsbDownloadVerified) {
                webUsbDownloadVerified.disabled =
                    !(window.AppState.flipTdiOriginalBackup instanceof Uint8Array) || ioBusy;
            }
            if (webUsbDumpVerified) {
                webUsbDumpVerified.textContent = hasVerifiedBackup ? 'VERIFIED' : 'NOT VERIFIED';
                webUsbDumpVerified.classList.toggle('text-secondary', hasVerifiedBackup);
                webUsbDumpVerified.classList.toggle('text-zinc-400', !hasVerifiedBackup);
            }
            if (webUsbDumpHash1) {
                const hash = window.AppState.flipTdiOriginalBackupInfo?.sha256 || '';
                webUsbDumpHash1.textContent = hash ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : '-';
                webUsbDumpHash1.title = hash;
            }


            const canWebUsbWrite =
                !!window.AppState.flipTdiHostWriteAllowed &&
                !window.AppState.flipTdiPhysicalStateUnknown &&
                bufferedAvailable &&
                window.AppState.interfaceMode === 'rw-buffered' &&
                dirty.length > 0 && ready && !ioBusy;
            const canGenericWrite = !isWebUsb &&
                window.AppState.interfaceMode === 'rw-buffered' &&
                genericPending && !ioBusy;

            if (writeNowBtn) {
                writeNowBtn.disabled = !(canWebUsbWrite || canGenericWrite);
                writeNowBtn.title = isWebUsb && !window.AppState.flipTdiHostWriteAllowed
                    ? 'Flash write capability was not verified by the WREN/WRDI probe.'
                    : isWebUsb && window.AppState.flipTdiPhysicalStateUnknown
                        ? 'Physical flash state is unknown. Run Verify Flash or restore a full image.'
                        : '';
            }

            const canFullImageFlash =
                isWebUsb &&
                !!window.AppState.flipTdiHostWriteAllowed &&
                ready &&
                !ioBusy &&
                window.AppState.interfaceMode === 'rw-buffered' &&
                dirty.length === 0 &&
                typeof window.AppState.flipTdiFlashFullImage === 'function';

            if (fullImageFlashBtn) {
                fullImageFlashBtn.disabled = !canFullImageFlash;
                fullImageFlashBtn.title =
                    !window.AppState.flipTdiHostWriteAllowed ? 'Flash write capability is not available.' :
                    window.AppState.interfaceMode !== 'rw-buffered' ? 'Enable Read / Write Buffered first.' :
                    dirty.length > 0 ? 'Discard or commit buffered changes before full-image flashing.' :
                    '';
            }
            if (discardChangesBtn) {
                discardChangesBtn.disabled = isWebUsb
                    ? dirty.length === 0 || ioBusy
                    : !genericPending || ioBusy;
            }

            const canVerifyCurrent =
                isWebUsb &&
                ready &&
                !ioBusy &&
                image?.completeSnapshot === true &&
                image?._isRangeCovered(0, image.size, image.readBuffer) &&
                typeof window.AppState.flipTdiWithReadSession === 'function';

            if (verifyCurrentBtn) verifyCurrentBtn.disabled = !canVerifyCurrent;

            const diagnosticsReadable = isWebUsb && ready && !ioBusy;
            for (const button of webUsbReadButtons) button.disabled = !diagnosticsReadable;
            if (webUsbReadAddress) webUsbReadAddress.disabled = !diagnosticsReadable;
            if (webUsbReadLength) webUsbReadLength.disabled = !diagnosticsReadable;
            ui.render();
        };

        /**
         * Display pending sparse-image byte and segment counts.
         * @returns {void}
         */
        const updateBufferedStatus = () => { ui.render(); };
        ui.refresh = () => { updateModeUI(); ui.render(); };

        // Persist the init-local UI helpers on the tile instance.
        // update() is a class method and cannot directly see init()'s lexical closures.
        this._updateModeUI = updateModeUI;
        this._updateBufferedStatus = updateBufferedStatus;

        /** One shared mode command serves radios and card-local edit actions. */
        this.setEditMode = mode => {
            if (!['readonly', 'rw-buffered', 'rw-immediate'].includes(mode) || ui.model().busy) return false;
            const option = [...modeInputs].find(input => input.value === mode);
            if (!option || option.disabled || (mode !== 'readonly' && !CoreFlasherDumpUi.complete(window.interface))) return false;
            window.AppState.interfaceMode = mode;
            if (window.interface) window.interface.readOnly = mode === 'readonly';
            updateModeUI(); updateBufferedStatus(); this.tileManager?.broadcastUpdate(this);
            return true;
        };
        modeInputs.forEach(input => input.addEventListener('change', () => {
            if (input.checked) this.setEditMode(input.value);
        }));
        const parseReadAddress = () => {
            const raw = String(webUsbReadAddress?.value || '').trim();
            if (!/^(?:0x)?[0-9a-f]{1,6}$/i.test(raw)) {
                throw new Error('Address must contain 1..6 hex digits, optionally prefixed with 0x.');
            }
            const value = Number.parseInt(raw.replace(/^0x/i, ''), 16);
            if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFF) {
                throw new Error('Address must be a 24-bit hex value from 0x000000 to 0xFFFFFF.');
            }
            return value;
        };

        const formatReadAddress = (address) =>
            `0x${Number(address).toString(16).padStart(6, '0').toUpperCase()}`;

        const hexdump = (bytes, baseAddress) => {
            const lines = [];
            for (let offset = 0; offset < bytes.length; offset += 16) {
                const row = bytes.slice(offset, Math.min(offset + 16, bytes.length));
                const hex = Array.from(row)
                    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
                    .join(' ')
                    .padEnd(16 * 3 - 1, ' ');
                const ascii = Array.from(row)
                    .map(byte => byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : '.')
                    .join('');
                lines.push(
                    `${(baseAddress + offset).toString(16).padStart(6, '0').toUpperCase()}  ${hex}  |${ascii}|`);
            }
            return lines.join('\n');
        };

        const runWebUsbRead = async (requestedLength) => {
            if (ui.model().busy) {
                throw new Error('USB_BUSY: another operation is active.');
            }
            const readFn = window.AppState.flipTdiReadRange;
            if (typeof readFn !== 'function') {
                throw new Error('Flipper USB bridge read backend is not ready.');
            }

            const address = parseReadAddress();
            const length = Number(requestedLength);

            if (!Number.isInteger(length) || length < 1 || length > 65536) {
                throw new Error('Length must be between 1 and 65536 bytes.');
            }
            if (address + length > 0x1000000) {
                throw new Error('Read range exceeds the 16 MiB W25Q128 address space.');
            }

            window.AppState.flipTdiReadBusy = true;
            updateModeUI();

            if (webUsbReadResultState) {
                webUsbReadResultState.textContent =
                    `READING ${formatReadAddress(address)} + ${length} byte(s)...`;
                webUsbReadResultState.classList.remove('text-secondary', 'text-error');
                webUsbReadResultState.classList.add('text-zinc-400');
            }
            if (webUsbReadHexdump) webUsbReadHexdump.textContent = '';
            if (webUsbReadProgress) webUsbReadProgress.style.width = '0%';

            try {
                const bytes = await readFn(address, length, (done, total) => {
                    const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
                    if (webUsbReadProgress) webUsbReadProgress.style.width = `${percent}%`;
                    if (webUsbReadResultState) {
                        webUsbReadResultState.textContent =
                            `READING ${formatReadAddress(address)}: ${done}/${total} byte(s)`;
                    }
                });

                if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
                    throw new Error(
                        `Read backend returned ${bytes?.length ?? 0} bytes; expected ${length}.`);
                }

                if (webUsbReadProgress) webUsbReadProgress.style.width = '100%';
                if (webUsbReadResultState) {
                    webUsbReadResultState.textContent =
                        `READ_OK: ${formatReadAddress(address)}..${formatReadAddress(address + length - 1)} (${length} bytes)`;
                    webUsbReadResultState.classList.remove('text-zinc-400', 'text-error');
                    webUsbReadResultState.classList.add('text-secondary');
                }
                if (webUsbReadHexdump) {
                    webUsbReadHexdump.textContent = hexdump(bytes, address);
                }

                window.AppState.flipTdiLastRead = {
                    address,
                    length,
                    bytes: bytes.slice(),
                };
            } catch (error) {
                if (webUsbReadResultState) {
                    webUsbReadResultState.textContent =
                        `READ_FAILED: ${String(error?.message || error)}`;
                    webUsbReadResultState.classList.remove('text-zinc-400', 'text-secondary');
                    webUsbReadResultState.classList.add('text-error');
                }
                if (webUsbReadProgress) webUsbReadProgress.style.width = '0%';
                throw error;
            } finally {
                window.AppState.flipTdiReadBusy = false;
                updateModeUI();
                this.context.hardware.refresh?.();
            }
        };

        webUsbRead256?.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (webUsbReadLength) webUsbReadLength.value = '256';
            try {
                await runWebUsbRead(256);
            } catch (error) {
                console.error('WebUSB 256-byte read failed:', error);
            }
        });

        webUsbRead4k?.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (webUsbReadLength) webUsbReadLength.value = '4096';
            try {
                await runWebUsbRead(4096);
            } catch (error) {
                console.error('WebUSB 4-KiB read failed:', error);
            }
        });

        webUsbReadRange?.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await runWebUsbRead(Number(webUsbReadLength?.value || 0));
            } catch (error) {
                console.error('WebUSB range read failed:', error);
            }
        });

        const sha256Hex = async (bytes) => {
            if (!(bytes instanceof Uint8Array)) {
                throw new Error('SHA-256 input is not a Uint8Array.');
            }
            const digest = await crypto.subtle.digest(
                'SHA-256',
                bytes
            );
            return Array.from(new Uint8Array(digest))
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase();
        };

        const setDumpProgress = (stage, done, total) => {
            const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;

            // The complete workflow has two equally sized full-flash reads.
            const overall = stage === 1
                ? fraction * 50
                : 50 + fraction * 50;

            if (webUsbDumpProgress) {
                webUsbDumpProgress.style.width = `${overall}%`;
            }
            ui.progress(`Reading backup ${stage}/2 · ${Math.floor(fraction * 100)}%`, overall);
            if (webUsbDumpStatus) {
                webUsbDumpStatus.textContent =
                    `DUMP_${stage}: ${done}/${total} bytes (${(fraction * 100).toFixed(1)}%) | ` +
                    `overall ${overall.toFixed(1)}%`;
            }
        };

        const makeVerifiedDumpFilename = () => {
            const date = new Date();
            const pad = value => String(value).padStart(2, '0');
            const stamp =
                `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
                `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
            return `W25Q128FV_verified_${stamp}.bin`;
        };

        const clearDumpVerificationState = () => {
            window.AppState.flipTdiDumpAbort = false;
            window.AppState.flipTdiDumpHash1 = null;
            window.AppState.flipTdiDumpHash2 = null;
            for (const key of ['flipTdiDump1Mismatch', 'flipTdiDump2']) {
                if (window.AppState[key] instanceof Uint8Array) window.AppState[key].fill(0);
                window.AppState[key] = null;
            }

            if (webUsbDumpHash1) webUsbDumpHash1.textContent = '-';
            if (webUsbDumpHash2) webUsbDumpHash2.textContent = '-';
            if (webUsbDumpVerified) {
                webUsbDumpVerified.textContent = 'not verified';
                webUsbDumpVerified.classList.remove('text-secondary', 'text-error');
                webUsbDumpVerified.classList.add('text-zinc-400');
            }
            if (webUsbDumpStatus) {
                webUsbDumpStatus.textContent = window.DEV_MODE ? 'DUMP_VERIFICATION_IDLE' : 'Ready';
                webUsbDumpStatus.classList.remove('text-secondary', 'text-error');
                webUsbDumpStatus.classList.add('text-zinc-500');
            }
            if (webUsbDumpProgress) webUsbDumpProgress.style.width = '0%';
        };

        webUsbDumpStop?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            if (!window.AppState.flipTdiDumpBusy) return;

            window.AppState.flipTdiDumpAbort = true;
            window.AppState.flipTdiRequestStop?.();
            ui.progress('Stopping after the current SPI block…', ui.operation?.percent);
            if (webUsbDumpStatus) {
                webUsbDumpStatus.textContent =
                    'STOP_REQUESTED: current SPI block will finish, then dumping stops.';
            }
        });

        webUsbFullVerify?.addEventListener('click', async event => {
            if (!ui.allow('create')) return;
            window.AppState.flipTdiLastOperationStatus = null;
            event.preventDefault();
            event.stopPropagation();

            if (window.AppState.flipTdiDumpBusy || window.AppState.flipTdiReadBusy || window.AppState.flipTdiBusy) return;

            const readFn = window.AppState.flipTdiReadRange;
            if (typeof readFn !== 'function') {
                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent = 'DUMP_FAILED: Flipper USB bridge read backend is not ready.';
                }
                return;
            }

            if (!window.AppState.flipTdiReady ||
                !window.AppState.flipTdiDetectedId) {
                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent =
                        'DUMP_FAILED: connect a supported reader and detect the chip.';
                }
                return;
            }

            const FLASH_SIZE = 0x1000000;
            let dump1 = null;
            let dump2 = null;

            clearDumpVerificationState();
            ui.start('backup', 'Create device backup');
            window.AppState.flipTdiDumpBusy = true;
            window.AppState.flipTdiDumpAbort = false;
            updateModeUI();

            try {
                await window.AppState.flipTdiWithReadSession(async (readFn, assertSession, readContext) => {
                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent = window.DEV_MODE
                        ? 'DUMP_1_START: reading complete 16 MiB flash...'
                        : 'Reading flash for backup (1/2)...';
                }

                dump1 = await readFn(0, FLASH_SIZE, (done, total) => {
                    if (window.AppState.flipTdiDumpAbort) {
                        throw new Error('Dump verification cancelled by user.');
                    }
                    setDumpProgress(1, done, total);
                });

                if (window.AppState.flipTdiDumpAbort) {
                    throw new Error('Dump verification cancelled by user.');
                }

                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent = window.DEV_MODE
                        ? 'DUMP_1_COMPLETE: calculating SHA-256...'
                        : 'Checking first backup read...';
                }

                if (!(dump1 instanceof Uint8Array) || dump1.length !== FLASH_SIZE) {
                    throw new Error('Incomplete first dump.');
                }
                const hash1 = await sha256Hex(dump1);
                assertSession();
                if (window.AppState.flipTdiDumpAbort) throw new Error('Dump verification cancelled by user.');
                window.AppState.flipTdiDumpHash1 = hash1;
                ui.progress('Reading flash for backup (2/2)…', 50);
                if (webUsbDumpHash1) webUsbDumpHash1.textContent = hash1;

                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent = window.DEV_MODE
                        ? 'DUMP_2_START: performing independent second 16 MiB read...'
                        : 'Reading flash for backup (2/2)...';
                }

                dump2 = await readFn(0, FLASH_SIZE, (done, total) => {
                    if (window.AppState.flipTdiDumpAbort) {
                        throw new Error('Dump verification cancelled by user.');
                    }
                    setDumpProgress(2, done, total);
                });

                if (window.AppState.flipTdiDumpAbort) {
                    throw new Error('Dump verification cancelled by user.');
                }

                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent = window.DEV_MODE
                        ? 'DUMP_2_COMPLETE: calculating SHA-256...'
                        : 'Verifying backup...';
                }

                if (!(dump2 instanceof Uint8Array) || dump2.length !== FLASH_SIZE) {
                    throw new Error('Incomplete second dump.');
                }
                const hash2 = await sha256Hex(dump2);
                assertSession();
                if (window.AppState.flipTdiDumpAbort) throw new Error('Dump verification cancelled by user.');
                window.AppState.flipTdiDumpHash2 = hash2;
                ui.progress('Comparing the two backup reads…', 100);
                if (webUsbDumpHash2) webUsbDumpHash2.textContent = hash2;

                if (hash1 === hash2) {
                    assertWorkingImage(window.interface);
                    const info = {
                        sha256: hash1, size: FLASH_SIZE, jedec: window.AppState.flipTdiDetectedId,
                        filename: makeVerifiedDumpFilename(), verifiedAt: new Date().toISOString(), source: 'two-matching-device-reads'
                    };
                    let matches;
                    if (!CoreFlasherDumpUi.complete(window.interface)) {
                        await window.AppState.flipTdiPromoteVerifiedDump(dump1, info, readContext, ui.imageLease);
                        matches = true;
                    } else {
                        const image = window.interface;
                        const currentBytes = image.subarray(0, image.size).slice();
                        if (FirmwareImage.equal(dump1, currentBytes)) {
                            await adoptVerifiedReadback(image, dump1, readContext, currentBytes, hash1);
                            matches = true;
                        } else {
                            matches = await readContext.controller.rememberBaseline(image, dump1, readContext);
                            assertWorkingImage(image, currentBytes);
                        }
                    }
                    readContext.controller.assertReadContext(readContext);
                    // The recovery copy and working image never share mutable storage.
                    window.AppState.flipTdiVerifiedDump = dump1.slice();
                    window.AppState.flipTdiVerifiedDumpInfo = info;
                    window.AppState.flipTdiOriginalBackup = dump1.slice();
                    window.AppState.flipTdiOriginalBackupInfo = {...info};
                    if (matches) window.AppState.flipTdiPhysicalStateUnknown = false;

                    dump1.fill(0);
                    dump1 = null;

                    // User requested that one duplicate be deleted after successful verification.
                    // Zero dump #2 before dropping all application references to it.
                    dump2.fill(0);
                    dump2 = null;
                    window.AppState.flipTdiDump2 = null;
                    // Backup readback leaves an existing working image and its save state intact.
                    ui.finish('Two device reads matched. Backup is available; the original backup remains separate.');

                    if (webUsbDumpProgress) webUsbDumpProgress.style.width = '100%';
                    if (webUsbDumpVerified) {
                        webUsbDumpVerified.textContent = 'VERIFIED';
                        webUsbDumpVerified.classList.remove('text-zinc-400', 'text-error');
                        webUsbDumpVerified.classList.add('text-secondary');
                    }
                    if (webUsbDumpStatus) {
                        webUsbDumpStatus.textContent = window.DEV_MODE ? 'BACKUP_VERIFIED' : 'Backup verified';
                        webUsbDumpStatus.classList.remove('text-zinc-500', 'text-error');
                        webUsbDumpStatus.classList.add('text-secondary');
                    }
                } else {
                    // Retain both mismatching buffers for diagnosis; nothing is declared verified.
                    window.AppState.hardwareController?.forgetBaseline?.();
                    window.AppState.flipTdiDump2 = dump2;
                    window.AppState.flipTdiDump1Mismatch = dump1;
                    ui.finish('The two reads did not match. Any earlier original backup is unchanged.', 'error');
                    dump1 = null;
                    dump2 = null;

                    if (webUsbDumpVerified) {
                        webUsbDumpVerified.textContent = 'FAILED';
                        webUsbDumpVerified.classList.remove('text-zinc-400', 'text-secondary');
                        webUsbDumpVerified.classList.add('text-error');
                    }
                    if (webUsbDumpStatus) {
                        webUsbDumpStatus.textContent = window.DEV_MODE
                            ? 'DUMP_MISMATCH: this run is not verified; both reads retained. Any earlier verified backup is unchanged.'
                            : 'Backup verification failed. The two reads did not match.';
                        webUsbDumpStatus.classList.remove('text-zinc-500', 'text-secondary');
                        webUsbDumpStatus.classList.add('text-error');
                    }
                }
                });
            } catch (error) {
                window.AppState.hardwareController?.forgetBaseline?.();
                ui.finish(window.AppState.flipTdiDumpAbort ? 'Backup stopped. No new backup was accepted.' :
                    'Backup failed. Any earlier original backup is unchanged.',
                    window.AppState.flipTdiDumpAbort || error?.name === 'AbortError' ? 'cancelled' : 'error',
                    String(error?.message || error));
                if (dump1 instanceof Uint8Array) dump1.fill(0);
                if (dump2 instanceof Uint8Array) dump2.fill(0);
                dump1 = null;
                dump2 = null;

                // Do not destroy an earlier verified backup on a failed new attempt.
                if (webUsbDumpVerified) {
                    webUsbDumpVerified.textContent = 'not verified';
                    webUsbDumpVerified.classList.remove('text-secondary');
                    webUsbDumpVerified.classList.add('text-zinc-400');
                }
                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent =
                        `DUMP_FAILED: ${String(error?.message || error)}`;
                    webUsbDumpStatus.classList.remove('text-zinc-500', 'text-secondary');
                    webUsbDumpStatus.classList.add('text-error');
                }
                if (webUsbDumpProgress) webUsbDumpProgress.style.width = '0%';
            } finally {
                ui.release();
                window.AppState.flipTdiDumpBusy = false;
                window.AppState.flipTdiDumpAbort = false;
                updateModeUI();
                this.context.hardware.refresh?.();
            }
        });

        /**
         * Load a previously verified 16 MiB backup from disk.
         *
         * The file is accepted as the user's trusted baseline and SHA-256 is recalculated
         * locally. No flash bytes are modified here. Before any destructive write, the normal
         * buffered-write preflight still compares every dirty 4 KiB sector against the physical
         * flash, so a stale or wrong baseline aborts before erase/program begins.
         *
         * @param {File} file
         */
        const loadVerifiedBackupFile = async (file) => {
            const sourceImage = window.interface;
            const source = window.AppState.sourceInterface;
            const revision = window.AppState.interfaceRevision;
            window.AppState.flipTdiLastOperationStatus = null;
            window.AppState.flipTdiLastOperationFriendlyStatus = null;
            if (!file) return;

            const FLASH_SIZE = 0x1000000;
            if (file.size !== FLASH_SIZE) {
                throw new Error(
                    `BACKUP_SIZE_INVALID: expected 16777216 bytes (16 MiB), got ${file.size}.`
                );
            }

            if (webUsbDumpStatus) {
                webUsbDumpStatus.textContent = window.DEV_MODE ? 'LOADING_BACKUP' : 'Loading backup...';
                webUsbDumpStatus.classList.remove('text-error', 'text-secondary');
                webUsbDumpStatus.classList.add('text-zinc-500');
            }

            const bytes = new Uint8Array(await file.arrayBuffer());
            const hash = await sha256Hex(bytes);
            if (sourceImage !== window.interface || source !== window.AppState.sourceInterface ||
                revision !== window.AppState.interfaceRevision) {
                throw new Error('Source image changed while loading the backup; nothing was replaced.');
            }

            const info = {
                sha256: hash,
                size: FLASH_SIZE,
                jedec: window.AppState.flipTdiDetectedId || null,
                filename: file.name || 'W25Q128FV_verified.bin',
                verifiedAt: null,
                loadedAt: new Date().toISOString(),
                source: 'loaded-verified-backup'
            };

            // This is the immutable rollback baseline used by buffered-write.
            window.AppState.flipTdiOriginalBackup = bytes;
            window.AppState.flipTdiOriginalBackupInfo = { ...info };

            // Keep the normal "verified dump" state coherent with a freshly created backup.
            window.AppState.flipTdiVerifiedDump = bytes;
            window.AppState.flipTdiVerifiedDumpInfo = { ...info };
            window.AppState.flipTdiDumpHash1 = hash;
            window.AppState.flipTdiDumpHash2 = hash;

            // A separately selected recovery copy never replaces the working image or UUID.
            if (webUsbDumpVerified) {
                webUsbDumpVerified.textContent = 'VERIFIED';
                webUsbDumpVerified.classList.remove('text-zinc-400', 'text-error');
                webUsbDumpVerified.classList.add('text-secondary');
            }
            if (webUsbDumpHash1) {
                webUsbDumpHash1.textContent = `${hash.slice(0, 8)}…${hash.slice(-8)}`;
                webUsbDumpHash1.title = hash;
            }
            if (webUsbDumpHash2) webUsbDumpHash2.textContent = hash;
            if (webUsbDumpStatus) {
                webUsbDumpStatus.textContent = window.DEV_MODE ? 'BACKUP_LOADED' : 'Backup loaded';
                webUsbDumpStatus.classList.remove('text-zinc-500', 'text-error');
                webUsbDumpStatus.classList.add('text-secondary');
            }
            if (webUsbDumpProgress) webUsbDumpProgress.style.width = '0%';

            updateBufferedStatus();
            updateModeUI();
            this.tileManager?.broadcastUpdate(this);
        };

        webUsbLoadVerified?.addEventListener('click', event => {
            if (!ui.allow('load')) return;
            event.preventDefault();
            event.stopPropagation();

            if (window.AppState.flipTdiDumpBusy ||
                window.AppState.flipTdiReadBusy ||
                window.AppState.flipTdiWriteBusy) {
                return;
            }

            if (webUsbLoadVerifiedInput) {
                webUsbLoadVerifiedInput.value = '';
                webUsbLoadVerifiedInput.click();
            }
        });

        webUsbLoadVerifiedInput?.addEventListener('change', async () => {
            const file = webUsbLoadVerifiedInput.files?.[0] || null;
            if (!file || !ui.allow('load')) return;
            ui.start('load', 'Load original backup');

            try {
                await loadVerifiedBackupFile(file);
                ui.finish('Backup loaded from file. SHA-256 calculated locally; the current device was not compared.');
            } catch (error) {
                ui.finish(file.size !== 0x1000000 ? 'Invalid backup size. Select a complete 16 MiB BIN.' : 'Backup could not be loaded.', 'error', String(error?.message || error));
                if (webUsbDumpVerified) {
                    webUsbDumpVerified.textContent = 'LOAD FAILED';
                    webUsbDumpVerified.classList.remove('text-secondary', 'text-zinc-400');
                    webUsbDumpVerified.classList.add('text-error');
                }
                if (webUsbDumpStatus) {
                    webUsbDumpStatus.textContent =
                        `BACKUP_LOAD_FAILED: ${String(error?.message || error)}`;
                    webUsbDumpStatus.classList.remove('text-secondary', 'text-zinc-500');
                    webUsbDumpStatus.classList.add('text-error');
                }
            } finally {
                ui.release();
                webUsbLoadVerifiedInput.value = "";
                updateBufferedStatus();
                updateModeUI();
            }
        });

        webUsbDownloadVerified?.addEventListener('click', event => {
            if (!ui.allow('download')) return;
            event.preventDefault();
            event.stopPropagation();

            const bytes = window.AppState.flipTdiOriginalBackup;
            if (!(bytes instanceof Uint8Array) || bytes.length !== 0x1000000) return;

            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = window.AppState.flipTdiOriginalBackupInfo?.filename || 'W25Q128FV_original_verified.bin';
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });

        verifyCurrentBtn?.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();

            if (!ui.allow('verify')) return;
            const image = window.interface;
            const revision = window.AppState.interfaceRevision;
            const source = window.AppState.sourceInterface;
            const FLASH_SIZE = 0x1000000;

            if (!CoreFlasherDumpUi.complete(image) ||
                !image._isRangeCovered(0, image.size, image.readBuffer) ||
                typeof window.AppState.flipTdiWithReadSession !== 'function' ||
                !window.AppState.flipTdiReady) {
                if (verifyCurrentStatus) {
                    verifyCurrentStatus.textContent = 'Complete image required';
                }
                return;
            }

            if (window.AppState.flipTdiBusy ||
                window.AppState.flipTdiReadBusy ||
                window.AppState.flipTdiDumpBusy ||
                window.AppState.flipTdiWriteBusy) {
                return;
            }

            const expected = image._materializeRange(0, FLASH_SIZE);
            ui.start('verify', 'Verify physical flash');
            let actual = null;
            let readContext = null;
            window.AppState.flipTdiReadBusy = true;
            if (verifyCurrentProgress) verifyCurrentProgress.style.width = '0%';
            if (verifyCurrentStatus) verifyCurrentStatus.textContent = 'Reading flash...';
            updateModeUI();

            try {
                actual = await window.AppState.flipTdiWithReadSession(
                    async (readFn, assertSession, context) => {
                        readContext = context;
                        const bytes = await readFn(0, FLASH_SIZE, (done, total) => {
                            const percent = total > 0 ? (done / total) * 100 : 0;
                            ui.progress(`Verifying ${Math.floor(percent)}%`, percent);
                            if (verifyCurrentProgress) {
                                verifyCurrentProgress.style.width =
                                    `${Math.max(0, Math.min(100, percent))}%`;
                            }
                            if (verifyCurrentStatus) {
                                verifyCurrentStatus.textContent =
                                    `Verifying ${Math.floor(percent)}%`;
                            }
                        });
                        assertSession();
                        return bytes;
                    }
                );

                if (!(actual instanceof Uint8Array) || actual.length !== FLASH_SIZE) {
                    throw new Error('VERIFY_FLASH_INCOMPLETE_READ');
                }

                if (image !== window.interface || revision !== window.AppState.interfaceRevision ||
                    source !== window.AppState.sourceInterface) {
                    throw new Error('The working image changed during comparison; compare again.');
                }
                let differingBytes = 0;
                let firstMismatch = -1;
                const differingSectors = new Set();
                for (let offset = 0; offset < FLASH_SIZE; offset++) {
                    if (actual[offset] !== expected[offset]) {
                        differingBytes++;
                        if (firstMismatch < 0) firstMismatch = offset;
                        differingSectors.add(offset >>> 12);
                    }
                }

                assertWorkingImage(image, expected);
                const baselineMatches = differingBytes !== 0 &&
                    await readContext.controller.rememberBaseline(image, actual, readContext);
                assertWorkingImage(image, expected);
                if (differingBytes === 0) {
                    await adoptVerifiedReadback(image, actual, readContext, expected, await sha256Hex(actual));
                    window.AppState.flipTdiPhysicalStateUnknown = false;
                    ui.rememberVerification('Flash matches current image');
                    ui.finish('Flash matches current image. All 16 MiB compared; matching buffered changes are already on the device.');
                    if (verifyCurrentStatus) {
                        verifyCurrentStatus.textContent = 'Flash matches current image';
                        verifyCurrentStatus.title = 'VERIFY_MATCH';
                    }
                }
                else if (baselineMatches) {
                    window.AppState.flipTdiPhysicalStateUnknown = false;
                    ui.rememberVerification('Device baseline verified; buffered changes remain');
                    ui.finish('Device baseline verified. Buffered changes have not been written.');
                    if (verifyCurrentStatus) {
                        verifyCurrentStatus.textContent = 'Baseline verified · changes pending';
                        verifyCurrentStatus.title = 'BASELINE_MATCH_PENDING_CHANGES';
                    }
                }
                else {
                    const production =
                        `Flash differs · ${differingSectors.size} sector${differingSectors.size === 1 ? '' : 's'}`;
                    const developer =
                        `VERIFY_DIFFERENT: ${differingBytes} bytes / ${differingSectors.size} sectors; first=0x${firstMismatch.toString(16).padStart(6, '0').toUpperCase()}`;
                    ui.rememberVerification(production);
                    ui.finish(production + '. Nothing was written.', 'warning', developer);
                    if (verifyCurrentStatus) {
                        verifyCurrentStatus.textContent = window.DEV_MODE ? developer : production;
                        verifyCurrentStatus.title = developer;
                    }
                }

                if (verifyCurrentProgress) verifyCurrentProgress.style.width = '100%';
            }
            catch (error) {
                window.AppState.hardwareController?.forgetBaseline?.();
                const raw = String(error?.message || error);
                ui.finish('Verification failed. No successful comparison is recorded.', 'error', raw);
                if (verifyCurrentStatus) {
                    verifyCurrentStatus.textContent = window.DEV_MODE
                        ? `VERIFY_FAILED: ${raw}`
                        : 'Verification failed';
                    verifyCurrentStatus.title = raw;
                }
            }
            finally {
                if (actual instanceof Uint8Array) actual.fill(0);
                window.AppState.flipTdiReadBusy = false;
                ui.release();
                updateModeUI();
                this.context.hardware.refresh?.();
            }
        });

        fullImageFlashBtn?.addEventListener('click', event => {
            if (!ui.allow('full')) return;
            event.preventDefault();
            event.stopPropagation();

            if (!window.AppState.flipTdiHostWriteAllowed) {
                if (fullImageStatus) fullImageStatus.textContent = window.DEV_MODE ? 'FLASH_WRITE_NOT_AVAILABLE' : 'Flash writing is not available';
                return;
            }
            if (window.AppState.interfaceMode !== 'rw-buffered') {
                if (fullImageStatus) fullImageStatus.textContent = window.DEV_MODE ? 'READ_WRITE_BUFFERED_REQUIRED' : 'Enable Read / Write first';
                return;
            }
            if (collectDirtySectors(window.interface).length > 0) {
                if (fullImageStatus) fullImageStatus.textContent = window.DEV_MODE ? 'DISCARD_OR_COMMIT_BUFFERED_CHANGES_FIRST' : 'Write or discard pending changes first';
                return;
            }

            if (fullImageInput) {
                fullImageInput.value = '';
                fullImageInput.click();
            }
        });

        /** Share full programming and whole-chip readback between file and SparseImage inputs. */
        const flashFullImageSource = async (selectedFile, fromWorkingImage = false) => {
            const action = fromWorkingImage ? 'fullCurrent' : 'full';
            if ((!fromWorkingImage && !selectedFile) || !ui.allow(action)) return;
            ui.start(action, fromWorkingImage ? 'Write working fulldump' : 'Flash full image');
            const startImage = window.interface;
            const startRevision = window.AppState.interfaceRevision;
            const startBytes = CoreFlasherDumpUi.complete(startImage) ? startImage.subarray(0, startImage.size).slice() : null;
            let writeCompleted = false;

            const FLASH_SIZE = 0x1000000;
            let sourceBytes = null;
            const file = fromWorkingImage ? {
                name: window.AppState.sourceFileName || 'core-flasher-working-image.bin',
                size: startImage.size,
                arrayBuffer: async () => startImage.subarray(0,FLASH_SIZE).slice().buffer
            } : selectedFile;

            try {
                if (file.size !== FLASH_SIZE) {
                    throw new Error(
                        `FULL_IMAGE_SIZE_INVALID: expected exactly 16777216 bytes (16 MiB), got ${file.size}.`
                    );
                }

                if (!window.AppState.flipTdiHostWriteAllowed) {
                    throw new Error('FLASH_WRITE_NOT_AVAILABLE');
                }
                if (window.AppState.interfaceMode !== 'rw-buffered') {
                    throw new Error('READ_WRITE_BUFFERED_REQUIRED');
                }
                if (!fromWorkingImage && collectDirtySectors(window.interface).length > 0) {
                    throw new Error('DISCARD_OR_COMMIT_BUFFERED_CHANGES_FIRST');
                }
                if (typeof window.AppState.flipTdiFlashFullImage !== 'function') {
                    throw new Error('FULL_IMAGE_WRITER_UNAVAILABLE');
                }

                sourceBytes = new Uint8Array(await file.arrayBuffer());
                const sourceHash = await sha256Hex(sourceBytes);
                if (startImage !== window.interface || startRevision !== window.AppState.interfaceRevision ||
                    !ui.allow(action, false, true)) throw new Error('Full flash prerequisites changed. No write started.');
                const backupHash = String(
                    window.AppState.flipTdiOriginalBackupInfo?.sha256 || ''
                );

                const flashPreview = window.DEV_MODE
                    ? `Flash complete 16 MiB image?\n\n` +
                        `File: ${file.name}\n` +
                        `Size: 16 MiB (16777216 bytes)\n` +
                        `Image SHA-256: ${sourceHash}\n` +
                        `Backup SHA-256: ${backupHash}\n\n` +
                        (fromWorkingImage ? '' : `This loads the selected file as the new working image; previous editor drafts will be discarded. `) +
                        `The flash operation stops immediately on the first error. ` +
                        `No automatic backup restore is performed. ` +
                        `After a successful write, the complete 16 MiB flash is read back and verified.`
                    : `Flash complete image?\n\n` +
                        `File: ${file.name}\n` +
                        `Size: 16 MiB\n` +
                        `Backup: ${window.AppState.flipTdiOriginalBackupInfo?.source === 'loaded-verified-backup' ? 'Loaded from file' : window.AppState.flipTdiOriginalBackup ? 'Available' : 'Not selected (optional)'}\n` +
                        `Device: W25Q128FV · 16 MiB\n\n` +
                        `This replaces the complete flash contents${fromWorkingImage ? '' : ' and loads the selected file as the new working image; previous editor drafts will be discarded'}. ` +
                        `After writing, the full flash will be read back and verified.`;
                const confirmed = window.confirm(flashPreview);
                if (!confirmed) { ui.finish('Full flash cancelled. Nothing was written.', 'cancelled'); return; }

                window.AppState.flipTdiWriteBusy = true;
                if (fullImageProgress) fullImageProgress.style.width = '0%';
                if (fullImageStatus) fullImageStatus.textContent = 'PRECHECK';
                updateModeUI();

                const setProgress = info => {
                    const total = Math.max(1, Number(info?.total || 4096));
                    const index = Math.max(0, Number(info?.index || 0));
                    const written = Math.max(0, Number(info?.written || 0));
                    const skipped = Math.max(0, Number(info?.skipped || 0));
                    let percent = 0;
                    let label = String(info?.phase || 'WORKING').toUpperCase();

                    if (info?.phase === 'scan' || info?.phase === 'write' ||
                        info?.phase === 'sector-verified') {
                        percent = (index / total) * 80;
                        if (window.DEV_MODE) {
                            if (info.phase === 'write') {
                                label = `FLASHING ${index}/${total} · written ${written} · skipped ${skipped}`;
                            } else if (info.phase === 'sector-verified') {
                                label = `SECTOR VERIFIED ${index}/${total} · written ${written} · skipped ${skipped}`;
                            } else {
                                label = `SCANNING ${index}/${total} · written ${written} · skipped ${skipped}`;
                            }
                        }
                        else {
                            label = `Programming ${Math.floor((index / total) * 100)}%`;
                        }
                    }
                    else if (info?.phase === 'full-verify-read') {
                        const done = Number(info.done || 0);
                        const bytesTotal = Math.max(1, Number(info.bytesTotal || FLASH_SIZE));
                        percent = 80 + (done / bytesTotal) * 20;
                        label = window.DEV_MODE
                            ? `FULL VERIFY ${Math.floor((done / bytesTotal) * 100)}%`
                            : `Verifying ${Math.floor((done / bytesTotal) * 100)}%`;
                    }
                    else if (info?.phase === 'complete') {
                        percent = 100;
                        label = window.DEV_MODE
                            ? `FULL IMAGE WRITE VERIFIED · written ${written} · skipped ${skipped}`
                            : 'Flash completed and verified';
                    }

                    if (fullImageProgress) {
                        fullImageProgress.style.width =
                            `${Math.max(0, Math.min(100, percent))}%`;
                    }
                    ui.progress(info?.phase === 'scan' && !window.DEV_MODE
                        ? `Checking existing sectors ${Math.floor(index / total * 100)}%` : label, percent);
                    if (fullImageStatus) fullImageStatus.textContent = label;
                };

                this.context.operations.fullFlashStarted();
                if (startImage !== window.interface || startRevision !== window.AppState.interfaceRevision ||
                    !ui.allow(action, false, true)) throw new Error('Full flash prerequisites changed. No write started.');
                assertWorkingImage(startImage, startBytes);
                const actual = await window.AppState.flipTdiFlashFullImage(
                    sourceBytes,
                    setProgress
                );
                writeCompleted = true;

                if (!(actual instanceof Uint8Array) || actual.length !== FLASH_SIZE) {
                    throw new Error('FULL_VERIFY_INVALID: writer did not return 16 MiB.');
                }

                const readbackHash = await sha256Hex(actual);
                if (readbackHash !== sourceHash) {
                    throw new Error(
                        `FULL_VERIFY_SHA256_MISMATCH: source=${sourceHash} readback=${readbackHash}`
                    );
                }

                assertWorkingImage(startImage, startBytes);
                const controller = actual.readContext.controller;
                controller.assertReadContext(actual.readContext);
                let image = startImage;
                if (fromWorkingImage) {
                    await adoptVerifiedReadback(image, actual, actual.readContext, startBytes, readbackHash);
                } else {
                    image = SparseImage.fromBuffer(actual.slice());
                    image.completeSnapshot = true;
                    image.sourceType = 'fliptdi-verified';
                    image.verifiedSha256 = readbackHash;
                    image.readOnly = false;
                    const uuid = await this.context.image.readUuid(image);
                    if (!await controller.rememberBaseline(image, actual, actual.readContext)) throw new Error('Full readback could not establish the new image baseline.');
                    assertWorkingImage(startImage, startBytes);
                    controller.assertReadContext(actual.readContext);
                    window.AppState.sourceFileName = file.name;
                    this.context.image.publish(image, uuid, ui.imageLease);
                    window.AppState.flipTdiLiveImage = null;
                }

                window.AppState.flipTdiVerifiedDump = actual.slice();
                window.AppState.flipTdiVerifiedDumpInfo = {
                    sha256: readbackHash,
                    size: FLASH_SIZE,
                    jedec: window.AppState.flipTdiDetectedId,
                    filename: file.name,
                    verifiedAt: new Date().toISOString(),
                    source: 'full-image-write-readback'
                };
                window.AppState.flipTdiPhysicalStateUnknown = false;
                window.AppState.sourceFileName = file.name;

                window.AppState.interfaceSavedRevision =
                    Number(window.AppState.interfaceRevision || 0);

                if (fullImageProgress) fullImageProgress.style.width = '100%';
                window.AppState.flipTdiLastOperationStatus =
                    `FULL_IMAGE_WRITE_VERIFIED · ${readbackHash.slice(0, 8)}…${readbackHash.slice(-8)}`;
                window.AppState.flipTdiLastOperationFriendlyStatus =
                    'Flash completed and verified';
                ui.rememberVerification('Flash matches current image');
                this.context.operations.fullFlashVerified(readbackHash);
                ui.finish('Flash completed and verified. The original backup is unchanged.');
                if (fullImageStatus) {
                    fullImageStatus.textContent = window.DEV_MODE
                        ? window.AppState.flipTdiLastOperationStatus
                        : window.AppState.flipTdiLastOperationFriendlyStatus;
                }
            }
            catch (error) {
                const raw = String(error?.message || error);
                if (writeCompleted || error?.outcome === 'unknown' || error?.destructiveStarted) {
                    window.AppState.flipTdiPhysicalStateUnknown = true;
                    window.AppState.hardwareController?.forgetBaseline();
                }
                ui.finish(file.size !== FLASH_SIZE ? 'Invalid image size. Select a complete 16 MiB BIN.' : window.AppState.flipTdiPhysicalStateUnknown
                    ? 'Flash incomplete or unverified. Run Verify Flash or restore a full image.' : 'Full flash failed before writing.',
                    'error', raw);
                window.AppState.flipTdiLastOperationStatus =
                    `WRITE_FAILED: ${raw}`;
                window.AppState.flipTdiLastOperationFriendlyStatus =
                    Number(error?.touchedSectors || 0) > 0
                        ? 'Flash unverified · run Verify Flash or restore a full image'
                        : 'Flash failed';
                if (fullImageStatus) {
                    fullImageStatus.textContent = window.DEV_MODE
                        ? window.AppState.flipTdiLastOperationStatus
                        : window.AppState.flipTdiLastOperationFriendlyStatus;
                    fullImageStatus.title = raw;
                }
                console.error('Full image flash failed:', error);
            }
            finally {
                sourceBytes = null;
                if (fullImageInput) fullImageInput.value = '';
                window.AppState.flipTdiWriteBusy = false;
                ui.release();
                updateBufferedStatus();
                updateModeUI();
                this.context.hardware.refresh?.();
            }
        };
        fullImageInput?.addEventListener('change', () => flashFullImageSource(fullImageInput.files?.[0] || null));
        this.element.querySelector('.js-write-fulldump')?.addEventListener('click', event => {
            event.stopPropagation();
            flashFullImageSource(null,true);
        });

        discardChangesBtn?.addEventListener('click', () => {
            if (!ui.allow('discard')) return;
            const image = window.interface;
            if (!image) return;
            const isWebUsb = ['fliptdi', 'pico', 'esp32c3'].includes(window.AppState.sourceInterface);
            const dirty = collectDirtySectors(image);
            const genericCount = Array.isArray(image.writeBuffer) ? image.writeBuffer.length : 0;
            const count = isWebUsb ? dirty.length : genericCount;
            if (count === 0) return;
            if (!window.confirm(isWebUsb
                ? `Discard ${count} buffered flash sector change${count === 1 ? '' : 's'}?`
                : `Discard ${count} buffered change block${count === 1 ? '' : 's'}?`)) {
                return;
            }
            image.writeBuffer = [];
            image.readOnly = window.AppState.interfaceMode !== 'rw-buffered';
            resetParsersAfterImageChange(image);
            updateBufferedStatus();
            updateModeUI();
        });

        writeNowBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const image = window.interface;
            if (!ui.allow('write')) return;

            if (!window.AppState.flipTdiHostWriteAllowed) {
                bufferedStatus.innerText = 'buffered only · host write blocked';
                return;
            }

            if (!image?.completeSnapshot || window.AppState.interfaceMode !== 'rw-buffered') return;
            const sectors = collectDirtySectors(image);
            if (!sectors.length) return;
            if (typeof window.AppState.flipTdiCommitBufferedWrite !== 'function') {
                throw new Error('Flash writer is not available.');
            }

            const addresses = sectors.map(sector =>
                `0x${sector.address.toString(16).padStart(6, '0').toUpperCase()}`).join(', ');
            const writePreview = window.DEV_MODE
                ? `Write ${sectors.length} changed 4 KiB sector${sectors.length === 1 ? '' : 's'} to the flash?\n\n` +
                    `${addresses}\n\nIf needed, the 16 MiB device baseline is compared once before erasing. ` +
                    `Each changed sector is then programmed and read back.`
                : `Write buffered changes?\n\n` +
                    `Changes: ${sectors.length} sector${sectors.length === 1 ? '' : 's'} · ${sectors.length * 4} KiB\n` +
                    `Backup: ${window.AppState.flipTdiOriginalBackupInfo?.source === 'loaded-verified-backup' ? 'Loaded from file' : window.AppState.flipTdiOriginalBackup ? 'Available' : 'Not selected (optional)'}\n` +
                    `Device: W25Q128FV · 16 MiB\n\n` +
                    `The device baseline is compared once if needed. Changed sectors are read back after writing.`;
            if (!window.confirm(writePreview)) return;

            const expected = buildExpectedImage(image, sectors);
            ui.start('write', 'Write buffered changes');
            let writeCompleted = false;
            window.AppState.flipTdiWriteBusy = true;
            if (writeProgressWrap) writeProgressWrap.classList.remove('hidden');
            if (writeProgress) writeProgress.style.width = '0%';
            if (writeStatus) writeStatus.textContent = 'PRECHECK';
            updateModeUI();

            const setWriteProgress = info => {
                const total = Math.max(1, Number(info?.total || sectors.length));
                const index = Math.max(0, Number(info?.index || 0));
                let percent = Math.min(90, (index / total) * 80);
                let label = String(info?.phase || 'WORKING').toUpperCase();

                if (info?.phase === 'baseline-verify-read') {
                    percent = (Number(info.done || 0) / Math.max(1, Number(info.bytesTotal || 1))) * 20;
                    label = window.DEV_MODE ? 'VERIFY DEVICE BASELINE' : 'Checking device image...';
                } else if (info?.phase === 'precheck') {
                    percent = 20 + (index / total) * 15;
                    label = window.DEV_MODE ? `PRECHECK ${index}/${total}` : 'Preparing...';
                } else if (info?.phase === 'write') {
                    percent = 35 + ((index - 1) / total) * 55;
                    label = window.DEV_MODE
                        ? `WRITE SECTOR ${index}/${total}`
                        : `Writing changes ${index}/${total}`;
                } else if (info?.phase === 'sector-verified') {
                    percent = 35 + (index / total) * 55;
                    label = window.DEV_MODE
                        ? `SECTOR VERIFIED ${index}/${total}`
                        : `Writing changes ${index}/${total}`;
                } else if (info?.phase === 'full-verify-read') {
                    const done = Number(info.done || 0);
                    const bytesTotal = Math.max(1, Number(info.bytesTotal || 1));
                    percent = 70 + (done / bytesTotal) * 30;
                    label = window.DEV_MODE
                        ? `FULL VERIFY ${Math.floor((done / bytesTotal) * 100)}%`
                        : `Verifying ${Math.floor((done / bytesTotal) * 100)}%`;
                } else if (info?.phase === 'rollback') {
                    percent = 0;
                    label = window.DEV_MODE ? `ROLLBACK ${index}/${total}` : 'Recovering...';
                } else if (info?.phase === 'complete') {
                    percent = 100;
                    label = window.DEV_MODE ? 'WRITE VERIFIED' : 'Changes written and verified';
                }

                if (writeProgress) writeProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
                ui.progress(label, percent);
                if (writeStatus) writeStatus.textContent = label;
            };

            try {
                const writeRevision = window.AppState.interfaceRevision;
                if (image !== window.interface || writeRevision !== window.AppState.interfaceRevision ||
                    !ui.allow('write', false, true)) throw new Error('Write prerequisites changed. No write started.');
                const actual = await window.AppState.flipTdiCommitBufferedWrite(
                    sectors, expected, setWriteProgress, image
                );
                writeCompleted = true;
                if (!(actual instanceof Uint8Array) || actual.length !== 0x1000000) {
                    throw new Error('Writer did not return a complete sector-verified working image.');
                }
                assertWorkingImage(image, expected);
                actual.readContext.controller.assertReadContext(actual.readContext);

                image.readBuffer = [{address: 0, data: actual.slice()}];
                image.writeBuffer = [];
                image.readDataCallback = null;
                image.writeDataCallback = null;
                image.flushPrepareCallback = null;
                image.completeSnapshot = true;
                image.sourceType = 'fliptdi-sector-verified';
                image.verifiedSha256 = null;
                image.readOnly = false;

                window.AppState.flipTdiVerifiedDump = null;
                window.AppState.flipTdiVerifiedDumpInfo = null;

                resetParsersAfterImageChange(image);
                window.AppState.interfaceSavedRevision =
                    Number(window.AppState.interfaceRevision || 0);
                if (writeStatus) {
                    writeStatus.textContent = window.DEV_MODE
                        ? 'SECTORS VERIFIED'
                        : 'Changed sectors read back';
                }
                window.AppState.flipTdiLastOperationFriendlyStatus =
                    'Changed sectors read back';
                if (writeProgress) writeProgress.style.width = '100%';
                ui.rememberVerification('Changed sectors read back; device baseline retained');
                ui.finish('Changed sectors written and read back. The original backup is unchanged.');
            } catch (error) {
                const raw = String(error?.message || error);
                if (writeCompleted || error?.outcome === 'unknown' ||
                    (error?.destructiveStarted && error?.outcome !== 'rollback-verified')) {
                    window.AppState.flipTdiPhysicalStateUnknown = true;
                    window.AppState.hardwareController?.forgetBaseline();
                }
                ui.finish(window.AppState.flipTdiPhysicalStateUnknown
                    ? 'Write failed. Run Verify Flash or restore a full image.'
                    : error?.outcome === 'rollback-verified' ? 'Write failed. Original sectors were restored and verified.'
                        : 'Write failed before programming.', 'error', raw);
                if (writeStatus) {
                    writeStatus.textContent = window.DEV_MODE
                        ? raw
                        : (raw.startsWith('RECOVERY_REQUIRED')
                            ? 'Write failed · flash state is not verified'
                            : 'Write failed');
                    writeStatus.title = raw;
                }
                console.error('Buffered flash write failed:', error);
            } finally {
                window.AppState.flipTdiWriteBusy = false;
                ui.release();
                updateBufferedStatus();
                updateModeUI();
                this.context.hardware.refresh?.();
            }
        });
        updateModeUI();
        updateBufferedStatus();
        this._statusTimer = setInterval(() => { updateModeUI(); updateBufferedStatus(); }, 500);
        this.update();
    }

    /**
     * Acknowledge attention state and focus this tile.
     * @returns {void}
     */
    focus() {
        super.focus();
        this._hasUnseenInterfaceChange = false;
        this._lastSeenLoadedImageRevision = Number(window.AppState.interfaceLoadRevision || 0);
        this.updateStyles();
    }

    /**
     * Synchronize this component with the shared application state.
     * @returns {void}
     */
    update() {
        const hasImage = !!window.interface;
        const isWebUsb = ['fliptdi', 'pico', 'esp32c3'].includes(window.AppState.sourceInterface);
        const hasInterfaceContext = hasImage || isWebUsb;
        const currentLoadRevision = Number(window.AppState.interfaceLoadRevision || 0);

        // These helpers originate in init(); call the instance-bound references.
        if (typeof this._updateModeUI === 'function') this._updateModeUI();
        if (typeof this._updateBufferedStatus === 'function') this._updateBufferedStatus();

        if (this.isFocused) {
            this._hasUnseenInterfaceChange = false;
            this._lastSeenLoadedImageRevision = currentLoadRevision;
        }
        else if (hasImage && currentLoadRevision > this._lastSeenLoadedImageRevision) {
            this._hasUnseenInterfaceChange = true;
        }

        if (hasInterfaceContext) {
            if (!this.enabled) {
                this.enable();
                this.wasActivated = false;
            }
        }
        else if (this.enabled) {
            this.disable();
            this._hasUnseenInterfaceChange = false;
            this._lastSeenLoadedImageRevision = currentLoadRevision;
        }

        this.updateStyles();
    }

    /**
     * Enable this tile and preserve its existing update sequence.
     * @returns {void}
     */
    enable() {
        const wasDisabled = !this.enabled;
        super.enable();
        if (wasDisabled) {
            this.wasActivated = true;
            if (this.tileManager) {
                const next = this.context.filesystem.available ? this.context.filesystem : null;
                if (next && !next.isEnabled()) {
                    next.enable();
                }
            }
            this.updateStyles();
        }
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return this.enabled && !this.isFocused && !!window.interface
            && this._hasUnseenInterfaceChange;
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        const currentLoadRevision = Number(window.AppState.interfaceLoadRevision || 0);
        if (!window.interface) {
            return 'no SparseImage loaded';
        }
        if (!this._hasUnseenInterfaceChange) {
            return 'no unseen SparseImage replacements';
        }
        return `unseen SparseImage replacement (load revision ${currentLoadRevision} > seen ${this._lastSeenLoadedImageRevision})`;
    }
}
CoreFlasherApp.cardControllers["tile-interface-options"] = CardController;
})();
