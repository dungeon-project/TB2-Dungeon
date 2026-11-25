/* Shared binary lifecycle settings used by Settings and the update builder. */
'use strict';
/** Lifecycle edits belong to the generated full image, never to an OTA container. */
class UpdateImageLifecycle {
    static MODES = Object.freeze({1: 'PRODUCTION — service/manufacturing', 2: 'LOGISTIC — delivery state', 4: 'ENDUSER — normal operation'});

    /** Validate the whole record stream before exposing its last effective binary value. */
    static inspect(bytes) {
        let offset = 0, valueOffset = -1;
        const decoder = new TextDecoder('utf-8', {fatal: true});
        while (offset < bytes.length) {
            if (offset + 2 > bytes.length) throw new Error('Truncated settings header.');
            const start = offset + 2, end = start + (bytes[offset] | bytes[offset + 1] << 8);
            if (end > bytes.length) throw new Error('Truncated settings record.');
            const separator = bytes.indexOf(0x3d, start);
            if (separator <= start || separator >= end) throw new Error('Invalid settings record.');
            // Historical values remain untouched; a malformed record anywhere fails closed.
            if (decoder.decode(bytes.subarray(start, separator)) === FirmwareImage.LIFECYCLE_KEY) {
                if (end - separator - 1 !== 1) throw new Error('Lifecycle setting must contain exactly one byte.');
                valueOffset = separator + 1;
            }
            offset = end;
        }
        if (valueOffset < 0) throw new Error('Lifecycle setting missing. No lifecycle change can be made.');
        return {value: bytes[valueOffset], valueOffset};
    }

    static label(value) {
        if (!Number.isInteger(value)) return 'Unknown';
        return `${this.MODES[value] || 'Unknown'} (${value.toString(16).padStart(2, '0').toUpperCase()})`;
    }

    /** Null explicitly preserves the source value, including an unrecognized single byte. */
    static patch(bytes, selected = null) {
        const current = this.inspect(bytes);
        if (selected !== null && !Object.hasOwn(this.MODES, selected)) throw new Error('Invalid lifecycle selection.');
        const result = bytes.slice();
        result[current.valueOffset] = selected === null ? current.value : selected;
        return result;
    }

    /** Use the checked LittleFS writer on a private overlay and independently reopen it. */
    static async apply(bytes, selected = null) {
        const image = SparseImage.fromBuffer(bytes.slice());
        const parser = await WifiImage.parser(image);
        const originalSettings = await parser.readFile('/settings');
        const original = this.inspect(originalSettings).value;
        const desired = this.patch(originalSettings, selected);
        const beforeTree = await FirmwareImage.fileTree(bytes, FirmwareImage.LFS, FirmwareImage.SIZE - FirmwareImage.LFS);
        if (!FirmwareImage.equal(originalSettings, desired)) {
            const write = await parser.writeFileChecked('/settings', desired, originalSettings);
            if (!write?.success) throw new Error('Could not stage lifecycle settings.');
        }
        // Readback verifies exact history and unrelated settings, not just the selected byte.
        const candidate = image.subarray(0, image.size).slice();
        const verifier = await WifiImage.parser(SparseImage.fromBuffer(candidate));
        const readback = await verifier.readFile('/settings');
        const verified = this.inspect(readback).value;
        if (!FirmwareImage.equal(readback, desired) || verified !== (selected ?? original)) {
            throw new Error('Lifecycle settings readback failed.');
        }
        const afterTree = await FirmwareImage.fileTree(candidate, FirmwareImage.LFS, FirmwareImage.SIZE - FirmwareImage.LFS);
        const otherFiles = tree => JSON.stringify(JSON.parse(tree).filter(entry => entry[0] !== '/settings'));
        if (otherFiles(beforeTree) !== otherFiles(afterTree) ||
            !FirmwareImage.equal(bytes.subarray(0, FirmwareImage.LFS), candidate.subarray(0, FirmwareImage.LFS))) {
            throw new Error('Lifecycle change affected unrelated image data.');
        }
        return {bytes: candidate, lifecycle: {original, selected: selected ?? original, verified}};
    }
}
