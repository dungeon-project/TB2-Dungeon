/** Binary serprog v1 transport. All flash algorithms remain in SpiNorFlash. */
class Serprog extends SpiNorFlash {
    static CLOCKS = [250000, 500000, 1000000, 2000000, 4000000, 8000000, 16000000];
    static ACK = 0x06;
    static NAK = 0x15;
    static RX_LIMIT = 65536;
    static BAUD_RATES = [115200, 230400, 460800, 921600];
    static CHIP_POLL_MS = 100;
    static WRITE_ACTIONS = new Set(['flash-write', 'full-image-write']);

    constructor({serial, changed = () => {}, log = () => {}, readAllowed = () => false,
        writeAllowed = () => false, connectAllowed = () => true, clockChangeAllowed = () => true, authorizeWrite,
        confirmHighClock = () => false, timeoutMs = 5000}) {
        super();
        Object.assign(this, {serial, changed, log, readAllowed, writeAllowed, connectAllowed, clockChangeAllowed,
            authorizeWrite, confirmHighClock, timeoutMs});
        this.port = null; this.reader = null; this.writer = null; this.owner = null;
        this.profile = null;
        this.epoch = 0; this.fault = ''; this.phase = 'Disconnected'; this.detectedId = null; this.flashChipId = null; this.flashChipIdError = '';
        this.writeCapabilityVerified = false; this.writeCapabilityReason = 'not tested';
        this.initialized = false; this.verified = false; this.commandMap = null;
        this.maxRead = 4096; this.maxWrite = 260; this.serialBuffer = 65535;
        this.clockTargetHz = 2000000; this.clockHz = null; this.receive = new Uint8Array(); this.wake = null;
        serial?.addEventListener('disconnect', event => {
            if (event.target === this.port || event.port === this.port) this.fail('Serial adapter disconnected. Reconnect before continuing.');
        });
    }
    get busy() { return !!this.owner; }
    get ready() { return !!this.port && this.initialized && this.verified && !this.fault; }
    get readChunkSize() { return Math.min(4096, this.maxRead); }
    get pageChunkSize() { return Math.min(256, this.maxWrite - 4); }
    supports(command) { return !!(this.commandMap?.[command >> 3] & (1 << (command & 7))); }
    static le(value, length) { return Array.from({length}, (_, i) => Math.floor(value / 2 ** (8 * i)) & 255); }
    static number(bytes) { return bytes.reduce((value, byte, i) => value + byte * 2 ** (8 * i), 0); }

    /** One operation owns both the protocol stream and its backup proof. */
    async exclusive(label, action, allowFault = false) {
        if (this.busy) throw new Error('Another device operation is running.');
        if (this.fault && !allowFault) throw new Error(this.fault);
        const token = {label, epoch: this.epoch, stop: false}; this.owner = token; this.phase = label; this.changed();
        try { return await action(token); }
        finally { if (this.owner === token) this.owner = null; this.phase = this.fault || (this.ready ? 'Ready' : 'Disconnected'); this.changed(); }
    }
    assertOwner(token) {
        if (this.owner !== token || token.epoch !== this.epoch) throw new Error('Serial session changed. Reconnect before continuing.');
        if (this.fault) throw new Error(this.fault);
    }
    checkpoint(token) { this.assertOwner(token); if (token.stop && !token.finishing) throw new DOMException('Operation cancelled.', 'AbortError'); }
    requireSpi(token) { this.assertOwner(token); if (!this.port || !this.initialized) throw new Error('Connect a compatible serprog adapter first.'); }
    requestStop() { if (this.owner && this.owner.label !== 'disconnect') { this.owner.stop = true; this.changed(); } }
    fail(message) {
        this.forgetBaseline();
        this.fault = message; this.verified = false; this.detectedId = null; this.flashChipId = null; this.flashChipIdError = ''; this.clockHz = null;
        this.writeCapabilityVerified = false; this.wake?.(); this.changed(); return new Error(message);
    }
    invalidateChip() { this.forgetBaseline(); this.verified = false; this.detectedId = null; this.flashChipId = null; this.flashChipIdError = ''; this.writeCapabilityVerified = false; this.changed(); }

    /** Wait on the initialized C3 bridge, just as the Flipper waits for target power. */
    async waitForChipUnlocked(token) {
        if (this.profile === 'esp32c3') { this.phase = 'Waiting for chip power'; this.changed(); }
        while (true) {
            const id = await this.spiRead(token, [0x9f], 3);
            this.checkpoint(token);
            if (SpiNorFlash.hex(id) === 'EF 40 18') return;
            if (this.profile !== 'esp32c3') throw new Error('No supported W25Q128 flash detected. Check power and wiring.');
            await new Promise(resolve => setTimeout(resolve, Serprog.CHIP_POLL_MS));
        }
    }

    /** Check the connected chip before a write without discarding a matching baseline. */
    async verifyWriteChipUnlocked(token) {
        if (token.writeChipId && token.writeChipId === this.flashChipId) return;
        const expected = this.flashChipId;
        if (!expected) throw this.fail('A verified flash unique ID is required for writing. Reconnect the adapter.');
        const command = [0x4b, 0, 0, 0, 0];
        const first = await this.spiRead(token, command, 8);
        const second = await this.spiRead(token, command, 8);
        this.checkpoint(token);
        if (this.flashChipId !== expected || first.length !== 8 || second.length !== 8 ||
            SpiNorFlash.hex(first).replace(/ /g, '') !== expected ||
            SpiNorFlash.hex(second).replace(/ /g, '') !== expected) {
            throw this.fail('The flash-chip identity changed. Reconnect before writing.');
        }
        token.writeChipId = expected;
    }

    /** The sole reader preserves binary ACK-valued payload bytes and never decodes text. */
    async pump(epoch) {
        try {
            while (this.reader && epoch === this.epoch) {
                const {value, done} = await this.reader.read();
                if (epoch !== this.epoch) return;
                if (done) throw new Error('Serial stream ended.');
                if (this.receive.length + value.length > Serprog.RX_LIMIT) throw new Error('Serial receive buffer exceeded its limit.');
                const combined = new Uint8Array(this.receive.length + value.length);
                combined.set(this.receive); combined.set(value, this.receive.length); this.receive = combined; this.wake?.();
            }
        } catch (error) { if (epoch === this.epoch) this.fail(error.message || 'Serial read failed.'); }
    }
    async exact(token, count) {
        const deadline = performance.now() + this.timeoutMs;
        while (this.receive.length < count) {
            this.assertOwner(token);
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw this.fail('Serial response timed out. Disconnect and reconnect the adapter.');
            await new Promise(resolve => {
                const timer = setTimeout(() => { this.wake = null; resolve(); }, remaining);
                this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
            });
        }
        this.assertOwner(token);
        const bytes = this.receive.slice(0, count); this.receive = this.receive.slice(count); return bytes;
    }
    async send(token, bytes) {
        this.assertOwner(token);
        let timer;
        try {
            await Promise.race([this.writer.write(Uint8Array.from(bytes)), new Promise((_, reject) => {
                timer = setTimeout(() => reject(this.fail('Serial write timed out. Reconnect before continuing.')), this.timeoutMs);
            })]);
            this.assertOwner(token);
        } catch (error) { throw this.fail(error.message || 'Serial write failed.'); }
        finally { clearTimeout(timer); }
    }
    async command(token, opcode, payload = [], count = 0) {
        this.assertOwner(token);
        if (![0, 1, 2, 16].includes(opcode) && !this.supports(opcode)) throw new Error('The adapter does not support this serprog command.');
        await this.send(token, [opcode, ...payload]);
        const ack = (await this.exact(token, 1))[0];
        if (ack !== Serprog.ACK) throw this.fail(ack === Serprog.NAK ? 'The adapter rejected a command. Reconnect before continuing.' : 'Unexpected serial response. Reconnect before continuing.');
        return this.exact(token, count);
    }

    /** Synchronization tolerates bounded startup text only; normal commands never scan for ACKs. */
    async synchronize(token) {
        await this.send(token, [16]);
        let previous = -1;
        const deadline = performance.now() + this.timeoutMs;
        for (let count = 0; count < Serprog.RX_LIMIT && performance.now() < deadline; count++) {
            const byte = (await this.exact(token, 1))[0];
            if (previous === Serprog.NAK && byte === Serprog.ACK) { await this.command(token, 0); return; }
            previous = byte;
        }
        throw this.fail('No serprog synchronization response. Check the selected port and firmware.');
    }
    async applyClockUnlocked(token) {
        this.clockHz = null;
        if (!this.supports(20)) return;
        const hz = Serprog.number(await this.command(token, 20, Serprog.le(this.clockTargetHz, 4), 4));
        if (!hz || hz > this.clockTargetHz) throw this.fail('The adapter could not apply the requested SPI clock.');
        this.clockHz = hz;
    }
    confirmClock() {
        if (this.clockTargetHz === 16000000 && !this.confirmHighClock()) throw new DOMException('SPI clock change cancelled.', 'AbortError');
    }
    applyClock() {
        if (!this.ready || !this.clockChangeAllowed()) return Promise.reject(new Error('Connect and finish the current operation before changing SPI clock.'));
        if (!Serprog.CLOCKS.includes(this.clockTargetHz)) return Promise.reject(new Error('Unsupported SPI clock.'));
        this.confirmClock();
        return this.exclusive('clock-change', token => this.applyClockUnlocked(token));
    }

    /** requestPort runs before any await so browser user activation is preserved. */
    connect({profile, baudRate, clockHz = 2000000}) {
        if (!this.connectAllowed()) return Promise.reject(new Error('Select this adapter and finish the current operation before connecting.'));
        if (!this.serial?.requestPort) return Promise.reject(new Error('Web Serial requires Chrome or Edge over HTTPS or localhost.'));
        if (!['pico','esp32c3'].includes(profile) || !Serprog.BAUD_RATES.includes(baudRate) || !Serprog.CLOCKS.includes(clockHz)) return Promise.reject(new Error('Unsupported serial connection settings.'));
        return this.exclusive('detection', async token => {
            if (clockHz === 16000000 && !this.confirmHighClock()) throw new DOMException('SPI clock change cancelled.', 'AbortError');
            // Reuse the selected handle for an explicit reconnect; a new chooser keeps click activation.
            const port = this.port || await this.serial.requestPort(); this.checkpoint(token);
            if (this.port) {
                await this.closePort();
                token.epoch = this.epoch;
                this.checkpoint(token);
            }
            this.profile = profile;
            this.clockTargetHz = clockHz;
            this.port = port;
            try {
                await this.settle(port.open({baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: Serprog.RX_LIMIT}), 'Serial port open');
                this.reader = port.readable.getReader(); this.writer = port.writable.getWriter();
                this.receive = new Uint8Array(); this.pumping = this.pump(this.epoch);
                if (profile === 'pico' && port.setSignals) await this.settle(port.setSignals({dataTerminalReady: true}), 'Serial DTR activation');
                await this.synchronize(token); this.checkpoint(token);
                if (Serprog.number(await this.command(token, 1, [], 2)) !== 1) throw new Error('Unsupported serprog protocol version.');
                // Query capabilities before using optional bus, buffer or clock commands.
                this.commandMap = await this.command(token, 2, [], 32);
                if (!this.supports(5) || !this.supports(19)) throw new Error('This adapter does not support serprog SPI operations.');
                const buses = (await this.command(token, 5, [], 1))[0];
                if (!(buses & 8)) throw new Error('The selected adapter has no SPI bus.');
                if (this.supports(18)) await this.command(token, 18, [8]);
                else if (buses !== 8) throw new Error('The adapter cannot select SPI exclusively.');
                // Old bridges may advertise only tiny SPI buffers; headers count against writes.
                this.serialBuffer = this.supports(4) ? Serprog.number(await this.command(token, 4, [], 2)) : 64;
                this.maxWrite = this.supports(8) ? Serprog.number(await this.command(token, 8, [], 3)) || 0x1000000 : Math.max(0, Math.min(260, this.serialBuffer - 7));
                this.maxRead = this.supports(17) ? Serprog.number(await this.command(token, 17, [], 3)) || 0x1000000 : 4096;
                if (this.maxWrite < 5 || this.maxRead < 1 || this.serialBuffer < 8) throw new Error('The adapter buffers are too small for this flash.');
                if (this.supports(23)) await this.command(token, 23, [0]);
                if (this.supports(24)) await this.command(token, 24, [0]);
                if (this.supports(21)) await this.command(token, 21, [1]);
                await this.applyClockUnlocked(token); this.initialized = true;
                // Publish readiness only within this exclusive detection session.
                await this.waitForChipUnlocked(token);
                this.phase = 'Checking flash connection'; this.changed();
                const second = await this.spiRead(token, [0x9f], 3);
                if (SpiNorFlash.hex(second) !== 'EF 40 18') throw new Error('No stable W25Q128 flash detected. Check power and wiring.');
                await this.readFlashChipIdUnlocked(token);
                this.detectedId = 'EF 40 18'; this.verified = true;
                const a = await this.readRangeUnlocked(token, 0, 4096), b = await this.readRangeUnlocked(token, 0, 4096);
                if (a.some((value, index) => value !== b[index])) throw new Error('Flash connection is unstable: repeated reads differ.');
                const capability = await this.probeWriteCapabilityUnlocked(token);
                this.writeCapabilityVerified = capability.available; this.writeCapabilityReason = capability.reason;
                this.checkpoint(token); this.changed();
            } catch (error) {
                if (error.name !== 'AbortError' || this.fault) this.fail(error.message || 'Serial connection failed.');
                try { await this.closePort(); } catch (closeError) { throw new Error(`${error.message} Port cleanup failed: ${closeError.message}`); }
                throw error;
            }
        });
    }

    /** NOP completion fence proves the firmware returned from its SPI handler (CS released). */
    async spiRead(token, bytes, length) {
        this.checkpoint(token); this.requireSpi(token);
        if (![0x9f,0x03,0x05,0x35,0x15,0x3d,0x4b].includes(bytes[0])) throw new Error('Unsupported flash read command.');
        if (bytes[0] === 0x4b && (bytes.length !== 5 || bytes.slice(1).some(byte => byte !== 0) || length !== 8)) throw new Error('Invalid flash identity request.');
        if (!Number.isInteger(length) || length < 1 || bytes.length > this.maxWrite || length > this.readChunkSize) throw new Error('SPI request exceeds negotiated adapter limits.');
        const result = await this.command(token, 19, [...Serprog.le(bytes.length, 3), ...Serprog.le(length, 3), ...bytes], length);
        await this.command(token, 0); return result;
    }
    async spiWrite(token, bytes) {
        this.checkpoint(token); this.requireSpi(token);
        if (![0x06,0x04,0x02,0x20].includes(bytes[0])) throw new Error('Unsupported flash write command.');
        if (bytes.length > this.maxWrite) throw new Error('SPI write exceeds negotiated adapter limits.');
        const destructive = [2, 32].includes(bytes[0]);
        if (destructive) this.assertDestructiveWrite(token);
        if (this.profile === 'esp32c3' && (destructive ||
            (bytes[0] === 0x06 && Serprog.WRITE_ACTIONS.has(token.label)))) {
            await this.verifyWriteChipUnlocked(token);
        }
        if (destructive) { this.assertDestructiveWrite(token); token.destructiveIssued = true; }
        await this.command(token, 19, [...Serprog.le(bytes.length, 3), 0, 0, 0, ...bytes]);
        await this.command(token, 0);
    }
    /** A stop never interrupts the status polling for an already-issued erase/program. */
    async waitWipClear(token, timeoutMs, label) {
        token.finishing = true;
        try { return await super.waitWipClear(token, timeoutMs, label); }
        catch (error) { throw this.fail(error.message || 'Flash completion could not be confirmed.'); }
        finally { token.finishing = false; this.checkpoint(token); }
    }

    /** Bound OS stream operations too; keep failed handles visible until cleanup succeeds. */
    async settle(operation, label) {
        let timer;
        try {
            return await Promise.race([operation, new Promise((_, reject) => {
                timer = setTimeout(() => reject(this.fail(`${label} timed out. Close this page if the port cannot be released.`)), this.timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }

    /** Release stream locks before close; an epoch change discards late reader results. */
    async closePort() {
        this.epoch++; this.wake?.();
        const reader = this.reader, writer = this.writer, port = this.port;
        if (reader) { await this.settle(reader.cancel(), 'Serial reader cleanup'); await this.pumping; reader.releaseLock(); this.reader = null; }
        if (writer) { await this.settle(writer.abort(), 'Serial writer cleanup'); writer.releaseLock(); this.writer = null; }
        if (port) await this.settle(port.close(), 'Serial port close');
        this.port = null; this.receive = new Uint8Array(); this.initialized = false; this.invalidateChip(); this.clockHz = null;
        this.profile = null;
    }
    disconnect() {
        return this.exclusive('disconnect', async () => {
            await this.closePort(); this.fault = ''; this.commandMap = null;
        }, true);
    }
}
