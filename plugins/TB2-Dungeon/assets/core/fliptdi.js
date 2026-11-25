
/**
 * FlipTDI TB2 WebUSB transport v12: direct native-SPI JEDEC gate plus MPSSE-to-hardware-SPI bridge.
 * One exclusive owner covers a complete operation, including every OUT/IN pair.
 * Based on the supplied FlipTDI source, not a complete FT232H implementation.
 * Logical SPI: B0=SCK (pin 5), B1=MOSI (pin 2), B2=MISO (pin 3), B3=CS (pin 4).
 * Destructive flash commands are gated behind a verified WREN/WRDI capability probe,
 * explicit write authorization and Read / Write Buffered mode.
 */
/** Explicit bridge profile; FTDI request frequency differs from hardware SPI frequency.
 * AN_108 section 3.8.2 defines the base/divisor wire format. The hardware mapping
 * below matches the Flipper backend's 64 MHz kernel and prescalers 2 through 256.
 */
class FlipTdiClock {
    static PROFILE = 'flipper-64mhz';
    static DEFAULT_HZ = 2000000;
    static UI_DEFAULT_HZ = 8000000;
    static KERNEL_HZ = 64000000;
    static BASE_HZ = 60000000;
    static STORAGE_KEY = 'core_flasher_spi_clock_hz_v1';
    static OPTIONS = Object.freeze([
        [250000, 119], [500000, 59], [1000000, 29], [2000000, 14],
        [4000000, 6], [8000000, 2], [16000000, 0]
    ].map(([targetHz, divisor]) => Object.freeze({ targetHz, divisor, requiresConfirmation: targetHz >= 16000000 })));

    /** Decode an unsigned divisor and calculate the highest achievable clock <= request.
     * @param {number} baseHz @param {number} divisor @param {number} kernelHz
     * @returns {{requestedHz:number, expectedHz:number, command:number[]}}
     */
    static decode(baseHz, divisor, kernelHz = this.KERNEL_HZ) {
        if (![12000000, 60000000].includes(baseHz) || !Number.isInteger(divisor) ||
            divisor < 0 || divisor > 0xFFFF || !Number.isInteger(kernelHz) || kernelHz <= 0) {
            throw new RangeError('Invalid clock base, divisor or kernel profile.');
        }
        const requestedHz = Math.floor(baseHz / (2 * (divisor + 1)));
        const prescaler = [2, 4, 8, 16, 32, 64, 128, 256]
            .find(value => requestedHz * value >= kernelHz);
        if (!prescaler) throw new RangeError('Clock request is below the bridge minimum.');
        return { requestedHz, expectedHz: kernelHz / prescaler,
            command: [baseHz === 60000000 ? 0x8A : 0x8B, 0x86, divisor & 0xFF, divisor >>> 8] };
    }

    /** Map an offered UI target without rounding it into a different hardware clock.
     * @param {number} targetHz
     */
    static select(targetHz) {
        const option = this.OPTIONS.find(item => item.targetHz === targetHz);
        if (!option) throw new RangeError('Unsupported SPI clock selection.');
        return { ...option, ...this.decode(this.BASE_HZ, option.divisor) };
    }

    /** @param {number} hz @returns {string} */
    static format(hz) {
        return hz >= 1000000 ? `${Number((hz / 1000000).toFixed(3))} MHz` : `${hz / 1000} kHz`;
    }
}

/** Shared normal/Dev controls. Preferences never imply firmware detection or clock readback. */
class FlipTdiClockUi {
    /** @param {HTMLElement} root @param {FlipTdiWebUsb} transport */
    constructor(root, transport) {
        this.root = root;
        this.transport = transport;
        this.profile = root.querySelector('.js-clock-profile');
        this.target = root.querySelector('.js-clock-target');
        this.apply = root.querySelector('.js-clock-apply');
        this.status = root.querySelector('.js-clock-status');
        this.warning = root.querySelector('.js-clock-warning');
        this.error = root.querySelector('.js-clock-error');
        // Interface defaults are choices, not detected firmware or measured clock evidence.
        transport.clockProfile = FlipTdiClock.PROFILE;
        transport.clockTargetHz = FlipTdiClock.UI_DEFAULT_HZ;
        for (const option of FlipTdiClock.OPTIONS) {
            const element = document.createElement('option');
            element.value = String(option.targetHz);
            element.textContent = FlipTdiClock.format(option.targetHz) + (option.requiresConfirmation ? ' — Confirm before use' : '');
            this.target.append(element);
        }
        try {
            const stored = Number(localStorage.getItem(FlipTdiClock.STORAGE_KEY));
            if (FlipTdiClock.OPTIONS.some(option => option.targetHz === stored)) transport.clockTargetHz = stored;
        } catch (error) {
            this.showError(`Could not load clock preference: ${error.message}`);
        }
        this.profile.addEventListener('change', () => this.run(() => transport.setClockProfile(this.profile.value)));
        this.target.addEventListener('change', () => this.run(() => {
            transport.setClockTarget(Number(this.target.value));
            localStorage.setItem(FlipTdiClock.STORAGE_KEY, String(transport.clockTargetHz));
        }));
        this.apply.addEventListener('click', event => {
            event.stopPropagation();
            this.run(() => transport.applyClock());
        });
        this.render();
    }

    /** @param {string} message */
    showError(message) {
        this.error.textContent = message;
        this.error.hidden = !message;
    }

    /** @param {function():unknown} action */
    async run(action) {
        this.showError('');
        try { await action(); }
        catch (error) { this.showError(error.message || String(error)); }
        finally { this.render(); }
    }

    /** Render session evidence separately from the user's pending selection. */
    render() {
        const t = this.transport;
        const compatible = t.clockProfile === FlipTdiClock.PROFILE;
        const locked = t.busy || !t.clockChangeAllowed() || !!t.fault;
        const selection = FlipTdiClock.select(t.clockTargetHz);
        this.profile.value = t.clockProfile;
        this.target.value = String(t.clockTargetHz);
        this.profile.disabled = locked || !!t.device;
        this.target.disabled = locked || !compatible;
        this.apply.disabled = locked || !compatible || !t.device?.opened ||
            !t.mpsse || !t.primed || !t.idleVerified;
        const current = t.clockState;
        this.warning.hidden = !compatible || !(selection.requiresConfirmation || current?.requiresConfirmation);
        this.status.textContent = !compatible ? 'Device default: unknown\nNo browser clock override.' :
            `Selected: ${FlipTdiClock.format(selection.targetHz)}\n` +
            (current
                ? `Requested: ${FlipTdiClock.format(current.requestedHz)}\n` +
                  `SPI clock: ${FlipTdiClock.format(current.expectedHz)} (calculated, not device-reported; effective on next SPI transaction)\n` +
                  (current.targetHz !== selection.targetHz ? 'Selected change not applied.\n' : '')
                : 'Requested: unknown\nSPI clock: unknown (not applied in this session)\n') +
            'Readback test: Not run';
    }
}

/** Shared W25Q128 algorithms. Transports provide exclusive ownership and fenced SPI I/O. */
class SpiNorFlash {
    static hex(bytes) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase(); }

    /** Forget device-to-image evidence after a changed source or uncertain read/write. */
    forgetBaseline() {
        this.baselineProof = null;
        this.baselineGeneration = (this.baselineGeneration || 0) + 1;
        this.baselineRequest = (this.baselineRequest || 0) + 1;
    }

    /** Capture the device context which produced a read, before its first asynchronous step. */
    captureReadContext() {
        const context = Object.freeze({controller:this, epoch:this.epoch,
            generation:this.baselineGeneration || 0, connection:this.device || this.port || null,
            chipId:this.flashChipId || null});
        this.assertReadContext(context);
        return context;
    }

    /** Reject late results after disconnect, chip detection, failure or explicit invalidation. */
    assertReadContext(context) {
        if (!context || context.controller !== this || context.epoch !== this.epoch ||
            context.generation !== (this.baselineGeneration || 0) ||
            context.connection !== (this.device || this.port || null) ||
            context.chipId !== (this.flashChipId || null) || !this.ready || this.fault) {
            throw new Error('The device read context changed. Verify the current device again.');
        }
    }

    /** Keep complete byte-array results compatible while carrying their device-read provenance. */
    verifiedResult(bytes, context) {
        this.assertReadContext(context);
        Object.defineProperty(bytes, 'readContext', {value:context});
        return bytes;
    }

    /** Describe device state without inferring destructive writes from UI progress messages. */
    writeFailure(error, outcome, token) {
        error.outcome = outcome;
        error.destructiveStarted = !!token?.destructiveIssued;
        return error;
    }

    /** Keep a device comparison only for this image, connection and baseline bytes. */
    async rememberBaseline(image, physical, context) {
        this.assertReadContext(context);
        const request = this.baselineRequest = (this.baselineRequest || 0) + 1;
        this.baselineProof = null;
        if (!image?.completeSnapshot || !image._isRangeCovered?.(0, FirmwareImage.SIZE, image.readBuffer) ||
            !(physical instanceof Uint8Array) || physical.length !== FirmwareImage.SIZE) return false;
        const baseline = image._materializeReadRange(0, FirmwareImage.SIZE);
        if (!FirmwareImage.equal(baseline, physical)) return false;
        const digest = await FirmwareImage.hash(baseline);
        this.assertReadContext(context);
        if (request !== this.baselineRequest ||
            !FirmwareImage.equal(baseline, image._materializeReadRange(0, FirmwareImage.SIZE))) return false;
        this.baselineProof = {image, context, digest};
        return true;
    }

    /** Hash local baseline bytes; a buffered overlay does not change this proof. */
    async hasBaseline(image, baseline) {
        const proof = this.baselineProof;
        if (!proof || proof.image !== image) return false;
        try { this.assertReadContext(proof.context); }
        catch { this.forgetBaseline(); return false; }
        if (await FirmwareImage.hash(baseline) !== proof.digest || this.baselineProof !== proof) {
            if (this.baselineProof === proof) this.forgetBaseline();
            return false;
        }
        this.assertReadContext(proof.context);
        return true;
    }
    /** Read factory flash identity twice; malformed identity does not grant or revoke flash access. */
    async readFlashChipIdUnlocked(token) {
        this.forgetBaseline();
        this.flashChipId = null;
        this.flashChipIdError = '';
        if (this.readChunkSize < 8) {
            this.flashChipIdError = 'Adapter read limit is too small for flash chip identification.';
            return;
        }
        const command = [0x4B, 0, 0, 0, 0];
        const first = await this.spiRead(token, command, 8, 'FLASH UNIQUE ID');
        const second = await this.spiRead(token, command, 8, 'FLASH UNIQUE ID VERIFY');
        this.checkpoint(token);
        // Floating buses and inconsistent reads must never identify a box.
        if (first.length !== 8 || second.length !== 8 || first.some((byte, index) => byte !== second[index]) ||
            first.every(byte => byte === 0) || first.every(byte => byte === 255)) {
            this.flashChipIdError = 'Flash chip identity could not be verified.';
            return;
        }
        this.flashChipId = SpiNorFlash.hex(first).replace(/ /g, '');
    }
    get readChunkSize() { return 4096; }
    get pageChunkSize() { return 256; }
    /**
     * Non-destructively detect whether the connected host firmware actually forwards
     * flash write opcodes. WREN changes only the volatile WEL latch; WRDI clears it again.
     * No erase/program command is sent here.
     *
     * @param {object} token
     * @returns {Promise<{available:boolean,reason:string}>}
     */
    async probeWriteCapabilityUnlocked(token) {
        this.checkpoint(token);
        this.requireSpi(token);

        const before = await this.statusUnlocked(token);
        if (before & 0x01) {
            return {
                available: false,
                reason: `flash busy before write probe (SR1=0x${before.toString(16).padStart(2, '0').toUpperCase()})`
            };
        }

        await this.spiWrite(token, [0x06], 'WRITE CAPABILITY WREN');
        await new Promise(resolve => setTimeout(resolve, 2));

        const enabled = await this.statusUnlocked(token);
        if ((enabled & 0x02) === 0) {
            // Best effort cleanup even when WREN was blocked/ignored.
            try { await this.spiWrite(token, [0x04], 'WRITE CAPABILITY WRDI cleanup'); }
            catch (_error) {}
            return {
                available: false,
                reason: `WREN did not set WEL (SR1=0x${enabled.toString(16).padStart(2, '0').toUpperCase()})`
            };
        }

        await this.spiWrite(token, [0x04], 'WRITE CAPABILITY WRDI');
        const cleared = await this.statusUnlocked(token);
        if (cleared & 0x02) {
            return {
                available: false,
                reason: `WRDI did not clear WEL (SR1=0x${cleared.toString(16).padStart(2, '0').toUpperCase()})`
            };
        }

        return {
            available: true,
            reason: 'WREN set WEL and WRDI cleared WEL'
        };
    }

    /** @param {object} token */
    assertWriteSession(token) {
        this.checkpoint(token);
        this.requireSpi(token);
        if (token.readContext) this.assertReadContext(token.readContext);
        token.writeAuthorization?.(false);
        if (token.partialImage && typeof FirmwareImage !== 'undefined') FirmwareImage.assertPartialWrite(token.partialImage, true);
        if (token.partialWorkingImage) FirmwareImage.assertPartialWrite(token.partialWorkingImage, true);
        if (!this.ready || !this.writeAllowed()) {
            throw new Error('Device writing requires a ready reader and Read / Write Buffered mode.');
        }
    }

    /** Guard the first destructive command after every awaited precheck and WREN. */
    assertDestructiveWrite(token) {
        this.assertWriteSession(token);
        if (token.partialRequiresProof && (!token.partialVerified || this.baselineProof !== token.baselineProof ||
            token.baselineProof?.image !== token.partialWorkingImage)) {
            throw new Error('Device baseline is not verified for this partial write.');
        }
        if (token.partialRequiresProof) this.assertReadContext(token.baselineProof.context);
        if (typeof token.writeAuthorization !== 'function') throw new Error('Write authorization is required before device writing.');
        token.writeAuthorization(!token.writeBytesChecked);
        token.writeBytesChecked = true;
    }

    /** @param {object} token @returns {Promise<number>} */
    async statusUnlocked(token) {
        return (await this.spiRead(token, [0x05], 1, 'Status-1'))[0];
    }

    /** @param {object} token @param {number} timeoutMs @param {string} label */
    async waitWipClear(token, timeoutMs, label) {
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            this.assertWriteSession(token);
            const status = await this.statusUnlocked(token);
            if ((status & 0x01) === 0) return status;
            if (performance.now() >= deadline) {
                throw new Error(`${label}_TIMEOUT: WIP remained set.`);
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }

    /** Read all three status registers without modifying the flash.
     * @param {object} token
     * @returns {Promise<{sr1:number,sr2:number,sr3:number}>} */
    async protectionStatus(token) {
        this.assertWriteSession(token);
        const sr1 = await this.statusUnlocked(token);
        const sr2 = (await this.spiRead(token, [0x35], 1, 'Status-2'))[0];
        const sr3 = (await this.spiRead(token, [0x15], 1, 'Status-3'))[0];
        return {sr1, sr2, sr3};
    }

    /** @param {{sr1:number,sr2:number,sr3:number}} status */
    protectionSummary(status) {
        const h = value => `0x${value.toString(16).padStart(2, '0').toUpperCase()}`;
        return `SR1=${h(status.sr1)} SR2=${h(status.sr2)} SR3=${h(status.sr3)}`;
    }

    /** Read one Individual Block/Sector Lock bit (3Dh).
     * @param {object} token @param {number} address @returns {Promise<number>} */
    async blockLockStatus(token, address) {
        return (await this.spiRead(token, [
            0x3D, (address >>> 16) & 255, (address >>> 8) & 255, address & 255
        ], 1, `LOCK 0x${address.toString(16).padStart(6, '0')}`))[0];
    }

    /** WREN is safe to retry because it modifies only the volatile WEL latch.
     * The completion fence in spiWrite() guarantees that CS has returned high before SR1 is read.
     * @param {object} token @returns {Promise<number>} */
    async writeEnable(token) {
        if (!token.identityChecked && token.writeAuthorization?.beforeFirstWrite) {
            await token.writeAuthorization.beforeFirstWrite();
            token.identityChecked = true;
            this.assertWriteSession(token);
        }
        this.assertWriteSession(token);

        let lastStatus = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            await this.spiWrite(token, [0x06], `WREN ${attempt}/3`);

            // WEL is specified to latch after CS rises.  The fence above already guarantees
            // ordering; this small delay also gives marginal hardware a conservative interval.
            await new Promise(resolve => setTimeout(resolve, 2));

            lastStatus = await this.statusUnlocked(token);
            if (lastStatus & 0x01) {
                throw new Error(
                    `WREN_FAILED: flash became busy unexpectedly (SR1=0x${lastStatus.toString(16).padStart(2, '0').toUpperCase()}).`
                );
            }
            if (lastStatus & 0x02) return lastStatus;

            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 10));
        }

        const protection = await this.protectionStatus(token);
        throw new Error(
            `WREN_FAILED: WEL did not set after 3 fenced attempts; ${this.protectionSummary(protection)}.`
        );
    }

    /** Non-destructive write-capability preflight: WREN -> verify WEL -> WRDI -> verify WEL cleared.
     * @param {object} token */
    async verifyWriteLatch(token) {
        await this.writeEnable(token);
        await this.spiWrite(token, [0x04], 'WRDI');
        const status = await this.statusUnlocked(token);
        if (status & 0x02) {
            throw new Error(
                `WRDI_FAILED: WEL remained set (SR1=0x${status.toString(16).padStart(2, '0').toUpperCase()}).`
            );
        }
    }

    /** @param {object} token @param {number} address @param {function():void|null} [onEraseIssued=null] */
    async eraseSector(token, address, onEraseIssued = null) {
        this.assertWriteSession(token);
        if (!Number.isInteger(address) || address < 0 || address > 0xFFF000 ||
            (address & 0xFFF) !== 0) {
            throw new Error('Sector erase requires a 4-KiB-aligned 24-bit address.');
        }
        await this.writeEnable(token);
        this.assertDestructiveWrite(token);
        // Track every sector whose erase may reach the adapter, including a failed completion fence.
        if (typeof onEraseIssued === 'function') onEraseIssued();
        await this.spiWrite(token, [
            0x20, (address >>> 16) & 255, (address >>> 8) & 255, address & 255
        ], `ERASE 0x${address.toString(16).padStart(6, '0')}`);

        await this.waitWipClear(token, 5000, 'SECTOR_ERASE');
    }

    /** @param {object} token @param {number} address @param {Uint8Array} data */
    async programPage(token, address, data) {
        this.assertWriteSession(token);
        if (!(data instanceof Uint8Array) || data.length < 1 || data.length > this.pageChunkSize) {
            throw new Error('Page Program requires 1..256 bytes.');
        }
        if (!Number.isInteger(address) || address < 0 || address + data.length > 0x1000000) throw new Error('Invalid flash program address.');
        if ((address & 0xFF) + data.length > 256) {
            throw new Error('Page Program may not cross a 256-byte page boundary.');
        }
        await this.writeEnable(token);
        this.assertDestructiveWrite(token);
        await this.spiWrite(token, [
            0x02, (address >>> 16) & 255, (address >>> 8) & 255, address & 255, ...data
        ], `PROGRAM 0x${address.toString(16).padStart(6, '0')}`);
        await this.waitWipClear(token, 1500, 'PAGE_PROGRAM');
    }

    /** Program and read-back one complete 4-KiB sector.
     * @param {object} token @param {number} address @param {Uint8Array} desired */
    async writeSectorUnlocked(token, address, desired, onDestructiveStart = null) {
        this.assertWriteSession(token);
        if (!(desired instanceof Uint8Array) || desired.length !== 0x1000) {
            throw new Error('Sector writer requires exactly 4096 bytes.');
        }
        await this.eraseSector(token, address, onDestructiveStart);
        for (let offset = 0; offset < 0x1000;) {
            this.assertWriteSession(token);
            const page = desired.subarray(offset, offset + Math.min(this.pageChunkSize, 256 - (offset & 255)));
            let allFF = true;
            for (const byte of page) {
                if (byte !== 0xFF) { allFF = false; break; }
            }
            if (!allFF) await this.programPage(token, address + offset, page);
            offset += page.length;
        }
        const verify = await this.readRangeUnlocked(token, address, 0x1000);
        for (let i = 0; i < 0x1000; i++) {
            if (verify[i] !== desired[i]) {
                throw new Error(`SECTOR_VERIFY_FAILED at 0x${(address + i).toString(16).padStart(6, '0')}`);
            }
        }
        return verify;
    }

    /** Commit an immutable sector plan against a verified device baseline.
     * Every partial caller must provide the complete working image; no legacy path bypasses proof.
     * @param {{address:number,before:Uint8Array,after:Uint8Array}[]} sectors
     * @param {Uint8Array} expectedImage
     * @param {function(object):void|null} [progress=null]
     * @param {SparseImage} workingImage
     * @returns {Promise<Uint8Array>} */
    async commitBufferedWrite(sectors, expectedImage, progress = null, workingImage = null) {
        let tokenForError = null;
        try {
            // Copy caller-owned bytes before authorization, progress hooks or the first await.
            if (!workingImage?.completeSnapshot ||
                !workingImage._isRangeCovered?.(0, FirmwareImage.SIZE, workingImage.readBuffer)) {
                throw new Error('Device baseline proof requires the current complete working image.');
            }
            FirmwareImage.assertPartialWrite(workingImage, true);
            if (!(expectedImage instanceof Uint8Array) || expectedImage.length !== FirmwareImage.SIZE) {
                throw new Error('Expected image must be a complete 16 MiB snapshot.');
            }
            if (!Array.isArray(sectors) || !sectors.length) throw new Error('No dirty sectors to write.');
            const expected = expectedImage.slice();
            const baseline = workingImage._materializeReadRange(0, FirmwareImage.SIZE);
            const ordered = sectors.map(sector => {
                if (!(sector?.before instanceof Uint8Array) || !(sector.after instanceof Uint8Array)) {
                    throw new Error('Invalid dirty-sector plan.');
                }
                return {address:sector.address, before:sector.before.slice(), after:sector.after.slice()};
            }).sort((a, b) => a.address - b.address);
            const planned = baseline.slice();
            let previousEnd = 0;
            for (const sector of ordered) {
                if (!Number.isInteger(sector.address) || sector.address < previousEnd ||
                    (sector.address & 0xFFF) !== 0 || sector.address + 0x1000 > FirmwareImage.SIZE ||
                    sector.before.length !== 0x1000 || sector.after.length !== 0x1000 ||
                    !FirmwareImage.equal(baseline.subarray(sector.address, sector.address + 0x1000), sector.before)) {
                    throw new Error('Dirty-sector plan differs from the working-image baseline.');
                }
                planned.set(sector.after, sector.address);
                previousEnd = sector.address + 0x1000;
            }
            if (!FirmwareImage.equal(planned, expected)) throw new Error('Expected image differs from the dirty-sector plan.');
            FirmwareImage.assertPartialWrite(expected, true);

            return await this.exclusive('flash-write', async token => {
                tokenForError = token;
                const context = this.captureReadContext();
                const touched = [];
                token.partialImage = expected;
                token.partialWorkingImage = workingImage;
                token.partialRequiresProof = true;
                try {
                    token.writeAuthorization = await this.authorizeWrite('flash-write', expected.slice());
                    this.assertReadContext(context);
                    this.assertWriteSession(token);
                    const id = await this.spiRead(token, [0x9F], 3, 'WRITE PRECHECK JEDEC');
                    if (SpiNorFlash.hex(id) !== 'EF 40 18') throw new Error(`WRITE_PRECHECK_JEDEC: ${SpiNorFlash.hex(id)}`);
                    const protection = await this.protectionStatus(token);
                    if (protection.sr1 & 0x01) throw new Error('WRITE_PRECHECK_BUSY: WIP is set.');
                    const wps = !!(protection.sr3 & 0x04);
                    if (!wps && ((protection.sr1 & 0x7C) || (protection.sr2 & 0x40))) {
                        throw new Error(`WRITE_PRECHECK_PROTECTED: ${this.protectionSummary(protection)}`);
                    }
                    if (!FirmwareImage.equal(baseline, workingImage._materializeReadRange(0, FirmwareImage.SIZE))) {
                        throw new Error('The working-image baseline changed before writing.');
                    }
                    if (!await this.hasBaseline(workingImage, baseline)) {
                        // A stale proof can invalidate its generation; capture the context of this new read.
                        token.readContext = this.captureReadContext();
                        progress?.({phase:'baseline-verify', index:0, total:ordered.length, address:0});
                        const physical = await this.readRangeUnlocked(token, 0, FirmwareImage.SIZE,
                            (done, total) => progress?.({phase:'baseline-verify-read', done, bytesTotal:total,
                                index:0, total:ordered.length, address:0}));
                        if (!FirmwareImage.equal(physical, baseline) ||
                            !await this.rememberBaseline(workingImage, physical, token.readContext)) {
                            this.forgetBaseline();
                            throw new Error('BASELINE_MISMATCH: device differs from the working image. Compare or load the current device image before writing.');
                        }
                    }
                    token.partialVerified = true;
                    token.baselineProof = this.baselineProof;
                    token.readContext = token.baselineProof.context;
                    if (wps) {
                        for (const sector of ordered) {
                            if ((await this.blockLockStatus(token, sector.address)) & 0x01) {
                                throw new Error(`WRITE_PRECHECK_BLOCK_LOCKED: ${FirmwareImage.offset(sector.address)} is locked; ${this.protectionSummary(protection)}`);
                            }
                        }
                    }
                    await this.verifyWriteLatch(token);
                    for (let index = 0; index < ordered.length; index++) {
                        const sector = ordered[index];
                        const physical = await this.readRangeUnlocked(token, sector.address, 0x1000);
                        if (!FirmwareImage.equal(physical, sector.before)) {
                            this.forgetBaseline();
                            throw new Error(`FLASH_CONFLICT at ${FirmwareImage.offset(sector.address)}: physical flash differs from the verified baseline.`);
                        }
                        progress?.({phase:'precheck', index:index + 1, total:ordered.length, address:sector.address});
                    }
                    const actual = baseline.slice();
                    for (let index = 0; index < ordered.length; index++) {
                        const sector = ordered[index];
                        progress?.({phase:'write', index:index + 1, total:ordered.length, address:sector.address});
                        const readback = await this.writeSectorUnlocked(token, sector.address, sector.after,
                            () => touched.push(sector));
                        if (!(readback instanceof Uint8Array) || !FirmwareImage.equal(readback, sector.after)) {
                            throw new Error('SECTOR_VERIFY_FAILED: sector readback is missing or differs.');
                        }
                        actual.set(readback, sector.address);
                        progress?.({phase:'sector-verified', index:index + 1, total:ordered.length, address:sector.address});
                    }
                    const digest = await FirmwareImage.hash(actual);
                    this.assertWriteSession(token);
                    this.assertReadContext(token.readContext);
                    if (!FirmwareImage.equal(baseline, workingImage._materializeReadRange(0, FirmwareImage.SIZE))) {
                        throw new Error('The working-image baseline changed during writing.');
                    }
                    progress?.({phase:'complete', index:ordered.length, total:ordered.length, address:0});
                    this.assertWriteSession(token);
                    this.assertReadContext(token.readContext);
                    this.baselineProof = {image:workingImage, context:token.readContext, digest};
                    return this.verifiedResult(actual, token.readContext);
                } catch (error) {
                    if (!token.destructiveIssued) throw this.writeFailure(error, 'unchanged', token);
                    let rollbackFailure = null;
                    try {
                        this.assertReadContext(token.readContext);
                        if (!touched.length) throw new Error('The destructive operation could not be attributed to a sector.');
                        for (let index = touched.length - 1; index >= 0; index--) {
                            const sector = touched[index];
                            progress?.({phase:'rollback', index:touched.length - index, total:touched.length, address:sector.address});
                            const readback = await this.writeSectorUnlocked(token, sector.address, sector.before);
                            if (!(readback instanceof Uint8Array) || !FirmwareImage.equal(readback, sector.before)) {
                                throw new Error('Rollback sector readback differs.');
                            }
                        }
                        this.assertReadContext(token.readContext);
                    } catch (failure) { rollbackFailure = failure; }
                    if (rollbackFailure) {
                        this.forgetBaseline();
                        throw this.writeFailure(new Error(`RECOVERY_REQUIRED: write failed (${error.message || error}); ` +
                            `rollback could not be verified (${rollbackFailure.message || rollbackFailure}).`), 'unknown', token);
                    }
                    if (FirmwareImage.equal(baseline, workingImage._materializeReadRange(0, FirmwareImage.SIZE))) {
                        this.baselineProof = token.baselineProof;
                    } else this.forgetBaseline();
                    throw this.writeFailure(new Error(`WRITE_ABORTED_ROLLBACK_VERIFIED: ${error.message || error}`), 'rollback-verified', token);
                }
            });
        } catch (error) {
            if (error.outcome) throw error;
            throw this.writeFailure(error, tokenForError?.destructiveIssued ? 'unknown' : 'unchanged', tokenForError);
        }
    }

    /**
     * Flash one complete 16 MiB image.
     *
     * Existing sectors are read first and identical sectors are skipped. Any error aborts
     * immediately; no automatic backup restore or rollback is attempted. Only after every
     * required sector is written and individually read-back verified is the complete 16 MiB
     * flash read again and compared byte-for-byte with the source image.
     *
     * @param {Uint8Array} imageBytes
     * @param {function(object):void|null} [progress=null]
     * @returns {Promise<Uint8Array>}
     */
    async flashFullImage(imageBytes, progress = null) {
        let tokenForError = null;
        if (!(imageBytes instanceof Uint8Array) || imageBytes.length !== FirmwareImage.SIZE) {
            throw this.writeFailure(new Error(
                'FULL_IMAGE_SIZE_INVALID: source image must be exactly 16777216 bytes (16 MiB).'), 'unchanged', null);
        }
        imageBytes = imageBytes.slice();
        return this.exclusive('full-image-write', async token => {
            tokenForError = token;
            this.forgetBaseline();
            token.readContext = this.captureReadContext();
            token.writeAuthorization = await this.authorizeWrite('full-image-write', imageBytes.slice());
            this.assertWriteSession(token);

            const FLASH_SIZE = 0x1000000;
            const SECTOR_SIZE = 0x1000;
            const SECTOR_COUNT = FLASH_SIZE / SECTOR_SIZE;

            const id = await this.spiRead(token, [0x9F], 3, 'FULL IMAGE PRECHECK JEDEC');
            if (SpiNorFlash.hex(id) !== 'EF 40 18') {
                throw new Error(`FULL_IMAGE_PRECHECK_JEDEC: ${SpiNorFlash.hex(id)}`);
            }

            const protection = await this.protectionStatus(token);
            if (protection.sr1 & 0x01) {
                throw new Error('FULL_IMAGE_PRECHECK_BUSY: WIP is set.');
            }

            const wps = !!(protection.sr3 & 0x04);
            if (!wps && ((protection.sr1 & 0x7C) || (protection.sr2 & 0x40))) {
                throw new Error(
                    `FULL_IMAGE_PRECHECK_PROTECTED: ${this.protectionSummary(protection)}`
                );
            }

            // Final non-destructive proof before any erase/program command.
            await this.verifyWriteLatch(token);

            let written = 0;
            let skipped = 0;
            let touched = 0;

            try {
                for (let index = 0; index < SECTOR_COUNT; index++) {
                    this.assertWriteSession(token);
                    const address = index * SECTOR_SIZE;
                    const desired = imageBytes.subarray(address, address + SECTOR_SIZE);
                    const physical = await this.readRangeUnlocked(
                        token, address, SECTOR_SIZE
                    );

                    let identical = true;
                    for (let offset = 0; offset < SECTOR_SIZE; offset++) {
                        if (physical[offset] !== desired[offset]) {
                            identical = false;
                            break;
                        }
                    }

                    if (identical) {
                        skipped++;
                        progress?.({
                            phase: 'scan',
                            index: index + 1,
                            total: SECTOR_COUNT,
                            address,
                            written,
                            skipped
                        });
                        continue;
                    }

                    if (wps) {
                        const lock = await this.blockLockStatus(token, address);
                        if (lock & 0x01) {
                            throw new Error(
                                `FULL_IMAGE_BLOCK_LOCKED: 0x${address.toString(16).padStart(6, '0').toUpperCase()} is locked; ${this.protectionSummary(protection)}`
                            );
                        }
                    }

                    progress?.({
                        phase: 'write',
                        index: index + 1,
                        total: SECTOR_COUNT,
                        address,
                        written,
                        skipped
                    });

                    let touchedThisSector = false;
                    await this.writeSectorUnlocked(
                        token,
                        address,
                        desired,
                        () => {
                            if (!touchedThisSector) {
                                touchedThisSector = true;
                                touched++;
                            }
                        }
                    );

                    written++;
                    progress?.({
                        phase: 'sector-verified',
                        index: index + 1,
                        total: SECTOR_COUNT,
                        address,
                        written,
                        skipped
                    });
                }

                progress?.({
                    phase: 'full-verify',
                    index: SECTOR_COUNT,
                    total: SECTOR_COUNT,
                    written,
                    skipped
                });

                const actual = await this.readRangeUnlocked(
                    token,
                    0,
                    FLASH_SIZE,
                    (done, total) => progress?.({
                        phase: 'full-verify-read',
                        done,
                        bytesTotal: total,
                        index: SECTOR_COUNT,
                        total: SECTOR_COUNT,
                        written,
                        skipped
                    })
                );

                for (let offset = 0; offset < FLASH_SIZE; offset++) {
                    if (actual[offset] !== imageBytes[offset]) {
                        throw new Error(
                            `FULL_VERIFY_FAILED at 0x${offset.toString(16).padStart(6, '0').toUpperCase()}`
                        );
                    }
                }

                progress?.({
                    phase: 'complete',
                    index: SECTOR_COUNT,
                    total: SECTOR_COUNT,
                    written,
                    skipped
                });

                this.assertWriteSession(token);
                return this.verifiedResult(actual, token.readContext);
            }
            catch (error) {
                error.writtenSectors = written;
                error.skippedSectors = skipped;
                error.touchedSectors = Math.max(touched, token.destructiveIssued ? 1 : 0);
                throw this.writeFailure(error, token.destructiveIssued ? 'unknown' : 'unchanged', token);
            }
        }).catch(error => {
            if (error.outcome) throw error;
            throw this.writeFailure(error, tokenForError?.destructiveIssued ? 'unknown' : 'unchanged', tokenForError);
        });
    }

    /** @param {object} token */
    assertReadSession(token) {
        this.checkpoint(token);
        this.requireSpi(token);
        if (token.readContext) this.assertReadContext(token.readContext);
        if (!this.ready || !this.readAllowed()) throw new Error('Flash read requires a ready reader and a permitted mode.');
    }

    /** @param {object} token @param {number} address @param {number} length
     * @param {function(number,number):void|null} [progress=null] @returns {Promise<Uint8Array>} */
    async readRangeUnlocked(token, address, length, progress = null) {
        this.assertReadSession(token);
        if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length < 1 ||
            address + length > 0x1000000) throw new Error('Invalid 16 MiB flash read range.');
        const output = new Uint8Array(length);
        try {
            for (let offset = 0; offset < length;) {
                this.assertReadSession(token);
                const count = Math.min(this.readChunkSize, length - offset);
                const at = address + offset;
                const data = await this.spiRead(token,
                    [0x03, (at >>> 16) & 255, (at >>> 8) & 255, at & 255], count, 'Flash read');
                output.set(data, offset);
                offset += data.length;
                this.assertReadSession(token);
                if (progress) progress(offset, length);
                if (offset < length && offset % 4096 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
            this.log(`FLASH READ OK: 0x${address.toString(16).padStart(6, '0')} + ${length} bytes.`);
            return output;
        } catch (error) {
            output.fill(0);
            throw error;
        }
    }

    /** Preserve the application's public range-reader signature.
     * @param {number} address @param {number} length
     * @param {function(number,number):void|null} [progress=null] @returns {Promise<Uint8Array>} */
    readRange(address, length, progress = null) {
        return this.exclusive('flash-read', token => this.readRangeUnlocked(token, address, length, progress));
    }

    /** Reserve the same USB session for BOTH full dumps AND their hashes.
     * @template T @param {function(Function,Function,object):Promise<T>} action @returns {Promise<T>} */
    withReadSession(action) {
        return this.exclusive('full-dump', async token => {
            this.assertReadSession(token);
            token.readContext = this.captureReadContext();
            const result = await action(
                (address, length, progress = null) => this.readRangeUnlocked(token, address, length, progress),
                () => this.assertReadSession(token), token.readContext);
            this.assertReadSession(token);
            return result;
        });
    }

}

class FlipTdiWebUsb extends SpiNorFlash {
    /** @param {object} options @param {USB|undefined} options.usb
     * @param {function(string):void} options.log @param {function():void} options.changed
     * @param {function():boolean} options.readAllowed
     * @param {function():boolean} [options.writeAllowed]
     * @param {function(string):Promise<function(boolean):void>} [options.authorizeWrite]
     * @param {function():boolean} [options.clockChangeAllowed]
     * @param {function(object):boolean} [options.confirmHighClock]
     * @param {number} [options.timeoutMs=5000] */
    constructor({usb, log, changed, readAllowed, writeAllowed = () => false,
        authorizeWrite = async () => { throw new Error('Write authorization is required before device writing.'); },
        clockChangeAllowed = () => true, confirmHighClock = () => false, timeoutMs = 5000}) {
        super();
        this.usb = usb;
        this.log = log;
        this.changed = changed;
        this.readAllowed = readAllowed;
        this.writeAllowed = writeAllowed;
        this.authorizeWrite = authorizeWrite;
        this.timeoutMs = timeoutMs;
        this.clockChangeAllowed = clockChangeAllowed;
        this.confirmHighClock = confirmHighClock;
        this.clockProfile = 'legacy';
        this.clockTargetHz = FlipTdiClock.DEFAULT_HZ;
        this.clockState = null;
        this.device = null;
        this.mpsse = false;
        this.primed = false;
        this.idleVerified = false;
        this.lastGpio = null;
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.fault = '';
        this.phase = 'idle';
        this.owner = null;
        this.pending = null;
        this.epoch = 0;
        this.cancelIo = null;
        this.probeSummary = 'not run';
        this.lastProbe = null;
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.usb?.addEventListener('disconnect', event => this.onDisconnect(event.device));
    }

    /** @param {Iterable<number>} bytes @returns {string} */
    static hex(bytes) {
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ').toUpperCase();
    }

    /** @returns {boolean} */
    get busy() { return this.owner !== null || this.pending !== null; }
    /** @returns {boolean} */
    get ready() {
        return !!this.detectedId && this.hwJedecVerified && this.preflightVerified &&
            this.idleVerified && this.primed && !this.fault;
    }

    /** Reject competing operations even when controls are dispatched programmatically. */
    assertClockEditable() {
        if (this.busy || !this.clockChangeAllowed()) throw new Error('Clock controls are locked during an operation.');
        if (this.fault) throw new Error('Reconnect before changing the SPI clock.');
    }

    /** @param {string} profile */
    setClockProfile(profile) {
        this.assertClockEditable();
        if (this.device) throw new Error('Disconnect before changing the bridge profile.');
        if (!['legacy', FlipTdiClock.PROFILE].includes(profile)) throw new Error('Unknown bridge profile.');
        this.clockProfile = profile;
        this.clockState = null;
        this.changed();
    }

    /** Save a selection; only deliberate setup/apply sends a command. @param {number} targetHz */
    setClockTarget(targetHz) {
        this.assertClockEditable();
        if (this.clockProfile !== FlipTdiClock.PROFILE) throw new Error('Select a compatible bridge profile first.');
        FlipTdiClock.select(targetHz);
        this.clockTargetHz = targetHz;
        this.changed();
    }

    /** Require fresh high-speed approval for each initialization or explicit apply. */
    prepareClockChange() {
        if (this.clockProfile !== FlipTdiClock.PROFILE) return null;
        const selection = FlipTdiClock.select(this.clockTargetHz);
        if (selection.requiresConfirmation && !this.confirmHighClock(selection)) {
            throw new DOMException('High SPI clock was not applied.', 'AbortError');
        }
        return selection;
    }

    /** Apply through the existing owner; GPIO fence proves completion, never clock readback.
     * @param {object} token @param {object} selection
     */
    async applyClockUnlocked(token, selection) {
        this.checkpoint(token);
        this.requireSpi(token);
        if (this.clockProfile !== FlipTdiClock.PROFILE) throw new Error('Clock-compatible profile required.');
        this.clockState = null;
        this.changed();
        try {
            // Establish a completed CS-high boundary before sending either clock command.
            await this.out(token, [0x80, 0x08, 0x0B, 0x81, 0x87], 'Clock idle fence');
            const before = (await this.readExact(token, 1, 'Clock idle fence'))[0];
            if ((before & 0x0B) !== 0x08) throw this.fail('CLOCK_IDLE_FAILED: CS/SCK/MOSI are not idle.');
            this.checkpoint(token);
            await this.out(token, selection.command, 'SPI clock request');
            await this.out(token, [0x81, 0x87], 'Clock completion fence');
            const after = (await this.readExact(token, 1, 'Clock completion fence'))[0];
            if ((after & 0x0B) !== 0x08) throw this.fail('CLOCK_FENCE_FAILED: idle state changed.');
            this.checkpoint(token);
            this.clockState = { ...selection };
            this.log(`SPI clock request sent: ${FlipTdiClock.format(selection.requestedHz)}; ` +
                `expected ${FlipTdiClock.format(selection.expectedHz)} on next SPI transaction (calculated, not device-reported).`);
            this.changed();
        } catch (error) {
            this.clockState = null;
            if (token.epoch === this.epoch) this.fail(`CLOCK_CHANGE_FAILED: ${error.message}`);
            throw error;
        }
    }

    /** @returns {Promise<void>} */
    applyClock() {
        this.assertClockEditable();
        const selection = this.prepareClockChange();
        if (!selection) throw new Error('Select a compatible bridge profile first.');
        return this.exclusive('clock-change', token => this.applyClockUnlocked(token, selection));
    }

    /** Reject, rather than queue, competing user actions. Never release another action's lease.
     * @template T @param {string} label @param {function(object):Promise<T>} action
     * @param {boolean} [allowFault=false] @returns {Promise<T>} */
    async exclusive(label, action, allowFault = false) {
        if (this.busy) throw new Error(`USB_BUSY: ${this.owner?.label || 'native transfer pending'}`);
        if (this.fault && !allowFault) throw new Error(`USB_SESSION_FAULT: ${this.fault}`);
        const token = {label, epoch: this.epoch, stop: false};
        this.owner = token;
        this.phase = label;
        this.changed();
        try {
            // Calling action synchronously preserves the original click's user activation.
            return await action(token);
        } finally {
            if (this.owner === token) {
                this.owner = null;
                this.phase = this.fault ? 'fault' : 'idle';
                this.changed();
            }
        }
    }

    /** @param {object} token @returns {void} */
    assertOwner(token) {
        if (this.owner !== token || token.epoch !== this.epoch) {
            throw new Error('USB_SESSION_CHANGED: reconnect before retrying.');
        }
        if (this.fault) throw new Error(`USB_SESSION_FAULT: ${this.fault}`);
    }

    /** @param {object} token @returns {void} */
    checkpoint(token) {
        this.assertOwner(token);
        if (token.stop) throw new DOMException('Operation stopped after the current transaction.', 'AbortError');
    }

    /** Cancellation is cooperative: never abandon a native IN transfer and start a new one. */
    requestStop() {
        if (!this.owner || !['detection', 'wait-chip', 'full-dump', 'gpio-diagnosis',
            'flash-write', 'full-image-write'].includes(this.owner.label)) return;
        this.owner.stop = true;
        this.log('STOP_REQUESTED: completing the current USB transaction; no new transaction follows.');
        this.changed();
    }

    /** @param {string} message @returns {Error} */
    fail(message) {
        this.forgetBaseline();
        this.clockState = null;
        this.fault = message;
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'session fault';
        this.idleVerified = false;
        this.primed = false;
        this.changed();
        return new Error(message);
    }

    /** A watchdog reports failure, but does not pretend to cancel the native WebUSB operation.
     * On timeout the session stays poisoned and the native pending flag stays set until settled
     * or physical disconnect. No automatic close/reset of the previously hanging FlipTDI app.
     * @template T @param {object} token @param {string} label
     * @param {function():Promise<T>} action @param {number} [limit=this.timeoutMs]
     * @returns {Promise<T>} */
    async io(token, label, action, limit = this.timeoutMs) {
        this.assertOwner(token);
        if (this.pending) throw this.fail('USB_INTERNAL_ERROR: overlapping native transfers.');
        const pending = {label, epoch: this.epoch};
        this.pending = pending;
        let timer;
        let rejectDisconnected;
        const interrupted = new Promise((_, reject) => { rejectDisconnected = reject; });
        this.cancelIo = rejectDisconnected;
        const native = Promise.resolve().then(action);
        const settled = native.then(value => {
            if (this.pending === pending) this.pending = null;
            return value;
        }, error => {
            if (this.pending === pending) this.pending = null;
            throw error;
        });
        const watchdog = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(this.fail(`USB_TIMEOUT: ${label}. Native request may still be pending; ` +
                    'USB actions are locked. Disconnect USB physically, restart Core Flasher, then reconnect.'));
            }, Math.max(1, limit));
        });
        try {
            const result = await Promise.race([settled, watchdog, interrupted]);
            this.assertOwner(token);
            return result;
        } catch (error) {
            if (token.epoch === this.epoch && !this.fault) {
                this.fail(`USB_IO_ERROR (${label}): ${error.message || error}`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
            if (this.cancelIo === rejectDisconnected) this.cancelIo = null;
            // A late completion cannot make a poisoned session usable again.
            settled.then(() => { if (this.fault) this.changed(); },
                () => { if (this.fault) this.changed(); });
        }
    }

    /** @param {object} token @returns {USBDevice} */
    openedDevice(token) {
        this.assertOwner(token);
        const device = this.device;
        if (!device?.opened || !device.configuration?.interfaces.find(i => i.interfaceNumber === 0)?.claimed) {
            throw new Error('Open + Claim first.');
        }
        return device;
    }

    /** @param {object} token @param {number} request @param {number} value @param {string} label */
    async controlOut(token, request, value, label) {
        const device = this.openedDevice(token);
        if (request === 0x0B || (request === 0x00 && value === 0)) {
            this.clockState = null;
            this.changed();
        }
        const result = await this.io(token, label, () => device.controlTransferOut({
            requestType: 'vendor', recipient: 'device', request, value, index: 1
        }));
        if (result.status !== 'ok' || result.bytesWritten !== 0) {
            throw this.fail(`${label}: status=${result.status}, bytesWritten=${result.bytesWritten}`);
        }
    }

    /** @param {object} token @param {Uint8Array|number[]} bytes @param {string} label */
    async out(token, bytes, label) {
        const device = this.openedDevice(token);
        const data = Uint8Array.from(bytes);
        const result = await this.io(token, label, () => device.transferOut(2, data));
        if (result.status !== 'ok' || result.bytesWritten !== data.length) {
            throw this.fail(`${label}: ${result.status}, ${result.bytesWritten}/${data.length} bytes.`);
        }
    }

    /** Read exactly one 64-byte-or-short USB packet; retain DataView offset and length.
     * @param {object} token @param {number} deadline @returns {Promise<Uint8Array>} */
    async packet(token, deadline) {
        const remainingTime = deadline - performance.now();
        if (remainingTime <= 0) throw this.fail('USB_RESPONSE_TIMEOUT: complete response not received.');
        const device = this.openedDevice(token);
        const result = await this.io(token, 'EP1 IN', () => device.transferIn(1, 64), remainingTime);
        if (result.status !== 'ok' || !result.data) {
            throw this.fail(`EP1 IN: ${result.status}; missing or invalid data.`);
        }
        const view = result.data;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        if (bytes.length > 64 || bytes.length === 1) {
            throw this.fail(`USB_FRAMING_ERROR: ${bytes.length}-byte FTDI packet.`);
        }
        return bytes;
    }

    /** Central reader for GPIO, JEDEC, status and raw flash data. Status-only packets are not
     * replies. Extra payload is a desynchronization error, never silently truncated/reused.
     * @param {object} token @param {number} count @param {string} label
     * @returns {Promise<Uint8Array>} */
    async readExact(token, count, label) {
        const output = new Uint8Array(count);
        const deadline = performance.now() + this.timeoutMs;
        let received = 0;
        let statusOnly = 0;
        while (received < count) {
            const raw = await this.packet(token, deadline);
            if (raw.length <= 2) {
                if (++statusOnly > 128) throw this.fail(`${label}: too many status-only packets.`);
                // Yield for a status-only/ZLP stream; the response deadline still applies.
                await new Promise(resolve => setTimeout(resolve, 1));
                continue;
            }
            const payload = raw.subarray(2);
            if (payload.length > count - received) {
                throw this.fail(`USB_DESYNC (${label}): expected ${count - received} remaining bytes, ` +
                    `received ${payload.length}. Restart Core Flasher; response not accepted.`);
            }
            output.set(payload, received);
            received += payload.length;
        }
        return output;
    }

    /** @param {object} token */
    async select(token) {
        this.checkpoint(token);
        if (this.device) return;
        if (!this.usb) throw new Error('WebUSB unavailable. Open this website in Chrome or Edge over a secure connection.');
        const device = await this.usb.requestDevice({filters: [{vendorId: 0x0403, productId: 0x6014}]});
        this.assertOwner(token);
        if (device.vendorId !== 0x0403 || device.productId !== 0x6014) throw new Error('Unexpected USB device.');
        this.device = device;
        this.log(`Selected: ${device.productName || 'Flipper USB bridge'} (0403:6014).`);
        this.changed();
    }

    /** @param {object} token */
    async open(token) {
        this.checkpoint(token);
        const device = this.device;
        if (!device) throw new Error('Connect first.');
        if (!device.opened) await this.io(token, 'open', () => device.open());
        if (!device.configuration || device.configuration.configurationValue !== 1) {
            await this.io(token, 'selectConfiguration', () => device.selectConfiguration(1));
        }
        const iface = device.configuration.interfaces.find(item => item.interfaceNumber === 0);
        const alt = iface?.alternates.find(item => item.alternateSetting === 0);
        const inEp = alt?.endpoints.find(ep => ep.direction === 'in' && ep.endpointNumber === 1);
        const outEp = alt?.endpoints.find(ep => ep.direction === 'out' && ep.endpointNumber === 2);
        if (!inEp || !outEp || inEp.type !== 'bulk' || outEp.type !== 'bulk' ||
            inEp.packetSize !== 64 || outEp.packetSize !== 64) {
            throw this.fail('Unexpected Flipper USB bridge descriptors: need interface 0, bulk IN1/OUT2, 64 B.');
        }
        if (!iface.claimed) await this.io(token, 'claimInterface', () => device.claimInterface(0));
        if (iface.alternate?.alternateSetting !== 0 && device.selectAlternateInterface) {
            await this.io(token, 'selectAlternateInterface', () => device.selectAlternateInterface(0, 0));
        }
        this.log('USB opened; configuration 1, interface 0 claimed; IN1/OUT2 verified.');
        this.changed();
    }

    /** 0x020B also sets physical output directions through FlipTDI's SET_BITMODE path.
     * No 0x0000 mode reset (UART activation). Only an explicit compatible profile
     * receives clock commands, after the final reset in prime().
     * @param {object} token */
    async enableMpsse(token) {
        this.checkpoint(token);
        if (this.mpsse && this.primed && this.idleVerified) {
            await this.out(token, [0x81, 0x87], 'MPSSE completion fence');
            await this.readExact(token, 1, 'MPSSE completion fence');
        }
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.mpsse = false;
        this.primed = false;
        this.idleVerified = false;
        await this.controlOut(token, 0x0B, 0x020B, 'SET_BITMODE 020B');
        this.mpsse = true;
        this.log('MPSSE configured: SET_BITMODE=020B; logical B0/B1/B3 output, B2 input.');
        this.changed();
    }

    /** Prime only at an exclusive, known transaction boundary. Purges are explicit because
     * RESET_SIO does not clear the supplied firmware's stream buffers. An endpoint packet
     * containing old payload is NOT accepted as a successful bootstrap.
     * @param {object} token */
    async prime(token) {
        this.checkpoint(token);
        if (!this.mpsse) throw new Error('Enable MPSSE first.');
        // GPIO-stepped diagnostics do not use the hardware SPI prescaler.
        const clockSelection = token.label === 'gpio-diagnosis' ? null : this.prepareClockChange();
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.primed = false;
        this.idleVerified = false;
        await this.controlOut(token, 0x00, 1, 'PURGE host-to-device');
        await this.controlOut(token, 0x00, 2, 'PURGE device-to-host');
        await this.controlOut(token, 0x00, 0, 'RESET_SIO status request');
        const deadline = performance.now() + this.timeoutMs;
        let status;
        do { status = await this.packet(token, deadline); } while (status.length === 0);
        if (status.length !== 2) {
            throw this.fail(`USB_DESYNC at prime: ${FlipTdiWebUsb.hex(status)}. ` +
                'Stale payload in endpoint; restart Core Flasher before reconnecting.');
        }
        this.log(`EP1 PRIME: ${FlipTdiWebUsb.hex(status)}; status only.`);
        this.primed = true;
        // Two distinct masks force both physical GPIO modes and MPSSE cached callbacks
        // into agreement, even after repeated SET_BITMODE calls. CS stays requested HIGH.
        await this.out(token, [0x80, 0x08, 0x08, 0x80, 0x08, 0x0B, 0x81, 0x87], 'GPIO idle setup');
        const pins = (await this.readExact(token, 1, 'GPIO idle verification'))[0];
        this.lastGpio = pins;
        if ((pins & 0x0B) !== 0x08) {
            throw this.fail(`GPIO_IDLE_FAILED: ${FlipTdiWebUsb.hex([pins])}; need (GPIO & 0B)=08. ` +
                'No SPI commands were sent. Check the TB2 app/build and pin levels.');
        }
        this.idleVerified = true;
        if (clockSelection) await this.applyClockUnlocked(token, clockSelection);
        this.log(`GPIO IDLE OK: ${FlipTdiWebUsb.hex([pins])}; CS=HIGH, SCK/MOSI=LOW. ` +
            'Logical levels checked; physical mapping is provided by the TB2 firmware.');
        this.changed();
    }

    /** @param {object} token */
    requireSpi(token) {
        this.openedDevice(token);
        if (!this.mpsse || !this.primed || !this.idleVerified) {
            throw new Error('Run MPSSE Enable then Prime EP1 + GPIO Check first.');
        }
    }

    /** TB2-only direct hardware-SPI proof-of-concept command (firmware opcode 0xF0).
     * Reply layout: status, JEDEC[0], JEDEC[1], JEDEC[2]. status bit0=transport OK,
     * bit1=firmware verified EF 40 18. This command does not use the MPSSE byte shifters.
     * @param {object} token
     * @returns {Promise<{transportOk:boolean,verified:boolean,id:Uint8Array,status:number}>} */
    async nativeJedec(token) {
        this.requireSpi(token);
        await this.out(token, [0xF0], 'TB2 native HW JEDEC OUT');
        const reply = await this.readExact(token, 4, 'TB2 native HW JEDEC');
        const status = reply[0];
        const id = reply.slice(1, 4);
        return {
            transportOk: !!(status & 0x01),
            verified: !!(status & 0x02),
            id,
            status
        };
    }

    /** Normal client SPI path: MPSSE write 0x11 + read 0x24 through the raw hardware-SPI bridge.
     * Native command 0xF0 is diagnostic only and is not a prerequisite for these transfers.
     * @param {object} token @param {number[]} command @param {number} length @param {string} label
     * @returns {Promise<Uint8Array>} */
    async spiRead(token, command, length, label) {
        this.requireSpi(token);
        if (!Number.isInteger(length) || length < 1 || length > 4096) throw new Error('Invalid SPI read length.');
        if (!((command[0] === 0x9F && command.length === 1 && length === 3) ||
              (command[0] === 0x4B && command.length === 5 && command.slice(1).every(byte => byte === 0) && length === 8) ||
              (command[0] === 0x05 && command.length === 1 && length === 1) ||
              (command[0] === 0x35 && command.length === 1 && length === 1) ||
              (command[0] === 0x15 && command.length === 1 && length === 1) ||
              (command[0] === 0x3D && command.length === 4 && length === 1) ||
              (command[0] === 0x03 && command.length === 4))) {
            throw new Error('SPI read opcode/length is not allowed.');
        }
        const n = length - 1;
        const tx = [0x80, 0x08, 0x0B, 0x80, 0x00, 0x0B,
            0x11, command.length - 1, 0x00, ...command,
            0x24, n & 255, (n >>> 8) & 255, 0x80, 0x08, 0x0B, 0x87];
        await this.out(token, tx, `${label} OUT`);
        return this.readExact(token, length, label);
    }

    /**
     * Build one FTDI/MPSSE write-only SPI transaction.
     *
     * FlipTDI receives USB OUT in 64-byte endpoint packets. Its MPSSE 0x11 handler requests the
     * complete declared payload from a stream buffer in one receive call. A 260-byte Page Program
     * therefore must not expose one 260-byte 0x11 payload spanning multiple USB packets: depending
     * on scheduling, a partial receive can leave page bytes behind and those bytes are then parsed
     * as MPSSE opcodes.
     *
     * For a full 256-byte Page Program the stream below deliberately aligns every 0x11 command to
     * one USB packet while keeping CS LOW across all chunks:
     *
     *   packet 0: CS setup (6) + 0x11 header (3) + 55 SPI bytes = 64
     *   packet 1:             0x11 header (3) + 61 SPI bytes = 64
     *   packet 2:             0x11 header (3) + 61 SPI bytes = 64
     *   packet 3:             0x11 header (3) + 61 SPI bytes = 64
     *   packet 4:             0x11 header (3) + 22 SPI bytes + CS HIGH + 0x87
     *
     * The native Flipper SPI backend remains acquired until the final SET_BITS_LOW raises CS, so
     * the flash sees one uninterrupted SPI transaction.
     *
     * @param {number[]} bytes
     * @returns {number[]}
     */
    buildMpsseSpiWrite(bytes) {
        const prefix = [
            0x80, 0x08, 0x0B, // known idle / CS high
            0x80, 0x00, 0x0B  // CS low
        ];
        const suffix = [
            0x80, 0x08, 0x0B, // CS high: ends native transaction
            0x87               // send immediate
        ];

        // Short commands fit in one USB packet exactly as before.
        if (prefix.length + 3 + bytes.length + suffix.length <= 64) {
            const n = bytes.length - 1;
            return [
                ...prefix,
                0x11, n & 255, (n >>> 8) & 255, ...bytes,
                ...suffix
            ];
        }

        // The only currently allowed large transaction is a complete Page Program:
        // opcode + 24-bit address + 256 data bytes = 260 SPI bytes.
        if (bytes[0] !== 0x02 || bytes.length !== 260) {
            throw new Error(
                `MPSSE_WRITE_PACKETIZATION_UNSUPPORTED: opcode=0x${bytes[0].toString(16)}, bytes=${bytes.length}`
            );
        }

        const tx = [];
        let offset = 0;

        // First USB packet: 6-byte CS prefix + 3-byte MPSSE header + 55-byte SPI chunk.
        tx.push(...prefix);
        {
            const count = 55;
            tx.push(0x11, (count - 1) & 255, 0x00);
            tx.push(...bytes.slice(offset, offset + count));
            offset += count;
        }

        // Three complete 64-byte packets: 3-byte header + 61-byte SPI chunk.
        for (let packet = 0; packet < 3; packet++) {
            const count = 61;
            tx.push(0x11, (count - 1) & 255, 0x00);
            tx.push(...bytes.slice(offset, offset + count));
            offset += count;
        }

        // Final 22 SPI bytes + CS high + immediate. This is intentionally the short final packet.
        const remaining = bytes.length - offset;
        if (remaining !== 22) {
            throw new Error(`MPSSE_PAGE_PACKETIZATION_INTERNAL: remaining=${remaining}`);
        }
        tx.push(0x11, (remaining - 1) & 255, 0x00);
        tx.push(...bytes.slice(offset));
        tx.push(...suffix);

        // USB bulk transfer packet boundaries occur every 64 bytes. Assert the intended layout.
        if (tx.length !== 4 * 64 + 29) {
            throw new Error(`MPSSE_PAGE_PACKETIZATION_INTERNAL: tx=${tx.length}`);
        }

        return tx;
    }

    /** Send one write-only SPI transaction through the verified native bridge.
     * Allowed opcodes are deliberately restricted to WRDI, WREN, 4-KiB erase and Page Program.
     * @param {object} token @param {number[]} bytes @param {string} label */
    async spiWrite(token, bytes, label) {
        this.requireSpi(token);
        if (!Array.isArray(bytes) || bytes.length < 1 || bytes.length > 260) {
            throw new Error('Invalid SPI write transaction length.');
        }
        const opcode = bytes[0];
        const valid =
            (opcode === 0x04 && bytes.length === 1) ||
            (opcode === 0x06 && bytes.length === 1) ||
            (opcode === 0x20 && bytes.length === 4) ||
            (opcode === 0x02 && bytes.length >= 5 && bytes.length <= 260);
        if (!valid) {
            throw new Error(
                `SPI write opcode/length not allowed: 0x${opcode.toString(16)}`
            );
        }

        const tx = this.buildMpsseSpiWrite(bytes);
        if (opcode === 0x20 || opcode === 0x02) {
            this.assertDestructiveWrite(token);
            token.destructiveIssued = true;
        }
        await this.out(token, tx, `${label} OUT`);

        // Do not weaken this check. Any unexpected payload means the MPSSE stream actually
        // desynchronized and must be rejected rather than silently truncating stale bytes.
        await this.out(token, [0x81, 0x87], `${label} FENCE OUT`);
        const gpio = (await this.readExact(token, 1, `${label} FENCE`))[0];
        if ((gpio & 0x0B) !== 0x08) {
            throw new Error(
                `${label}_FENCE_FAILED: GPIO=0x${gpio.toString(16).padStart(2, '0').toUpperCase()}, expected CS high / SCK+MOSI low.`
            );
        }
    }

    /** Raw MPSSE/HW-SPI bridge -> JEDEC wait -> read/write preflight.
     * Full reads stay locked until the bridge and target chip are verified.
     * @param {object} token @returns {Promise<Uint8Array|null>} */
    async wait(token) {
        this.requireSpi(token);
        this.forgetBaseline();
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.phase = 'waiting native HW-SPI';
        this.changed();
        this.log(
            '[BRIDGE] WAITING FOR CHIP: USB/MPSSE is ready. ' +
            'Switch target 3.3 V ON when ready.'
        );

        let attempts = 0;
        while (!token.stop) {
            this.assertOwner(token);

            // The production firmware is a raw SPI bridge. 0xF0 remains an optional
            // diagnostic command only and must not gate normal operation. Probe the
            // actual client path directly: CS + 0x9F + 3-byte RX.
            const waitId = await this.spiRead(
                token,
                [0x9F],
                3,
                'WAIT JEDEC'
            );
            attempts++;
            const waitHex = FlipTdiWebUsb.hex(waitId);

            if (token.stop) break;

            if (waitHex === 'EF 40 18') {
                // Keep the historical fields for compatibility with the rest of the
                // client; they now mean "raw bridge JEDEC verified".
                this.hwJedecVerified = true;
                this.hwJedecId = waitHex;
                this.log(
                    `[BRIDGE] JEDEC OK: ${waitHex} after ${attempts} attempt` +
                    `${attempts === 1 ? '' : 's'}.`
                );
                this.changed();
                break;
            }

            // No valid JEDEC while target power is off is expected. Do not convert it
            // into a fault and do not start the Zadig/USB error path.
            if (attempts === 1 || attempts % 20 === 0) {
                this.log(
                    `[BRIDGE] waiting for target power; attempt ${attempts}, ` +
                    `JEDEC=${waitHex}.`
                );
            }

            // Give the user time to switch 3.3 V on. There is deliberately no deadline;
            // the Connect button becomes Stop while this loop owns the session.
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (token.stop || !this.hwJedecVerified) {
            this.log(`[BRIDGE] WAIT stopped after ${attempts} completed attempts.`);
            return null;
        }

        this.checkpoint(token);
        this.phase = 'verifying native bridge';
        this.changed();
        this.log('[BRIDGE] Chip detected. Verifying the browser raw-SPI path...');

        const bridgeId = await this.spiRead(token, [0x9F], 3, 'BRIDGE JEDEC');
        const bridgeHex = FlipTdiWebUsb.hex(bridgeId);
        if (bridgeHex !== 'EF 40 18') {
            this.log(`[BRIDGE] JEDEC FAILED: ${bridgeHex}; direct HW-SPI was ${this.hwJedecId}. Full reads remain locked.`);
            throw new Error(`MPSSE_TO_HW_SPI_BRIDGE_FAILED: expected EF 40 18, got ${bridgeHex}`);
        }
        this.log(`[BRIDGE] JEDEC OK: ${bridgeHex}.`);

        const status = (await this.spiRead(token, [0x05], 1, 'BRIDGE Status-1'))[0];
        this.log(`[BRIDGE] STATUS-1: ${FlipTdiWebUsb.hex([status])}.`);

        // Diagnose the exact boundary where repeated READ DATA transactions stop being stable.
        // 62 bytes is the FTDI payload capacity of one 64-byte USB IN packet (2 status bytes + data).
        const diagnosticLengths = [1, 2, 4, 8, 16, 32, 60, 61, 62, 63, 64, 96, 128, 192, 256];
        let verified256 = null;

        const mismatchInfo = (a, b) => {
            const limit = Math.min(a.length, b.length);
            let index = -1;
            for (let i = 0; i < limit; i++) {
                if (a[i] !== b[i]) {
                    index = i;
                    break;
                }
            }
            if (index < 0 && a.length !== b.length) index = limit;
            if (index < 0) return null;
            const start = Math.max(0, index - 8);
            const end = Math.min(limit, index + 16);
            return {
                index,
                start,
                end,
                a: a.slice(start, end),
                b: b.slice(start, end),
            };
        };

        for (const length of diagnosticLengths) {
            const command = [0x03, 0x00, 0x00, 0x00];
            const a = await this.spiRead(token, command, length, `READ-DIAG ${length} A`);
            const b = await this.spiRead(token, command, length, `READ-DIAG ${length} B`);
            const mismatch = mismatchInfo(a, b);

            if (mismatch) {
                this.log(`[READ-DIAG] ${length} B FAILED: first mismatch at offset 0x${mismatch.index.toString(16).toUpperCase().padStart(4, '0')}.`);
                this.log(`[READ-DIAG] A[${mismatch.start}..${mismatch.end - 1}] = ${FlipTdiWebUsb.hex(mismatch.a)}`);
                this.log(`[READ-DIAG] B[${mismatch.start}..${mismatch.end - 1}] = ${FlipTdiWebUsb.hex(mismatch.b)}`);
                throw new Error(`BRIDGE_READ_MISMATCH_${length}: repeated reads differ at offset ${mismatch.index}.`);
            }

            const preview = FlipTdiWebUsb.hex(a.slice(0, Math.min(a.length, 16)));
            this.log(`[READ-DIAG] ${length} B: OK; repeated reads identical; first bytes=${preview}${a.length > 16 ? ' ...' : ''}`);

            if (length === 256) verified256 = a;
        }

        if (!verified256) {
            throw new Error('READ_DIAG_INTERNAL: 256-byte verification result missing.');
        }

        const read4k = await this.spiRead(token, [0x03, 0x00, 0x00, 0x00], 4096, 'BRIDGE READ 4096');
        const prefixMismatch = mismatchInfo(verified256, read4k.slice(0, verified256.length));
        if (prefixMismatch) {
            this.log(`[READ-DIAG] 4096 B FAILED: prefix mismatch at offset 0x${prefixMismatch.index.toString(16).toUpperCase().padStart(4, '0')}.`);
            this.log(`[READ-DIAG] 256-ref = ${FlipTdiWebUsb.hex(prefixMismatch.a)}`);
            this.log(`[READ-DIAG] 4K-pref = ${FlipTdiWebUsb.hex(prefixMismatch.b)}`);
            throw new Error(`BRIDGE_READ_4096_MISMATCH: prefix differs at offset ${prefixMismatch.index}.`);
        }
        this.log('[BRIDGE] READ 4096: OK; first 256 bytes match the verified repeated reads.');

        await this.readFlashChipIdUnlocked(token);
        this.detectedId = bridgeHex;
        this.preflightVerified = true;

        try {
            const capability = await this.probeWriteCapabilityUnlocked(token);
            this.writeCapabilityVerified = capability.available;
            this.writeCapabilityReason = capability.reason;
            this.log(`[WRITE-CAP] ${capability.available ? 'AVAILABLE' : 'BLOCKED'}: ${capability.reason}.`);
        }
        catch (error) {
            this.writeCapabilityVerified = false;
            this.writeCapabilityReason = String(error?.message || error);
            if (this.fault) throw error;
            this.log(`[WRITE-CAP] BLOCKED: ${this.writeCapabilityReason}.`);
        }

        this.phase = 'ready';
        this.log(
            '[READY] Native HW-SPI + bridge + read preflight passed. ' +
            `Flash write=${this.writeCapabilityVerified ? 'AVAILABLE' : 'BLOCKED'}.`
        );
        this.changed();
        return bridgeId;
    }

    /** Build a diagnostic JEDEC transaction using only SET_BITS_LOW / GET_BITS_LOW.
     * Each GPIO command is paced by the supplied FlipTDI worker, not by host sleep timing.
     * No 0x11/0x24 byte shifters or unsupported clock-divisor instructions are used.
     * Read-back observes the Flipper pad, NOT the far end of a wire or analog edge timing.
     * @returns {{tx: number[], samples: {value:number,label:string,kind:string}[]}} */
    static buildGpioJedecProbe() {
        const tx = [];
        const samples = [];
        const drive = value => tx.push(0x80, value, 0x0B);
        const observe = (value, label, kind = 'level') => {
            tx.push(0x81);
            samples.push({value, label, kind});
        };
        drive(0x08);
        observe(0x08, 'idle before');
        drive(0x00);
        observe(0x00, 'CS selected');
        for (let bit = 7; bit >= 0; bit--) {
            const mosi = (0x9F & (1 << bit)) ? 0x02 : 0x00;
            drive(mosi);
            observe(mosi, `command bit ${bit} / CLK low`);
            drive(mosi | 0x01);
            observe(mosi | 0x01, `command bit ${bit} / CLK high`, 'command');
            drive(mosi);
        }
        drive(0x00);
        for (let bit = 0; bit < 24; bit++) {
            drive(0x00);
            drive(0x01);
            observe(0x01, `data bit ${bit} / CLK high`, 'data');
            drive(0x00);
        }
        drive(0x08);
        observe(0x08, 'idle after');
        tx.push(0x87);
        return {tx, samples};
    }

    /** Interpret one complete GPIO reply stream, without granting normal SPI readiness.
     * @param {Uint8Array} raw @param {{value:number,label:string,kind:string}[]} samples
     * @returns {{id:Uint8Array,commandEcho:number,outputsOk:boolean,mismatches:string[],raw:Uint8Array}} */
    static decodeGpioJedecProbe(raw, samples) {
        if (!(raw instanceof Uint8Array) || raw.length !== samples.length) {
            throw new Error('GPIO_PROBE_FRAMING: incomplete GPIO samples.');
        }
        const id = new Uint8Array(3);
        const mismatches = [];
        let commandEcho = 0;
        let dataBit = 0;
        for (let index = 0; index < samples.length; index++) {
            const expected = samples[index];
            if ((raw[index] & 0x0B) !== expected.value) {
                mismatches.push(`${expected.label}: GPIO=${FlipTdiWebUsb.hex([raw[index]])}, ` +
                    `expected output bits=${FlipTdiWebUsb.hex([expected.value])}`);
            }
            if (expected.kind === 'command') {
                commandEcho = (commandEcho << 1) | ((raw[index] >>> 1) & 1);
            }
            if (expected.kind === 'data') {
                id[dataBit >>> 3] |= ((raw[index] >>> 2) & 1) << (7 - (dataBit & 7));
                dataBit++;
            }
        }
        return {id, commandEcho, outputsOk: mismatches.length === 0, mismatches, raw};
    }

    /** Compare with the fast path using an independent, GPIO-stepped JEDEC-only probe.
     * One exclusive lease covers initialization, all 43 sample replies, retries and Stop.
     * A successful GPIO probe deliberately does NOT enable fast status/range/dump reads.
     * @returns {Promise<object|null>} */
    probeJedecViaGpio() {
        return this.exclusive('gpio-diagnosis', async token => {
            this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
            this.lastProbe = null;
            this.probeSummary = 'initializing';
            this.changed();
            try {
                await this.select(token);
                await this.open(token);
                await this.enableMpsse(token);
                await this.prime(token);
                this.checkpoint(token);
                const plan = FlipTdiWebUsb.buildGpioJedecProbe();
                const deadline = performance.now() + 20000;
                let attempts = 0;
                let stableMatches = 0;
                let lastSummary = '';
                this.phase = 'gpio-test waiting';
                this.probeSummary = 'waiting for power / GPIO JEDEC';
                this.changed();
                this.log('GPIO TEST READY: switch target 3.3 V ON now. JEDEC only; ' +
                    'GPIO-stepped clocks bypass the 0x11/0x24 byte loops. Window: 20 seconds.');
                while (!token.stop && performance.now() < deadline) {
                    this.assertOwner(token);
                    // A complete command is queued; all replies, including the final idle fence,
                    // are consumed before stop is honored or another command can be issued.
                    await this.out(token, plan.tx, 'GPIO JEDEC probe OUT');
                    const raw = await this.readExact(token, plan.samples.length, 'GPIO JEDEC probe');
                    const result = FlipTdiWebUsb.decodeGpioJedecProbe(raw, plan.samples);
                    this.lastProbe = result;
                    this.lastGpio = raw[raw.length - 1];
                    attempts++;
                    if (token.stop) break;
                    const hex = FlipTdiWebUsb.hex(result.id);
                    const matches = result.outputsOk && result.commandEcho === 0x9F && hex === 'EF 40 18';
                    stableMatches = matches ? stableMatches + 1 : 0;
                    const summary = `outputs=${result.outputsOk ? 'OK' : 'MISMATCH'}, ` +
                        `MOSI echo=${FlipTdiWebUsb.hex([result.commandEcho])}, JEDEC=${hex}`;
                    this.probeSummary = `${summary} / matches ${stableMatches}/3`;
                    this.changed();
                    if (attempts === 1 || attempts % 20 === 0 || summary !== lastSummary) {
                        this.log(`GPIO JEDEC TEST #${attempts}: ${summary}.`);
                        if (summary !== lastSummary || attempts === 1) {
                            this.log(`GPIO SAMPLES (${raw.length}): ${FlipTdiWebUsb.hex(raw)}`);
                            if (!result.outputsOk) this.log('GPIO LEVEL MISMATCH: ' + result.mismatches.slice(0, 4).join('; '));
                        }
                    }
                    lastSummary = summary;
                    if (stableMatches === 3) {
                        this.probeSummary = 'GPIO JEDEC PASS: EF 40 18, 3 consecutive; normal SPI still unverified';
                        this.log(this.probeSummary + '. No flash reads/dumps were enabled.');
                        this.changed();
                        return result;
                    }
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                this.probeSummary = token.stop ? 'stopped; normal SPI still unverified' :
                    'test window ended; normal SPI still unverified';
                this.log(`GPIO JEDEC TEST ${token.stop ? 'STOPPED' : 'ENDED'} after ${attempts} attempts; ` +
                    (this.lastProbe ? `last JEDEC=${FlipTdiWebUsb.hex(this.lastProbe.id)}, ` +
                        `outputs=${this.lastProbe.outputsOk ? 'OK' : 'MISMATCH'}.` : 'no complete sample.'));
                return null;
            } catch (error) {
                this.probeSummary = `${error.name === 'AbortError' ? 'stopped' : 'failed'}: ${error.message || error}`;
                throw error;
            } finally {
                this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
                this.changed();
            }
        });
    }

    /** @returns {Promise<Uint8Array|null>} */
    autoDetect() {
        return this.exclusive('detection', async token => {
            await this.select(token);
            await this.open(token);
            await this.enableMpsse(token);
            await this.prime(token);
            this.checkpoint(token);
            return this.wait(token);
        });
    }

    /** @returns {Promise<void>} */
    connect() { return this.exclusive('connect', token => this.select(token)); }
    /** @returns {Promise<void>} */
    openAndClaim() { return this.exclusive('open', token => this.open(token)); }
    /** @returns {Promise<void>} */
    setMpsse() { return this.exclusive('MPSSE setup', token => this.enableMpsse(token)); }
    /** @returns {Promise<void>} */
    primeEp1() { return this.exclusive('EP1 / GPIO check', token => this.prime(token)); }
    /** @returns {Promise<Uint8Array|null>} */
    waitForChip() { return this.exclusive('wait-chip', token => this.wait(token)); }

    /** @returns {Promise<number>} */
    readGpio() {
        return this.exclusive('GPIO read', async token => {
            this.requireSpi(token);
            await this.out(token, [0x81, 0x87], 'GPIO OUT');
            const pins = (await this.readExact(token, 1, 'GPIO'))[0];
            this.lastGpio = pins;
            this.log(`MPSSE GPIO: ${FlipTdiWebUsb.hex([pins])}; complete 1-byte response.`);
            return pins;
        });
    }

    /** @returns {Promise<number>} */
    readPinsEp0() {
        return this.exclusive('EP0 pins', async token => {
            const device = this.openedDevice(token);
            const result = await this.io(token, 'EP0 READ_PINS', () => device.controlTransferIn({
                requestType: 'vendor', recipient: 'device', request: 0x0C, value: 0, index: 1
            }, 1));
            if (result.status !== 'ok' || result.data?.byteLength !== 1) {
                throw this.fail('EP0 READ_PINS: invalid response.');
            }
            const pins = result.data.getUint8(0);
            this.log(`EP0 READ_PINS: ${FlipTdiWebUsb.hex([pins])}`);
            return pins;
        });
    }

    /** @returns {Promise<Uint8Array>} */
    readJedec() {
        return this.exclusive('JEDEC', async token => {
            this.forgetBaseline();
            this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
            this.changed();
            if (!this.hwJedecVerified) throw new Error('Run Start TB2 Detection first; native HW-SPI gate is not verified.');
            const id = await this.spiRead(token, [0x9F], 3, 'JEDEC');
            const hex = FlipTdiWebUsb.hex(id);
            if (hex === 'EF 40 18') {
                await this.readFlashChipIdUnlocked(token);
                this.detectedId = hex;
            }
            this.log(`${this.detectedId ? 'JEDEC OK' : 'JEDEC UNEXPECTED'}: ${hex}; expected EF 40 18.`);
            return id;
        });
    }

    /** @returns {Promise<number>} */
    readStatus() {
        return this.exclusive('Status-1', async token => {
            if (!this.ready) throw new Error('Detect a valid chip before interpreting Status-1.');
            const value = (await this.spiRead(token, [0x05], 1, 'Status-1'))[0];
            this.log(`STATUS-1: ${FlipTdiWebUsb.hex([value])} ` +
                `(WIP=${value & 1}, WEL=${(value >>> 1) & 1}, BP=${(value >>> 2) & 7}, ` +
                `TB=${(value >>> 5) & 1}, SEC=${(value >>> 6) & 1}, SRP0=${value >>> 7})`);
            return value;
        });
    }

    /** Drop readiness without touching an existing downloaded/in-memory verified backup. */
    invalidateChip() {
        this.forgetBaseline();
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.changed();
    }

    /** @returns {Promise<void>} */
    disconnect() {
        return this.exclusive('disconnect', async token => {
            // exclusive() refuses pending operations even when allowFault=true.
            this.clockState = null;
            this.changed();
            const device = this.device;
            if (device?.opened) {
                // Closing a settled handle only. No GPIO changes, bitmode reset or device reset.
                await device.close();
            }
            if (token.epoch === this.epoch) {
                this.epoch++;
                this.clearConnection();
                this.log('Disconnected; no active USB transfer was abandoned.');
            }
        }, true);
    }

    /** @param {USBDevice} device */
    onDisconnect(device) {
        if (device !== this.device) return;
        this.epoch++;
        if (this.owner) this.owner.stop = true;
        this.cancelIo?.(new Error('USB_DISCONNECTED: device physically detached.'));
        this.pending = null;
        this.clearConnection();
        this.log('USB device disconnected; chip readiness invalidated.');
        this.changed();
    }

    /** @returns {void} */
    clearConnection() {
        this.forgetBaseline();
        this.clockState = null;
        this.clockProfile = 'legacy';
        this.device = null;
        this.mpsse = false;
        this.primed = false;
        this.idleVerified = false;
        this.lastGpio = null;
        this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.hwJedecVerified = false;
        this.hwJedecId = null;
        this.preflightVerified = false;
        this.writeCapabilityVerified = false;
        this.writeCapabilityReason = 'not tested';
        this.fault = '';
        this.probeSummary = 'not run';
        this.lastProbe = null;
    }
}
window.FlipTdiWebUsb = FlipTdiWebUsb;
