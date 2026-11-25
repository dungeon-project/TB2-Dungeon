/** Shared flash layout, MCUboot inspection and write constraints. No bundled firmware. */
class FirmwareImage {
    static LIFECYCLE_KEY = 'toniebox/lifecycle_state';
    static PRODUCTION = 0x01;
    static SIZE = 0x1000000;
    static PRIMARY = 0x20000;
    static SECONDARY = 0x420000;
    static LFS = 0x820000;
    static SLOT_SIZE = 0x400000;
    static SECTOR_SIZE = 0x1000;
    static PROTECTED = Object.freeze([0x7DE000, 0x7DF000]);
    static TRAILER_MAGIC = '77c295f360d2ef7f3552500f2cb67980';
    static TRAILER_SIZE = 32;
    static XIP_BASE = 0x60000000;
    static UI_REFRESH_MS = 500;

    /** @param {Uint8Array} bytes @returns {Promise<string>} */
    static async hash(bytes) {
        return this.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    }
    static hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
    static offset(value) { return `0x${value.toString(16).toUpperCase().padStart(6, '0')}`; }
    static erased(bytes) { return bytes.every(b => b === 0xFF); }
    static equal(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
    static overlap(a, b) { return a[0] < b[1] && b[0] < a[1]; }

    /** Build a complete sector overlay against the original image, retaining all candidate edits. */
    static stage(image, candidate) {
        if (!(candidate instanceof Uint8Array) || candidate.length !== image?.size ||
            !image._isRangeCovered(0, image.size, image.readBuffer)) {
            throw new Error('A complete candidate and original image are required.');
        }
        image.assertMutable?.();
        const changes = [];
        for (let address = 0; address < candidate.length; address += this.SECTOR_SIZE) {
            const end = Math.min(address + this.SECTOR_SIZE, candidate.length);
            const desired = candidate.subarray(address, end);
            if (!this.equal(desired, image._materializeReadRange(address, end))) {
                changes.push({address, data: desired.slice()});
            }
        }
        return changes;
    }

    /** Keep the established primary-slot policy, using slot 1 when it is the only firmware. */
    static settingsVersion(image) {
        const start = this.hasSlotHeader(image, this.PRIMARY) ? this.PRIMARY :
            this.isSingleSlotLayout(image) ? this.SECONDARY : null;
        if (start === null) throw new Error('Firmware header not recognized.');
        const header = image.subarray(start, start + 32);
        return [header[20], header[21], new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(22, true)];
    }

    /** Identify a populated MCUboot slot without assuming its protected neighbor is erased. */
    static hasSlotHeader(image, start) {
        const header = image.subarray(start, start + 32);
        if (header.length !== 32) return false;
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const headerSize = view.getUint16(8, true);
        const payloadSize = view.getUint32(12, true);
        return view.getUint32(0, true) === 0x96F3B83D && headerSize === 0x400 &&
            payloadSize >= 8 && headerSize + payloadSize + 4 <= this.SLOT_SIZE - this.TRAILER_SIZE;
    }

    /** A missing slot has no firmware header or trailer; other bytes may be protected data. */
    static isSingleSlotLayout(image) {
        if (!image || (image.size ?? image.length) !== this.SIZE || typeof image.subarray !== 'function') return false;
        const primary = this.hasSlotHeader(image, this.PRIMARY);
        const secondary = this.hasSlotHeader(image, this.SECONDARY);
        if (primary === secondary) return false;
        const missing = primary ? this.SECONDARY : this.PRIMARY;
        return this.erased(image.subarray(missing, missing + 32)) &&
            this.erased(image.subarray(missing + this.SLOT_SIZE - this.TRAILER_SIZE,
                missing + this.SLOT_SIZE));
    }

    /** Conservatively recognize custom layouts after import, independently of filenames. */
    static requiresFullImage(image) {
        if (!image) return false;
        if (image.fullImageRequired || this.isSingleSlotLayout(image)) return true;
        const length = image.size ?? image.length;
        if (length !== this.SIZE || typeof image.subarray !== 'function') return false;
        const header = image.subarray(this.PRIMARY, this.PRIMARY + 32);
        const secondary = image.subarray(this.SECONDARY, this.SECONDARY + 32);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const diagnostic = view.getUint32(0, true) === 0x96F3B83D && header[20] === 0 &&
            header[21] === 40 && view.getUint16(22, true) === 8;
        // This may also restrict an ordinary dual-firmware dump: a full write is the safe choice.
        const secondaryView = new DataView(secondary.buffer, secondary.byteOffset, secondary.byteLength);
        const slotOneBase = secondaryView.getUint32(0, true) === 0x96F3B83D && secondary[20] === 1 &&
            secondary[21] === 0 && secondaryView.getUint16(22, true) === 22;
        return (diagnostic && !this.erased(secondary)) || (slotOneBase && !this.erased(header));
    }
    static assertPartialWrite(image, verifiedSingleSlot = false) {
        if (this.requiresFullImage(image) && !(verifiedSingleSlot && this.isSingleSlotLayout(image))) {
            throw new Error('Full-image flash required. Use Write fulldump or Flash Full Image.');
        }
    }

    /** Restrict admission to a loaded backup or a completed two-read capture. */
    static backupReason(state) {
        const bytes = state.flipTdiOriginalBackup, info = state.flipTdiOriginalBackupInfo;
        if (!(bytes instanceof Uint8Array) || bytes.length !== this.SIZE || !/^[a-f0-9]{64}$/i.test(info?.sha256 || '')) {
            return 'Load an original backup or create and verify one before writing to the device.';
        }
        if (info.source === 'loaded-verified-backup') return '';
        if (info.source === 'two-matching-device-reads' && info.verifiedAt) return '';
        return 'The captured backup has not passed verification.';
    }

    /** Verify bytes once per write attempt; retain a cheap guard across asynchronous prechecks. */
    static async verifyBackup(state) {
        const reason = this.backupReason(state);
        if (reason) throw new Error(reason);
        const backup = state.flipTdiOriginalBackup, info = state.flipTdiOriginalBackupInfo;
        const hash = info.sha256, source = info.source, verifiedAt = info.verifiedAt;
        const snapshot = backup.slice();
        const assertCurrent = (checkBytes = false) => {
            if (backup !== state.flipTdiOriginalBackup || info !== state.flipTdiOriginalBackupInfo ||
                hash !== info.sha256 || source !== info.source || verifiedAt !== info.verifiedAt ||
                this.backupReason(state) || (checkBytes && !this.equal(backup, snapshot))) {
                throw new Error('The original backup changed. No further device writes are allowed.');
            }
        };
        // A supplied digest describes the backup file, not the identity of the connected device.
        if (await this.hash(snapshot) !== hash.toLowerCase()) {
            throw new Error('The original backup checksum does not match. Load the original backup again.');
        }
        assertCurrent(true);
        return assertCurrent;
    }

    /** Validate one bounded MCUboot container. Offsets in the returned descriptor are flash offsets.
     * @param {Uint8Array} bytes Container bytes, optionally followed by unused slot space.
     * @param {number|null} slotStart Required XIP slot, or null to detect an OTA's intended slot.
     */
    static async inspectContainer(bytes, slotStart = null) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > this.SLOT_SIZE - this.TRAILER_SIZE) {
            throw new Error('Firmware container has an invalid size.');
        }
        const start = 0, trailerStart = bytes.length;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(start, true) !== 0x96F3B83D) throw new Error(`Unknown slot header at ${this.offset(start)}.`);
        const headerSize = view.getUint16(start + 8, true);
        const protectedSize = view.getUint16(start + 10, true);
        const payloadSize = view.getUint32(start + 12, true);
        const payloadEnd = start + headerSize + payloadSize;
        if (headerSize !== 0x400 || payloadSize < 8 || payloadEnd + 4 > trailerStart || view.getUint32(start + 16, true) !== 0) {
            throw new Error(`Unsupported slot layout at ${this.offset(start)}.`);
        }
        let cursor = payloadEnd;
        const parseTlv = (magic, expectedSize = null) => {
            if (cursor + 4 > trailerStart || view.getUint16(cursor, true) !== magic) throw new Error(`Invalid TLV at ${this.offset(cursor)}.`);
            const length = view.getUint16(cursor + 2, true), end = cursor + length;
            if (length < 4 || end > trailerStart || (expectedSize !== null && length !== expectedSize)) throw new Error('TLV exceeds its declared bounds.');
            cursor += 4;
            const entries = [];
            while (cursor < end) {
                if (cursor + 4 > end) throw new Error('Truncated TLV entry.');
                const type = view.getUint16(cursor, true), size = view.getUint16(cursor + 2, true);
                cursor += 4;
                if (cursor + size > end) throw new Error('Truncated TLV value.');
                entries.push({ type, bytes: bytes.subarray(cursor, cursor + size) });
                cursor += size;
            }
            return entries;
        };
        if (protectedSize) parseTlv(0x6908, protectedSize);
        const signedEnd = cursor, entries = parseTlv(0x6907);
        const hashes = entries.filter(entry => entry.type === 0x10);
        if (hashes.length !== 1 || hashes[0].bytes.length !== 32 ||
            this.hex(hashes[0].bytes) !== await this.hash(bytes.subarray(start, signedEnd))) {
            throw new Error(`Signed-region SHA-256 mismatch at ${this.offset(start)}.`);
        }
        if (!entries.some(e => e.type === 0x23 && e.bytes.length === 384) ||
            !entries.some(e => e.type === 0x01 && e.bytes.length === 32)) throw new Error('Unsupported signature/key-hash TLVs.');
        const resetPc = view.getUint32(start + headerSize + 4, true);
        const resetAddress = resetPc & ~1;
        const detectedSlot = [this.PRIMARY, this.SECONDARY].find(candidate =>
            resetAddress >= this.XIP_BASE + candidate && resetAddress < this.XIP_BASE + candidate + this.SLOT_SIZE);
        if (detectedSlot === undefined || (slotStart !== null && slotStart !== detectedSlot)) {
            throw new Error('Firmware slot cannot be determined or does not match its XIP address.');
        }
        slotStart = detectedSlot;
        if (!(resetPc & 1) || resetPc < this.XIP_BASE + slotStart + headerSize || resetPc >= this.XIP_BASE + slotStart + headerSize + payloadSize) {
            throw new Error(`Reset vector is outside its XIP slot at ${this.offset(start)}.`);
        }
        return { start: slotStart, end: slotStart + cursor, length: cursor, occupied: true, headerSize, payloadSize, resetPc,
            version: `${bytes[start + 20]}.${bytes[start + 21]}.${view.getUint16(start + 22, true)}+${view.getUint32(start + 24, true)}` };
    }

    /** A raw OTA must end exactly after its TLVs; no slot padding or trailer is accepted. */
    static async inspectOta(bytes) {
        const result = await this.inspectContainer(bytes);
        if (result.length !== bytes.length) throw new Error('OTA contains unexpected data after its firmware container.');
        return result;
    }

    /** Installed slots additionally validate their physical end area, including empty slots. */
    static async inspectSlot(bytes, start) {
        const limit = start + this.SLOT_SIZE, trailerStart = limit - this.TRAILER_SIZE;
        if (!(bytes instanceof Uint8Array) || ![this.PRIMARY, this.SECONDARY].includes(start) || bytes.length < limit) {
            throw new Error('Complete firmware slot required.');
        }
        const result = this.erased(bytes.subarray(start, start + 32))
            ? {start, end: start, version: 'Empty header', occupied: false}
            : await this.inspectContainer(bytes.subarray(start, trailerStart), start);
        const trailer = bytes.subarray(trailerStart, limit);
        if (!this.erased(trailer) && (this.hex(trailer.subarray(16)) !== this.TRAILER_MAGIC ||
            ![1, 0xFF].includes(trailer[0]) || ![1, 0xFF].includes(trailer[8]) ||
            !this.erased(trailer.subarray(1, 8)) || !this.erased(trailer.subarray(9, 16)))) {
            throw new Error(`Unknown trailer at ${this.offset(trailerStart)}.`);
        }
        return result;
    }

    /** Read all logical files without logging paths, identities or credential contents. */
    static async fileTree(bytes, offset, size) {
        const image = SparseImage.fromBuffer(bytes);
        image.readOnly = true;
        const parser = new LittleFSParser(image, offset, size);
        await parser.initialize();
        const entries = [];
        // Use raw entry types: the presentation adapter labels the superblock as a file.
        const REGULAR_FILE = 0x001, DIRECTORY = 0x002, SUPERBLOCK = 0x0FF;
        for (const file of await parser.fs.listAll()) {
            if (file.type === SUPERBLOCK) continue;
            if (![REGULAR_FILE,DIRECTORY].includes(file.type)) throw new Error('Unsupported filesystem entry type.');
            entries.push([file.path, file.type === DIRECTORY, file.type === DIRECTORY ? null : await this.hash(await parser.readFile(file.path))]);
        }
        if (offset === this.LFS && (!entries.some(e=>e[0]==='/settings') ||
            !['/cert/client.der.crypt','/cert/private.der.crypt','/cert/ca.der.crypt'].every(path=>entries.some(e=>e[0]===path)))) {
            throw new Error('Target settings/certificate filesystem is incomplete.');
        }
        return JSON.stringify(entries.sort((a,b)=>a[0].localeCompare(b[0])));
    }

}
