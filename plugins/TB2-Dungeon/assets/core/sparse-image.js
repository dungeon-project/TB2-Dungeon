
/**
 * @file Toniebox 2 flash-image editor: source-preserving readability refactor.
 *
 * Data flow:
 * Disk/Node source -> SparseImage -> LittleFSParser -> LittleFS -> directory/file bytes.
 * SettingsEditorTile translates records to UI values; ReplaceFileTile handles .crypt blobs.
 * CrackerPaneTile retains its original WebGPU candidate search and CPU verification.
 * TileManager evaluates text/tile-class scripts only after the supporting scripts have run.
 *
 * Compatibility boundaries:
 * - Public names, parameter defaults, DOM identifiers, storage keys, and binary layouts stay
 * intact.
 * - Subarray methods copy data; pending writes overlay reads; flush is not filesystem compaction.
 * - LittleFS mutations use validated private snapshots and atomic in-memory publication.
 * - Existing Node helpers and the external SparseImageDataView dependency are retained.
 *
 * Original filesystem references: littlefs SPEC.md (format), lfs.c (replay and CTZ traversal).
 */

/** @typedef {Uint8Array|ArrayBuffer|ArrayLike<number>} BinaryInput */
/** @typedef {{address: number, data: Uint8Array}} ByteSegment */
/** @typedef {{start: number, size: number}} ByteRange */
/** @typedef {[number, number]} BlockPair */
/** @typedef {string|{path: string}} FileReference */
/** @typedef {'u8'|'u16le'|'u32le'|'ascii'|'utf8'|'cstring'|'booltf'|'hex'} SettingsType */
/**
 * @typedef {Object} SettingsRecord
 * @property {number} index Original record position; duplicate keys remain separate records.
 * @property {number} offset Byte offset of the two-byte header.
 * @property {number} len Payload length excluding the header.
 * @property {string} key Decoded key without its '=' separator.
 * @property {Uint8Array} valueBytes Uninterpreted stored value.
 */
/** @typedef {{type: SettingsType, value: string}} SettingsEdit */
/** @typedef {{padding: number, iv: Uint8Array, ciphertext: Uint8Array}} CryptBlob */
/** @typedef {{name: string, bytes: Uint8Array, parsed: CryptBlob}} BlobSource */
/** @typedef {Array<string|null>} UuidNibbles */
/** @typedef {{nibbles: UuidNibbles, unknownPositions: number[]}} ParsedMask */
/** @typedef {{f0: number, f1: number, xMask: number}} GpuMask */
/** @typedef {'legacy-v1'|'optimized-v1'|'optimized-v2'|'optimized-v3'} SearchAlgorithm */
/** @typedef {{algorithm: SearchAlgorithm|'auto', batchSize: number|'auto', workgroupSize: number|'auto'}} SearchSettings */
/** @typedef {{algorithm: SearchAlgorithm, batchSize: number, workgroupSize: number, rate: number, provisional: boolean, complete: boolean, stable: boolean, evidenceRevision: number, policyRevision: string, measuredPairs: number, eligiblePairs: number, maxBatchTested: number}} SearchTuningProfile */
/** @typedef {{algorithm: SearchAlgorithm, kernel: string, batchSize: number, workgroupSize: number, candidatesTested: number, activeMs: number, setupMs: number}} SearchVariant */
/** @typedef {{startedAt: string, candidatesTested: number, activeMs: number, setupMs: number, cpuCandidates: number, rejectedCandidates: number, resumes: number, variants: SearchVariant[]}} SearchTelemetry */
/**
 * @typedef {Object} SearchConfig
 * @property {UuidNibbles} nibbles
 * @property {number[]} unknownPositions
 * @property {number} numUnknown
 * @property {number} start
 * @property {number} end
 * @property {number|'auto'} batchSize
 * @property {number|'auto'} workgroupSize
 * @property {Uint8Array} salt
 * @property {Uint8Array} info
 */
/**
 * @typedef {Object} SearchCheckpoint
 * @property {2|3|4} schemaVersion Historical single-mask checkpoints remain readable; schema 4 stores staged coverage.
 * @property {2|3} searchOrderVersion Version 3 adds fixed-suffix remainder traversal.
 * @property {{version: number, startMask: string, stages: Array<{mask: string, covered: number, candidatesTested: number, activeMs: number, setupMs: number}>}} [plan]
 * @property {string[]} [verificationInputs] Ordered SHA-256 hashes of all GPU/CPU verification inputs.
 * @property {string} mask
 * @property {number} start
 * @property {number} endExclusive
 * @property {number} next
 * @property {SearchAlgorithm} algorithm Executed algorithm, never Auto.
 * @property {string} kernel
 * @property {number} batchSize
 * @property {number} [workgroupSize] Missing historical values mean 256.
 * @property {SearchSettings} [requested]
 * @property {SearchTelemetry} telemetry
 * @property {number[]} [batchChangingPositions]
 * @property {string} inputSha256
 * @property {number} inputBytes
 * @property {number} padding
 * @property {string} saltHex
 * @property {string} infoHex
 * @property {string} [savedAt]
 */
/**
 * @typedef {Object} GpuBlobInfo
 * @property {number[]} cbcPairWords Previous CBC block/IV followed by the final ciphertext block.
 * @property {number} padding
 * @property {Uint8Array} salt
 * @property {Uint8Array} info
 * @property {number} f0
 * @property {number} f1
 * @property {number} xMask
 * @property {number} unknownCount
 * @property {SearchAlgorithm} algorithm
 * @property {number} workgroupSize
 */
/**
 * @typedef {Uint8Array|ArrayBufferView|{address?: number, data: Uint8Array|ArrayBufferView}}
 * ReadResult
 */
/**
 * @callback ReadCallback
 * @param {number} address
 * @param {number} size
 * @returns {ReadResult|Promise<ReadResult>}
 */
/**
 * @callback WriteCallback
 * @param {number} address
 * @param {Uint8Array} data
 * @returns {void|Promise<void>}
 */
/**
 * @callback PrepareCallback
 * @param {SparseImage} image
 * @returns {void|Promise<void>}
 */
/** @typedef {{read: function(number, number): Promise<Uint8Array>}} ByteStorage */
/** @typedef {{blockSize?: number, blockCount?: number, fsOffset?: number}} LittleFsOptions */
/** @typedef {{tag: number, data?: Uint8Array}} MetadataTag */
/**
 * @typedef {Object} DirectoryEntry
 * @property {string|null} name
 * @property {number|null} type
 * @property {number|null} structType
 * @property {Uint8Array|null} inlineData
 * @property {number|null} ctzHead
 * @property {number|null} ctzSize
 * @property {BlockPair|null} dirPair
 */
/**
 * @typedef {Object} DirectoryReplay
 * @property {DirectoryEntry[]} entries
 * @property {BlockPair} tail
 * @property {boolean} split
 */
/**
 * @typedef {DirectoryReplay & {valid: boolean, rev: number, tags: MetadataTag[],
 * off: number, etag: number}} MetadataBlock
 */
/** @typedef {DirectoryReplay & {pair: BlockPair, rev: number, count: number}} DirectoryState */
/** @typedef {{id: number, entry: DirectoryEntry}} EntryMatch */
/**
 * @typedef {Object} ResolvedPath
 * @property {DirectoryState|null} parentDir
 * @property {DirectoryState} dir
 * @property {string} name
 * @property {DirectoryEntry|{type: number, dirPair: BlockPair, structType: number}} entry
 * @property {number} id
 */
/** @typedef {{index: number, off: number}} CtzIndex */
/** @typedef {{block: number, off: number}} BlockLocation */
/** @typedef {{name: string, type: number, size: number}} DirectoryItem */
/** @typedef {{path: string, type: number, size: number}} FlatEntry */
/**
 * @typedef {Object} Superblock
 * @property {number} version
 * @property {number} blockSize
 * @property {number} blockCount
 * @property {number} nameMax
 * @property {number} fileMax
 * @property {number} attrMax
 */
/** @typedef {{rootPair: BlockPair, superblock: Superblock|null}} MountResult */
/**
 * @callback EntryVisitor
 * @param {string} path
 * @param {DirectoryEntry} entry
 * @returns {void|Promise<void>}
 */
/**
 * @typedef {Object} ExtractionTarget
 * @property {function(string, string): string} join
 * @property {function(string): string} dirname
 * @property {function(string): Promise<void>} mkdirp
 * @property {function(string, Uint8Array): Promise<void>} writeFile
 */
/**
 * @typedef {Object} FileNode
 * @property {string} name
 * @property {string} path
 * @property {number} size
 * @property {boolean} isDirectory
 * @property {'dir'|'file'} type
 * @property {string[]} attributes
 * @property {string} date
 * @property {string} time
 * @property {FileNode[]} [children]
 */
/**
 * @typedef {Object} FilesystemInfo
 * @property {boolean} valid
 * @property {BlockPair} rootPair
 * @property {Superblock|null} superblock
 * @property {number} filesCount
 * @property {FileNode[]} files
 * @property {FileNode[]} flatFiles
 */
/** @typedef {{wiped: boolean, bytesWiped: number}} WipeResult */
/**
 * @typedef {Object} MutationResult
 * @property {boolean} success
 * @property {string} [path]
 * @property {string} [error]
 * @property {number} [bytesWritten]
 * @property {boolean} [persisted]
 * @property {boolean} [replacedViaMetadata]
 * @property {boolean} [deleted]
 * @property {boolean} [deletedViaMetadata]
 * @property {number|null} [oldStructType]
 * @property {boolean} [wipedOldCtz]
 * @property {number} [oldBytesWiped]
 */
/**
 * @typedef {Object} NodeImageReader
 * @property {number} size
 * @property {SparseImage} sparse
 * @property {boolean} writable
 * @property {function(number, number): Promise<Uint8Array>} read
 * @property {function(): Promise<void>} flush
 * @property {function(): Promise<void>} close
 */
/**
 * @typedef {Object} LittleFsExports
 * @property {typeof LittleFS} LittleFS
 * @property {typeof LittleFSParser} LittleFSParser
 * @property {typeof createNodeSparseImageReader} createNodeSparseImageReader
 */

// === Sparse image: source callbacks -> read cache / write overlay -> flush ===

class SparseImage {

    /**
     * Initialize a fixed-size sparse image with independent read and write segments.
     * @param {number} size
     * @param {ReadCallback|null} [readDataCallback=null]
     * @param {WriteCallback|null} [writeDataCallback=null]
     * @param {PrepareCallback|null} [flushPrepareCallback=null]
     * @param {number} [sectorSize=0x1000]
     */
    constructor(size, readDataCallback = null, writeDataCallback = null,
        flushPrepareCallback = null, sectorSize = 0x1000) {
        this.size = size;
        this.readDataCallback = readDataCallback;
        this.writeDataCallback = writeDataCallback;
        this.flushPrepareCallback = flushPrepareCallback;
        this.dataUpdatedCallback = null;
        this.sectorSize = sectorSize || 0x1000;
        this.readBuffer = [];
        this.writeBuffer = [];
        this.length = size;
        this._ensureDataLock = Promise.resolve();
        this._operationLease = null;
        this._pendingMutations = 0;

        // Backing-source metadata. Normal disk images remain writable by default.
        // Live FlipTDI images set readOnly=true explicitly.
        this.readOnly = false;
        this.sourceType = 'memory';
        this.completeSnapshot = false;
        this.verifiedSha256 = null;

        /**
         * Retain the assignable no-op diagnostic callback.
         * @param {unknown} msg
         * @returns {void}
         */
        this.logMessage = (msg) => { };

        /**
         * Retain the assignable no-op diagnostic callback.
         * @param {unknown} msg
         * @returns {void}
         */
        this.logDebug = (msg) => { };

        /**
         * Retain the assignable no-op diagnostic callback.
         * @param {unknown} msg
         * @returns {void}
         */
        this.logError = (msg) => { };
    }

    /**
     * Create an image whose initial read segment aliases the supplied byte buffer.
     * @param {ArrayBuffer|Uint8Array} arrayBuffer
     * @param {number} [sectorSize=0x1000]
     * @returns {SparseImage}
     */
    static fromBuffer(arrayBuffer, sectorSize = 0x1000) {
        const buffer = arrayBuffer instanceof Uint8Array
            ? arrayBuffer : new Uint8Array(arrayBuffer);
        const sparseImage = new SparseImage(buffer.length, null, null, null, sectorSize);
        sparseImage.readBuffer.push({
            address: 0,
            data: buffer
        });
        return sparseImage;
    }

    /** Coordinate asynchronous image edits and device operations without persisting authority. */
    get operationLease() { return this._operationLease; }
    get operationKind() { return this._operationLease?.kind || ''; }
    get pendingMutations() { return this._pendingMutations; }
    get operationBusy() { return !!this._operationLease || this._pendingMutations > 0; }
    ownsOperation(lease) { return !!lease && this._operationLease === lease; }

    /** An operation owns the image until its explicit release, including every awaited step. */
    acquireOperation(kind, validate = null) {
        if (!['edit', 'device'].includes(kind)) throw new Error('Unknown image operation.');
        if (this.operationBusy) throw new Error('Another image operation is running.');
        const lease = {
            kind,
            validate,
            assertCurrent: () => this.assertOperation(lease),
            release: () => { if (this.ownsOperation(lease)) this._operationLease = null; }
        };
        this._operationLease = lease;
        return lease;
    }

    assertOperation(lease) {
        if (!this.ownsOperation(lease)) throw new Error('The image operation is no longer current.');
        lease.validate?.();
    }

    /** Check local publication permission independently of disabled controls. */
    assertMutable() {
        if (this.readOnly) throw new Error('The working image is read-only.');
        if (this.operationKind === 'device') throw new Error('A device operation owns the working image.');
        if (this._operationLease) this.assertOperation(this._operationLease);
    }

    /** Count queued filesystem transactions immediately, before their first asynchronous step. */
    beginMutation() {
        this.assertMutable();
        const owner = this._operationLease;
        this._pendingMutations++;
        let active = true;
        return {
            assertCurrent: () => {
                if (!active || this._operationLease !== owner) throw new Error('The image mutation is no longer current.');
                this.assertMutable();
            },
            release: () => { if (active) { active = false; this._pendingMutations--; } }
        };
    }

    // === Cache coverage and segment merging ===

    /**
     * Return the first segment covering an address, or null.
     * @param {number} address
     * @param {ByteSegment[]} [list=this.readBuffer]
     * @returns {ByteSegment|null}
     */
    _findSegment(address, list = this.readBuffer) {
        for (const segment of list) {
            const endAddress = segment.address + segment.data.length;
            if (address >= segment.address && address < endAddress) {
                return segment;
            }
        }
        return null;
    }

    /**
     * Check continuous coverage of a range by the specified segment list.
     * @param {number} address
     * @param {number} size
     * @param {ByteSegment[]} [list=this.readBuffer]
     * @returns {boolean}
     */
    _isRangeCovered(address, size, list = this.readBuffer) {
        let checkPos = address;
        const endAddress = address + size;
        while (checkPos < endAddress) {
            const segment = this._findSegment(checkPos, list);
            if (!segment) {
                return false;
            }
            checkPos = segment.address + segment.data.length;
        }
        return true;
    }

    /**
     * Check range coverage with pending-write segments considered before read segments.
     * @param {number} address
     * @param {number} size
     * @returns {boolean}
     */
    _isRangeCoveredAny(address, size) {
        let checkPos = address;
        const endAddress = address + size;
        while (checkPos < endAddress) {
            const writeSegment = this._findSegment(checkPos, this.writeBuffer);
            if (writeSegment) {
                checkPos = Math.min(endAddress, writeSegment.address + writeSegment.data.length);
                continue;
            }
            const readSegment = this._findSegment(checkPos, this.readBuffer);
            if (readSegment) {
                checkPos = Math.min(endAddress, readSegment.address + readSegment.data.length);
                continue;
            }
            return false;
        }
        return true;
    }

    /**
     * Find the first range not covered by either write or read segments.
     * @param {number} address
     * @param {number} size
     * @returns {ByteRange|null}
     */
    _findFirstGapRange(address, size) {
        const endAddress = address + size;
        let position = address;
        while (position < endAddress) {
            const writeSegment = this._findSegment(position, this.writeBuffer);
            if (writeSegment) {
                position = Math.min(endAddress, writeSegment.address + writeSegment.data.length);
                continue;
            }
            const readSegment = this._findSegment(position, this.readBuffer);
            if (readSegment) {
                position = Math.min(endAddress, readSegment.address + readSegment.data.length);
                continue;
            }
            let nextStart = endAddress;
            for (const segment of this.writeBuffer) {
                if (segment.address > position && segment.address < nextStart) {
                    nextStart = segment.address;
                }
            }
            for (const segment of this.readBuffer) {
                if (segment.address > position && segment.address < nextStart) {
                    nextStart = segment.address;
                }
            }
            return { start: position, size: nextStart - position };
        }
        return null;
    }

    /**
     * Merge touching segments in address/index order, retaining the original overlap rules.
     * Zero or one input segment returns the same list object; larger inputs produce a new list.
     * @param {ByteSegment[]} list
     * @returns {ByteSegment[]}
     */
    _mergeSegmentsGeneric(list) {
        if (list.length <= 1) {
            return list;
        }
        const indexed = list.map((segment, idx) => ({ ...segment, _idx: idx }));
        indexed.sort((a, b) => {
            if (a.address === b.address) {
                return a._idx - b._idx;
            }
            return a.address - b.address;
        });
        const merged = [];
        let current = indexed[0];
        for (let i = 1; i < indexed.length; i++) {
            const next = indexed[i];
            const currentEnd = current.address + current.data.length;
            if (next.address <= currentEnd) {
                const mergedEnd = Math.max(currentEnd, next.address + next.data.length);
                const mergedSize = mergedEnd - current.address;
                const mergedData = new Uint8Array(mergedSize);
                mergedData.set(current.data, 0);
                const nextOffset = next.address - current.address;
                mergedData.set(next.data, nextOffset);
                current = {
                    address: current.address,
                    data: mergedData
                };
            }
            else {
                merged.push({ address: current.address, data: current.data });
                current = next;
            }
        }
        merged.push({ address: current.address, data: current.data });
        return merged;
    }

    /**
     * Merge the cached read segments.
     * @returns {void}
     */
    _mergeSegments() {
        this.readBuffer = this._mergeSegmentsGeneric(this.readBuffer);
    }

    /**
     * Merge the pending write segments.
     * @returns {void}
     */
    _mergeWriteSegments() {
        this.writeBuffer = this._mergeSegmentsGeneric(this.writeBuffer);
    }

    // === Read/write overlay materialization ===

    /**
     * Read a write-overlay or cached byte, using 0xFF for an uncovered address.
     * @param {number} pos
     * @returns {number}
     */
    _effectiveByte(pos) {
        const writeSegment = this._findSegment(pos, this.writeBuffer);
        if (writeSegment) {
            return writeSegment.data[pos - writeSegment.address] & 0xFF;
        }
        const readSegment = this._findSegment(pos, this.readBuffer);
        if (readSegment) {
            return readSegment.data[pos - readSegment.address] & 0xFF;
        }
        return 0xFF;
    }

    /**
     * Copy a range filled with 0xFF, overlaying read data first and pending writes second.
     * @param {number} start
     * @param {number} end
     * @returns {Uint8Array}
     */
    _materializeRange(start, end) {
        const length = end - start;
        const output = new Uint8Array(length);
        output.fill(0xFF);

        /**
         * Overlay intersecting segments in list order without changing source buffers.
         * @param {ByteSegment[]} segments
         * @returns {void}
         */
        const overlaySegments = (segments) => {
            for (const segment of segments) {
                const segmentStart = segment.address;
                const segmentEnd = segment.address + segment.data.length;
                const overlapStart = Math.max(start, segmentStart);
                const overlapEnd = Math.min(end, segmentEnd);
                if (overlapStart < overlapEnd) {
                    const destinationOffset = overlapStart - start;
                    const sourceOffset = overlapStart - segmentStart;
                    output.set(segment.data.subarray(sourceOffset, sourceOffset
                        + (overlapEnd - overlapStart)), destinationOffset);
                }
            }
        };
        overlaySegments(this.readBuffer);
        overlaySegments(this.writeBuffer);
        return output;
    }

    /**
     * Copy a range from only the read cache, using 0xFF for gaps.
     * @param {number} start
     * @param {number} end
     * @returns {Uint8Array}
     */
    _materializeReadRange(start, end) {
        const len = end - start;
        const out = new Uint8Array(len);
        out.fill(0xFF);
        for (const seg of this.readBuffer) {
            const s0 = seg.address;
            const s1 = seg.address + seg.data.length;
            const o0 = Math.max(start, s0);
            const o1 = Math.min(end, s1);
            if (o0 < o1) {
                const dstOff = o0 - start;
                const srcOff = o0 - s0;
                out.set(seg.data.subarray(srcOff, srcOff + (o1 - o0)), dstOff);
            }
        }
        return out;
    }

    /**
     * Append to the supplied list and return the result of the existing merge routine.
     * @param {ByteSegment[]} list
     * @param {number} address
     * @param {Uint8Array} data
     * @returns {ByteSegment[]}
     */
    _addSegment(list, address, data) {
        list.push({ address, data });
        return this._mergeSegmentsGeneric(list);
    }

    // === Serialized cache loading ===

    /**
     * Serialize cache population requests, including recovery after a rejected request.
     * @param {number} address
     * @param {number} size
     * @returns {Promise<void>}
     */
    async _ensureData(address, size) {

        /**
         * Populate the requested range after the preceding cache-load operation settles.
         * @returns {Promise<void>}
         */
        const run = () => this._ensureDataUnlocked(address, size);
        this._ensureDataLock = this._ensureDataLock.then(run, run);
        return this._ensureDataLock;
    }

    /**
     * Fill missing cache ranges with callback data, or zeros without a callback.
     * Retains the 64-iteration guard and the existing accepted callback result shapes.
     * @param {number} address
     * @param {number} size
     * @returns {Promise<void>}
     */
    async _ensureDataUnlocked(address, size) {
        if (address < 0 || address >= this.size) {
            throw new RangeError(`Address ${address} out of bounds [0, ${this.size})`);
        }
        size = Math.min(size, this.size - address);
        if (this._isRangeCoveredAny(address, size)) {
            return;
        }
        let attemptsRemaining = 64;
        while (!this._isRangeCoveredAny(address, size) && attemptsRemaining-- > 0) {
            const gap = this._findFirstGapRange(address, size);
            if (!gap || gap.size <= 0) {
                break;
            }
            if (!this.readDataCallback) {
                const data = new Uint8Array(gap.size);
                this.readBuffer = this._addSegment(this.readBuffer, gap.start, data);
                continue;
            }
            const readResult = await this.readDataCallback(gap.start, gap.size);
            let readAddress = null;
            let readBytes = null;
            if (readResult instanceof Uint8Array) {
                readAddress = gap.start;
                readBytes = readResult;
            }
            else if (readResult && readResult.buffer instanceof ArrayBuffer
                && readResult.byteLength !== undefined) {
                readAddress = gap.start;
                readBytes = new Uint8Array(readResult.buffer, readResult.byteOffset || 0,
                    readResult.byteLength);
            }
            else if (readResult && typeof readResult === 'object') {
                const resultAddress = readResult.address !== undefined
                    ? readResult.address : gap.start;
                const resultData = readResult.data;
                if (resultData instanceof Uint8Array) {
                    readAddress = resultAddress;
                    readBytes = resultData;
                }
                else if (resultData && resultData.buffer instanceof ArrayBuffer
                    && resultData.byteLength !== undefined) {
                    readAddress = resultAddress;
                    readBytes = new Uint8Array(resultData.buffer, resultData.byteOffset || 0,
                        resultData.byteLength);
                }
            }
            if (readBytes && readBytes.length > 0) {
                this.readBuffer = this._addSegment(this.readBuffer, readAddress, readBytes);
            }
            else {
                break;
            }
            this.dataUpdatedCallback && this.dataUpdatedCallback(readAddress, readBytes.length);
        }
    }

    // === Buffered mutations ===

    /**
     * Stage bytes in the write overlay, clamping to image bounds and pruning unchanged sectors.
     * @param {number} address
     * @param {BinaryInput} data
     * @returns {void}
     */
    write(address, data) {
        if (this.readOnly) {
            throw new Error('SPARSE_IMAGE_READ_ONLY: this backing source does not allow mutations.');
        }
        this.assertMutable();
        if (address < 0 || address >= this.size) {
            throw new RangeError(`Address ${address} out of bounds [0, ${this.size})`);
        }
        const normalized = data instanceof Uint8Array ? data : new Uint8Array(data);
        const start = address;
        const end = Math.min(address + normalized.length, this.size);
        if (end <= start) {
            return;
        }
        const sectorSize = this.sectorSize || 0x1000;
        const touchedSectors = new Set();

        /**
         * Find a pending write segment covering this byte position.
         * @param {number} pos
         * @returns {ByteSegment|null}
         */
        const findWriteSeg = (pos) => this._findSegment(pos, this.writeBuffer);

        /**
         * Find a write segment first, otherwise a cached read segment.
         * @param {number} pos
         * @returns {ByteSegment|null}
         */
        const findCachedSeg = (pos) => findWriteSeg(pos) || this._findSegment(pos, this.readBuffer);

        /**
         * Coalesce the current pending write segments using the existing overlap rules.
         * @returns {void}
         */
        const mergeWrites = () => {
            this.writeBuffer = this._mergeSegmentsGeneric(this.writeBuffer);
        };

        /**
         * Record each sector touched by the half-open byte range.
         * @param {number} rangeStart
         * @param {number} rangeEnd
         * @returns {void}
         */
        const markSectors = (rangeStart, rangeEnd) => {
            for (let s = Math.floor(rangeStart / sectorSize) * sectorSize; s < rangeEnd;
                s += sectorSize) {
                touchedSectors.add(s);
            }
        };

        /**
         * Find the next cache or sector boundary within the requested limit.
         * @param {number} pos
         * @param {number} limit
         * @returns {number}
         */
        const nextBoundary = (pos, limit) => {
            let nextOffset = limit;
            for (const s of [...this.readBuffer, ...this.writeBuffer]) {
                if (s.address > pos && s.address < nextOffset) {
                    nextOffset = s.address;
                }
                const sEnd = s.address + s.data.length;
                if (sEnd > pos && sEnd < nextOffset) {
                    nextOffset = sEnd;
                }
            }
            const sectorEnd = Math.min(limit, (Math.floor(pos / sectorSize) + 1) * sectorSize);
            if (sectorEnd > pos && sectorEnd < nextOffset) {
                nextOffset = sectorEnd;
            }
            return nextOffset;
        };
        let position = start;
        let remaining = end - start;
        while (remaining > 0) {
            const writeSegment = findWriteSeg(position);
            if (writeSegment) {
                const offset = position - writeSegment.address;
                const span = Math.min(remaining, writeSegment.data.length - offset);
                writeSegment.data.set(normalized.subarray(position - start, position - start
                    + span), offset);
                markSectors(position, position + span);
                position += span;
                remaining -= span;
                continue;
            }
            const cachedSegment = findCachedSeg(position);
            if (cachedSegment) {
                const offset = position - cachedSegment.address;
                const span = Math.min(remaining, cachedSegment.data.length - offset);
                let matchingPrefixLength = 0;
                while (matchingPrefixLength < span) {
                    const desired = normalized[position - start + matchingPrefixLength] & 0xFF;
                    if (cachedSegment.data[offset + matchingPrefixLength] !== desired) {
                        break;
                    }
                    matchingPrefixLength++;
                }
                if (matchingPrefixLength > 0) {
                    position += matchingPrefixLength;
                    remaining -= matchingPrefixLength;
                    continue;
                }
                const sectorStart = Math.floor(position / sectorSize) * sectorSize;
                const sectorEnd = Math.min(sectorStart + sectorSize, this.size);
                if (this._isRangeCovered(sectorStart, sectorEnd - sectorStart, this.readBuffer)) {
                    const sectorBytes = this._materializeRange(sectorStart, sectorEnd);
                    const writeStart = position;
                    const writeEnd = Math.min(end, sectorEnd);
                    sectorBytes.set(normalized.subarray(writeStart - start, writeEnd - start),
                        writeStart - sectorStart);
                    this.writeBuffer = this._addSegment(this.writeBuffer, sectorStart, sectorBytes);
                    markSectors(sectorStart, sectorEnd);
                    position = writeEnd;
                    remaining = end - position;
                    continue;
                }
                const boundary = nextBoundary(position, end);
                const writeEnd = Math.min(boundary, end);
                const slice = normalized.slice(position - start, writeEnd - start);
                this.writeBuffer = this._addSegment(this.writeBuffer, position, slice);
                markSectors(position, writeEnd);
                mergeWrites();
                position = writeEnd;
                remaining = end - position;
                continue;
            }
            const boundary = nextBoundary(position, end);
            const writeEnd = Math.min(boundary, end);
            const slice = normalized.slice(position - start, writeEnd - start);
            this.writeBuffer = this._addSegment(this.writeBuffer, position, slice);
            markSectors(position, writeEnd);
            mergeWrites();
            position = writeEnd;
            remaining = end - position;
        }
        for (const sectorStart of touchedSectors) {
            const sectorEnd = Math.min(sectorStart + sectorSize, this.size);
            const readCovered = this._isRangeCovered(sectorStart, sectorEnd - sectorStart,
                this.readBuffer);
            if (!readCovered) {
                continue;
            }
            const baseline = this._materializeReadRange(sectorStart, sectorEnd);
            const combined = this._materializeRange(sectorStart, sectorEnd);
            let identical = baseline.length === combined.length;
            if (identical) {
                for (let i = 0; i < combined.length; i++) {
                    if (combined[i] !== baseline[i]) {
                        identical = false;
                        break;
                    }
                }
            }
            if (identical) {
                const pruned = [];
                for (const seg of this.writeBuffer) {
                    const segStart = seg.address;
                    const segEnd = seg.address + seg.data.length;
                    if (segEnd <= sectorStart || segStart >= sectorEnd) {
                        pruned.push(seg);
                        continue;
                    }
                    if (segStart < sectorStart) {
                        const left = seg.data.slice(0, sectorStart - segStart);
                        if (left.length) {
                            pruned.push({ address: segStart, data: left });
                        }
                    }
                    if (segEnd > sectorEnd) {
                        const right = seg.data.slice(sectorEnd - segStart);
                        if (right.length) {
                            pruned.push({ address: sectorEnd, data: right });
                        }
                    }
                }
                this.writeBuffer = this._mergeSegmentsGeneric(pruned);
            }
        }
        mergeWrites();
    }

    /**
     * Stage a repeated byte over the requested, clamped image range.
     * @param {number} value
     * @param {number} [start=0]
     * @param {number} [end=this.size]
     * @returns {void}
     */
    fill(value, start = 0, end = this.size) {
        if (this.readOnly) {
            throw new Error('SPARSE_IMAGE_READ_ONLY: this backing source does not allow mutations.');
        }
        if (start < 0 || start >= this.size) {
            throw new RangeError(`Address ${start} out of bounds [0, ${this.size})`);
        }
        end = Math.min(end, this.size);
        if (end <= start) {
            return;
        }
        const desired = value & 0xFF;
        const len = end - start;
        const buf = new Uint8Array(len);
        buf.fill(desired);
        this.write(start, buf);
    }

    // === Persistence and cache consolidation ===

    /**
     * Flush pending segments and merge them into the read cache with write priority.
     * A backing-store callback is optional; this does not compact LittleFS metadata.
     * @returns {Promise<void>}
     */
    async flush() {
        if ((this.writeDataCallback || this.flushPrepareCallback) && typeof FirmwareImage !== 'undefined') {
            FirmwareImage.assertPartialWrite(this);
        }
        if (this.readOnly && this.writeBuffer.length) {
            throw new Error('SPARSE_IMAGE_READ_ONLY: pending mutations cannot be flushed.');
        }
        if (!this.writeBuffer.length) {
            return;
        }
        const lease = this.acquireOperation('edit');
        try {
            this._mergeWriteSegments();
            if (this.flushPrepareCallback) {
                await this.flushPrepareCallback(this);
            }
            if (this.writeDataCallback) {
                const toWrite = [...this.writeBuffer].sort((a, b) => a.address - b.address);
                for (const segment of toWrite) {
                    lease.assertCurrent();
                    this.assertMutable();
                    await this.writeDataCallback(segment.address, segment.data);
                }
            }
            lease.assertCurrent();
            this.assertMutable();
            this.readBuffer = this._mergeReadAndWriteWithPriority(this.readBuffer, this.writeBuffer);
            this.writeBuffer = [];
        } finally {
            lease.release();
        }
    }

    /**
     * Discard both caches without writing pending bytes to backing storage.
     * @returns {Promise<void>}
     */
    async clear() {
        if (this.operationBusy) throw new Error('Another image operation is running.');
        this.readBuffer = [];
        this.writeBuffer = [];
    }

    /**
     * Coalesce touching groups and overlay read bytes before write bytes within each group.
     * @param {ByteSegment[]|null} readList
     * @param {ByteSegment[]|null} writeList
     * @returns {ByteSegment[]}
     */
    _mergeReadAndWriteWithPriority(readList, writeList) {
        if ((!readList || readList.length === 0) && (!writeList || writeList.length === 0)) {
            return [];
        }
        const annotated = [];
        if (readList && readList.length) {
            for (const s of readList) {
                annotated.push({ address: s.address, data: s.data, _src: 'r' });
            }
        }
        if (writeList && writeList.length) {
            for (const s of writeList) {
                annotated.push({ address: s.address, data: s.data, _src: 'w' });
            }
        }
        annotated.sort((a, b) => a.address - b.address);
        const result = [];
        let group = [];
        let groupStart = null;
        let groupEnd = null;

        /**
         * Materialize the current contiguous group, overlay writes, and reset group state.
         * @returns {void}
         */
        const flushGroup = () => {
            if (!group.length) {
                return;
            }
            const length = groupEnd - groupStart;
            const mergedData = new Uint8Array(length);
            for (const seg of group) {
                if (seg._src !== 'r') {
                    continue;
                }
                const off = seg.address - groupStart;
                mergedData.set(seg.data, off);
            }
            for (const seg of group) {
                if (seg._src !== 'w') {
                    continue;
                }
                const off = seg.address - groupStart;
                mergedData.set(seg.data, off);
            }
            result.push({ address: groupStart, data: mergedData });
            group = [];
            groupStart = null;
            groupEnd = null;
        };
        for (const seg of annotated) {
            const segStart = seg.address;
            const segEnd = seg.address + seg.data.length;
            if (groupStart === null) {
                groupStart = segStart;
                groupEnd = segEnd;
                group.push(seg);
                continue;
            }
            if (segStart <= groupEnd) {
                group.push(seg);
                if (segEnd > groupEnd) {
                    groupEnd = segEnd;
                }
            }
            else {
                flushGroup();
                groupStart = segStart;
                groupEnd = segEnd;
                group.push(seg);
            }
        }
        flushGroup();
        return result;
    }

    // === Array-like access and compatibility interfaces ===

    /**
     * Return a cached byte: zero for unread data, undefined outside image bounds.
     * @param {number} index
     * @returns {number|undefined}
     */
    _get(index) {
        if (index < 0 || index >= this.size) {
            return undefined;
        }
        const writeSegment = this._findSegment(index, this.writeBuffer);
        if (writeSegment) {
            return writeSegment.data[index - writeSegment.address];
        }
        const segment = this._findSegment(index, this.readBuffer);
        if (!segment) {
            return 0;
        }
        return segment.data[index - segment.address];
    }

    /**
     * Expose numeric property reads/writes while preserving bound method access.
     * @param {SparseImage} sparseImage
     * @returns {SparseImage}
     */
    static _createProxy(sparseImage) {
        return new Proxy(sparseImage, {

            /**
             * Resolve a proxy property or numeric byte index.
             * @param {SparseImage} target
             * @param {string|symbol} prop
             * @returns {unknown}
             */
            get(target, prop) {
                if (typeof prop === 'symbol') {
                    return target[prop];
                }
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0) {
                    return target._get(index);
                }
                if (prop in target) {
                    const value = target[prop];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return undefined;
            },

            /**
             * Assign a proxy property or stage one byte at a numeric index.
             * @param {SparseImage} target
             * @param {string|symbol} prop
             * @param {unknown} value
             * @returns {boolean}
             */
            set(target, prop, value) {
                if (typeof prop === 'symbol') {
                    target[prop] = value;
                    return true;
                }
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0) {
                    const byte = Number(value) & 0xFF;
                    target.write(index, Uint8Array.of(byte));
                    return true;
                }
                target[prop] = value;
                return true;
            },

            /**
             * Check a proxy property or valid numeric index.
             * @param {SparseImage} target
             * @param {string|symbol} prop
             * @returns {boolean}
             */
            has(target, prop) {
                if (typeof prop === 'symbol') {
                    return prop in target;
                }
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0 && index < target.size) {
                    return true;
                }
                return prop in target;
            }
        });
    }

    /**
     * Copy the requested range using cached-byte semantics; this is not a shared view.
     * @param {number|undefined} start
     * @param {number|undefined} end
     * @returns {Uint8Array}
     */
    subarray(start, end) {
        start = start || 0;
        end = end === undefined ? this.size : end;
        const size = end - start;
        const result = new Uint8Array(size);
        for (let pos = start, idx = 0; pos < end; pos++, idx++) {
            result[idx] = this._get(pos);
        }
        return result;
    }

    /**
     * Populate the cache, then copy the requested range.
     * @param {number|undefined} start
     * @param {number|undefined} end
     * @returns {Promise<Uint8Array>}
     */
    async subarray_async(start, end) {
        start = start || 0;
        end = end === undefined ? this.size : end;
        const size = end - start;
        await this._ensureData(start, size);
        const result = new Uint8Array(size);
        for (let pos = start, idx = 0; pos < end; pos++, idx++) {
            result[idx] = this._get(pos);
        }
        return result;
    }

    /**
     * Return the same copied-range semantics as subarray.
     * @param {number|undefined} start
     * @param {number|undefined} end
     * @returns {Uint8Array}
     */
    slice(start, end) {
        return this.subarray(start, end);
    }

    /**
     * Return the same asynchronous copied-range semantics as subarray_async.
     * @param {number|undefined} start
     * @param {number|undefined} end
     * @returns {Promise<Uint8Array>}
     */
    async slice_async(start, end) {
        return await this.subarray_async(start, end);
    }

    /**
     * Instantiate the compatibility DataView wrapper supplied by the surrounding environment.
     * SparseImageDataView is not defined by this HTML; the existing dependency is retained.
     * @returns {object}
     */
    createDataView() {
        return new SparseImageDataView(this);
    }

    /**
     * Populate the cache for a range without returning its bytes.
     * @param {number} address
     * @param {number} size
     * @returns {Promise<void>}
     */
    async prefetch(address, size) {
        return await this._ensureData(address, size);
    }
}
