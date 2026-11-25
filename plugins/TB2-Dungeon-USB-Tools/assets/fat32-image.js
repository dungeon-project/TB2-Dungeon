/** Read-only FAT32 adapter for the content browser; no operating-system mount or writes.
 * Geometry, cluster chains and VFAT names follow the Microsoft FAT specification.
 * Reads use Blob slices, including offsets above 4 GiB; the whole image is never buffered.
 */
class Tb2Fat32Image {
    static SECTOR_BYTES = 512;
    static FAT_PAGE_BYTES = 64 * 1024;
    static FAT_CACHE_PAGES = 64;
    static MAX_DIRECTORY_ENTRIES = 100000;
    static YIELD_CLUSTERS = 256;

    constructor(file) { this.file = file; this.fatPages = new Map(); }

    /** Reject truncated reads instead of treating missing sectors as zero-filled data. */
    async read(offset, length, signal) {
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.file.size) {
            throw new Error('SD image contains an out-of-range filesystem address.');
        }
        const bytes = await this.file.slice(offset, offset + length).arrayBuffer();
        signal?.throwIfAborted();
        if (bytes.byteLength !== length) throw new Error('SD image is truncated or unavailable.');
        return new DataView(bytes);
    }

    /** Accept a raw volume or one primary FAT32 MBR partition; never guess among partitions. */
    static async open(file, signal) {
        const volume = new this(file);
        let boot = await volume.read(0, this.SECTOR_BYTES, signal), offset = 0, available = file.size;
        if (boot.getUint16(510, true) !== 0xaa55) throw new Error('Not a supported FAT32 SD image.');
        const rawVolume = [512, 1024, 2048, 4096].includes(boot.getUint16(11, true)) &&
            [0xeb, 0xe9].includes(boot.getUint8(0));
        if (!rawVolume) {
            const partitions = [];
            for (let index = 0; index < 4; index++) {
                const entry = 446 + index * 16;
                if ([0x0b, 0x0c, 0x1b, 0x1c].includes(boot.getUint8(entry + 4))) {
                    partitions.push({ offset: boot.getUint32(entry + 8, true) * this.SECTOR_BYTES,
                        length: boot.getUint32(entry + 12, true) * this.SECTOR_BYTES });
                }
            }
            if (partitions.length !== 1) throw new Error('Select an image with one primary FAT32 partition or a raw FAT32 volume.');
            offset = partitions[0].offset; available = partitions[0].length;
            if (offset < this.SECTOR_BYTES || available < this.SECTOR_BYTES || offset + available > file.size) {
                throw new Error('SD image has an invalid or truncated partition.');
            }
            boot = await volume.read(offset, this.SECTOR_BYTES, signal);
        }
        volume.configure(boot, offset, available);
        return volume.directory(volume.rootCluster, [], signal);
    }

    /** Validate all geometry before any FAT or directory lookup is allowed. */
    configure(boot, offset, available) {
        const sectorBytes = boot.getUint16(11, true), clusterSectors = boot.getUint8(13);
        const reservedSectors = boot.getUint16(14, true), fatCount = boot.getUint8(16);
        const totalSectors = boot.getUint32(32, true), fatSectors = boot.getUint32(36, true);
        const flags = boot.getUint16(40, true), activeFat = flags & 0x80 ? flags & 0x0f : 0;
        const dataSector = reservedSectors + fatCount * fatSectors;
        const clusterCount = Math.floor((totalSectors - dataSector) / clusterSectors);
        if (boot.getUint16(510, true) !== 0xaa55 || ![512, 1024, 2048, 4096].includes(sectorBytes) ||
            !clusterSectors || clusterSectors > 128 || (clusterSectors & (clusterSectors - 1)) ||
            !reservedSectors || ![1, 2].includes(fatCount) || activeFat >= fatCount ||
            boot.getUint16(17, true) || boot.getUint16(19, true) || boot.getUint16(22, true) || boot.getUint16(42, true) ||
            !fatSectors || clusterCount < 65525 || clusterCount > 0x0ffffff4 ||
            (clusterCount + 2) * 4 > fatSectors * sectorBytes) {
            throw new Error('Unsupported or invalid FAT32 filesystem geometry.');
        }
        // A larger original card is fine only when its declared volume fits this image.
        if (totalSectors * sectorBytes > available) {
            throw new Error('SD image is truncated: the declared FAT32 volume extends beyond the file.');
        }
        this.clusterBytes = sectorBytes * clusterSectors; this.maxCluster = clusterCount + 1;
        this.dataOffset = offset + dataSector * sectorBytes;
        this.fatOffset = offset + (reservedSectors + activeFat * fatSectors) * sectorBytes;
        this.fatBytes = fatSectors * sectorBytes; this.rootCluster = boot.getUint32(44, true);
        this.checkCluster(this.rootCluster);
    }

    checkCluster(cluster) {
        if (!Number.isInteger(cluster) || cluster < 2 || cluster > this.maxCluster) {
            throw new Error('SD image contains an invalid FAT32 cluster chain.');
        }
    }
    clusterOffset(cluster) { this.checkCluster(cluster); return this.dataOffset + (cluster - 2) * this.clusterBytes; }

    /** Keep a bounded cache of FAT pages; audio payloads are never cached here. */
    async nextCluster(cluster, signal) {
        this.checkCluster(cluster); signal?.throwIfAborted();
        const byteOffset = cluster * 4, pageOffset = Math.floor(byteOffset / Tb2Fat32Image.FAT_PAGE_BYTES) * Tb2Fat32Image.FAT_PAGE_BYTES;
        let page = this.fatPages.get(pageOffset);
        if (!page) {
            page = await this.read(this.fatOffset + pageOffset, Math.min(Tb2Fat32Image.FAT_PAGE_BYTES, this.fatBytes - pageOffset), signal);
            if (this.fatPages.size >= Tb2Fat32Image.FAT_CACHE_PAGES) this.fatPages.delete(this.fatPages.keys().next().value);
            this.fatPages.set(pageOffset, page);
        }
        const next = page.getUint32(byteOffset - pageOffset, true) & 0x0fffffff;
        if (next >= 0x0ffffff8) return null;
        this.checkCluster(next);
        return next;
    }

    /** Bound traversal, detect cycles and yield during long fragmented-file lookups. */
    async *chain(first, signal) {
        const visited = new Set(); let cluster = first;
        while (cluster !== null) {
            signal?.throwIfAborted(); this.checkCluster(cluster);
            if (visited.has(cluster)) throw new Error('SD image contains a cyclic FAT32 cluster chain.');
            visited.add(cluster); yield cluster;
            if (visited.size % Tb2Fat32Image.YIELD_CLUSTERS === 0) {
                await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
            }
            cluster = await this.nextCluster(cluster, signal);
        }
    }

    /** Build a Blob from original file extents, retaining lazy file-backed storage. */
    async fileBlob(first, size, start = 0, end = size, signal) {
        start = Math.max(0, Math.min(size, start)); end = Math.max(start, Math.min(size, end));
        if (start === end) return new Blob([]);
        const parts = []; let position = 0, extentStart = null, extentEnd = null;
        const flush = () => { if (extentStart !== null) parts.push(this.file.slice(extentStart, extentEnd)); };
        for await (const cluster of this.chain(first, signal)) {
            const length = Math.min(this.clusterBytes, size - position);
            if (length <= 0) throw new Error('SD image file chain exceeds its declared size.');
            const from = Math.max(start, position), to = Math.min(end, position + length);
            if (to > from) {
                const offset = this.clusterOffset(cluster) + from - position;
                if (extentEnd !== offset) { flush(); extentStart = offset; }
                extentEnd = offset + to - from;
            }
            position += length;
            if (position >= end) {
                if (end === size && await this.nextCluster(cluster, signal) !== null) {
                    throw new Error('SD image file chain exceeds its declared size.');
                }
                flush(); return new Blob(parts);
            }
        }
        throw new Error('SD image contains a truncated file chain.');
    }

    /** A scan needs file metadata only. Materialize extents only for JSON, playback or export. */
    fileHandle(cluster, size, signal) {
        const volume = this;
        return { kind: 'file', async getFile() {
            return { size, lastModified: volume.file.lastModified || 0,
                slice(start = 0, end = size) { return { async arrayBuffer() {
                    return (await volume.fileBlob(cluster, size, start, end, signal)).arrayBuffer();
                } }; },
                async text() { return (await volume.fileBlob(cluster, size, 0, size, signal)).text(); },
                async asBlob() { return volume.fileBlob(cluster, size, 0, size, signal); }
            };
        } };
    }

    /** VFAT names are accepted only when their order and short-name checksum agree. */
    static checksum(bytes) {
        let sum = 0;
        for (const byte of bytes) sum = (((sum & 1) ? 128 : 0) + (sum >> 1) + byte) & 255;
        return sum;
    }
    static entryName(entry, longName) {
        const bytes = new Uint8Array(entry.buffer, entry.byteOffset, 11);
        if (longName) {
            if (longName.next !== 0 || longName.checksum !== this.checksum(bytes)) throw new Error('SD image contains an invalid long filename.');
            const units = longName.parts.flat(), terminator = units.indexOf(0);
            const name = String.fromCharCode(...(terminator < 0 ? units : units.slice(0, terminator)));
            if (!name || name.length > 255 || /[\x00-\x1f/\\\uffff]/.test(name)) throw new Error('SD image contains an invalid filename.');
            return name;
        }
        if (bytes.some(byte => byte > 127)) throw new Error('SD image uses an unsupported short-filename encoding.');
        const base = String.fromCharCode(...bytes.slice(0, 8)).trimEnd(), extension = String.fromCharCode(...bytes.slice(8)).trimEnd();
        const flags = entry.getUint8(12);
        return (flags & 8 ? base.toLowerCase() : base) + (extension ? '.' + (flags & 16 ? extension.toLowerCase() : extension) : '');
    }

    /** Directory adapters expose only the read methods used by the existing collection scanner. */
    directory(cluster, ancestors, signal) {
        if (ancestors.includes(cluster)) throw new Error('SD image contains a cyclic directory tree.');
        const volume = this, lineage = [...ancestors, cluster];
        return { kind: 'directory', queryPermission: async () => 'granted',
            forScan(scanSignal) { return volume.directory(cluster, ancestors, scanSignal); },
            entries() { return volume.entries(cluster, lineage, signal); },
            async getDirectoryHandle(name) {
                for await (const [entryName, handle] of this.entries()) {
                    if (entryName.toLowerCase() === name.toLowerCase() && handle.kind === 'directory') return handle;
                }
                throw new Error('SD image is missing the required content folders.');
            }
        };
    }

    /** Decode directory records sequentially, including long names spanning cluster boundaries. */
    async *entries(first, lineage, signal) {
        let longName = null, count = 0; const names = new Set();
        for await (const cluster of this.chain(first, signal)) {
            const data = await this.read(this.clusterOffset(cluster), this.clusterBytes, signal);
            for (let offset = 0; offset < data.byteLength; offset += 32) {
                signal?.throwIfAborted();
                if (++count > Tb2Fat32Image.MAX_DIRECTORY_ENTRIES) throw new Error('SD image directory exceeds the supported entry limit.');
                const entry = new DataView(data.buffer, offset, 32), marker = entry.getUint8(0), attributes = entry.getUint8(11);
                if (marker === 0) return;
                if (marker === 0xe5) { longName = null; continue; }
                if (attributes === 0x0f) {
                    const sequence = marker & 0x1f;
                    if (marker & 0x40) longName = { next: sequence, checksum: entry.getUint8(13), parts: [] };
                    if (!longName || !sequence || sequence > 20 || longName.next !== sequence ||
                        longName.checksum !== entry.getUint8(13) || entry.getUint8(12) || entry.getUint16(26, true)) {
                        throw new Error('SD image contains an invalid long-filename sequence.');
                    }
                    longName.parts[sequence - 1] = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30].map(at => entry.getUint16(at, true));
                    longName.next--; continue;
                }
                if (attributes & 8) { longName = null; continue; }
                const name = Tb2Fat32Image.entryName(entry, longName); longName = null;
                if (name === '.' || name === '..') continue;
                if (names.has(name.toLowerCase())) throw new Error('SD image contains duplicate directory names.');
                names.add(name.toLowerCase());
                const start = entry.getUint16(20, true) * 65536 + entry.getUint16(26, true), size = entry.getUint32(28, true);
                if (attributes & 16 || size) this.checkCluster(start);
                yield [name, attributes & 16 ? this.directory(start, lineage, signal) : this.fileHandle(start, size, signal)];
            }
        }
    }
}

if (typeof module !== 'undefined') module.exports = { Tb2Fat32Image };
