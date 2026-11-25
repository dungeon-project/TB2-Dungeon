
// === LittleFS: byte decoding -> metadata replay -> files -> limited writes ===

(
/**
 * Define the LittleFS implementation and expose the original browser/Node exports.
 * @param {typeof globalThis} globalScope
 * @returns {void}
 */
function initLittleFsModule(globalScope) {
    'use strict';
    const LFS_TYPE_REG = 0x001;
    const LFS_TYPE_DIR = 0x002;
    const LFS_TYPE_SUPERBLOCK = 0x0ff;
    const LFS_TYPE_DIRSTRUCT = 0x200;
    const LFS_TYPE_INLINESTRUCT = 0x201;
    const LFS_TYPE_CTZSTRUCT = 0x202;
    const LFS_TYPE_CREATE = 0x401;
    const LFS_TYPE_DELETE = 0x4ff;

    /**
     * Apply JavaScript unsigned-32-bit coercion.
     * @param {number} x
     * @returns {number}
     */
    function toUint32(x) {
        return x >>> 0;
    }

    /**
     * Decode four bytes at an offset as an unsigned big-endian word.
     * @param {Uint8Array} buf
     * @param {number} off
     * @returns {number}
     */
    function fromBe32At(buf, off) {
        return (((buf[off] << 24) >>> 0) |
            (buf[off + 1] << 16) |
            (buf[off + 2] << 8) |
            (buf[off + 3] << 0)) >>> 0;
    }

    /**
     * Decode four bytes at an offset as an unsigned little-endian word.
     * @param {Uint8Array} buf
     * @param {number} off
     * @returns {number}
     */
    function fromLe32At(buf, off) {
        return (((buf[off + 3] << 24) >>> 0) |
            (buf[off + 2] << 16) |
            (buf[off + 1] << 8) |
            (buf[off + 0] << 0)) >>> 0;
    }

    /**
     * Count set bits after unsigned-32-bit coercion.
     * @param {number} v
     * @returns {number}
     */
    function popcount32(v) {
        v = v >>> 0;
        let c = 0;
        while (v) {
            v &= (v - 1) >>> 0;
            c++;
        }
        return c;
    }

    /**
     * Count trailing zero bits in a uint32 value; zero returns 32.
     * @param {number} v
     * @returns {number}
     */
    function ctz32(v) {
        v = v >>> 0;
        if (v === 0) {
            return 32;
        }
        let c = 0;
        while (((v >>> c) & 1) === 0) {
            c++;
        }
        return c;
    }

    /**
     * Compute the existing next-power-of-two exponent using its signed-shift loop.
     * @param {number} v
     * @returns {number}
     */
    function npw2(v) {
        v = v >>> 0;
        if (v <= 1) {
            return 0;
        }
        let p = 0;
        let x = 1;
        while (x < v) {
            x <<= 1;
            p++;
        }
        return p;
    }

    /**
     * Decode UTF-8 when TextDecoder exists; otherwise preserve the byte-to-character fallback.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    function utf8Decode(bytes) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(bytes);
        }
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            out += String.fromCharCode(bytes[i]);
        }
        return out;
    }

    /**
     * Normalize slashes and one trailing slash without resolving dot segments.
     * @param {string|null|undefined} path
     * @returns {string}
     */
    function normalizePath(path) {
        if (!path || path === '/') {
            return '/';
        }
        let p = path.replace(/\\/g, '/');
        if (!p.startsWith('/')) {
            p = '/' + p;
        }
        if (p.length > 1 && p.endsWith('/')) {
            p = p.slice(0, -1);
        }
        return p;
    }
    const CRC32_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    })();

    /**
     * Update the reflected CRC-32 accumulator over the selected byte interval.
     * @param {number} crc
     * @param {Uint8Array} bytes
     * @param {number} [start=0]
     * @param {number} [length=bytes.length - start]
     * @returns {number}
     */
    function crc32Update(crc, bytes, start = 0, length = bytes.length - start) {
        let c = crc >>> 0;
        const end = start + length;
        for (let i = start; i < end; i++) {
            c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        }
        return c >>> 0;
    }

    /**
     * Test whether the metadata tag's validity bit is clear.
     * @param {number} tag
     * @returns {boolean}
     */
    function lfsTagIsValid(tag) {
        return (tag & 0x80000000) === 0;
    }

    /**
     * Test the tag's reserved size-field deletion encoding.
     * @param {number} tag
     * @returns {boolean}
     */
    function lfsTagIsDelete(tag) {
        const shifted = (tag << 22) | 0;
        return (shifted >> 22) === -1;
    }

    /**
     * Extract the broad three-bit tag type.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagType1(tag) {
        return (tag & 0x70000000) >>> 20;
    }

    /**
     * Extract the four-bit tag type used to recognize CRC commits.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagType2(tag) {
        return (tag & 0x78000000) >>> 20;
    }

    /**
     * Extract the complete eleven-bit metadata tag type.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagType3(tag) {
        return (tag >>> 20) & 0x7ff;
    }

    /**
     * Extract the low byte of the tag type field.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagChunk(tag) {
        return (tag >>> 20) & 0xff;
    }

    /**
     * Extract the ten-bit metadata entry identifier.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagId(tag) {
        return (tag >>> 10) & 0x3ff;
    }

    /**
     * Extract the ten-bit metadata payload length.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagSize(tag) {
        return tag & 0x3ff;
    }

    /**
     * Calculate tag-plus-payload size with the original deletion-marker adjustment.
     * @param {number} tag
     * @returns {number}
     */
    function lfsTagDSize(tag) {
        return 4 + lfsTagSize(tag + (lfsTagIsDelete(tag) ? 1 : 0));
    }

    /**
     * Pack type, entry identifier, and payload length into one unsigned metadata tag.
     * @param {number} type
     * @param {number} id
     * @param {number} size
     * @returns {number}
     */
    function lfsMktag(type, id, size) {
        return (((type & 0x7ff) << 20) | ((id & 0x3ff) << 10) | (size & 0x3ff)) >>> 0;
    }
    /*
 * Copyright (c) 2022, The littlefs authors.
 * Copyright (c) 2017, Arm Limited. All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 * - Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice, this
 *   list of conditions and the following disclaimer in the documentation and/or
 *   other materials provided with the distribution.
 * - Neither the name of ARM nor the names of its contributors may be used to
 *   endorse or promote products derived from this software without specific prior
 *   written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// === Transactional LittleFS v2 image editing ===
// Format reference: littlefs-project/littlefs SPEC.md and lfs.c (BSD-3-Clause).
// This is a scoped JavaScript image writer, not a port of the complete C driver.

/** @typedef {{type: number, data: Uint8Array}} LfsStoredTag */
/** @typedef {{name: LfsStoredTag|null, structure: LfsStoredTag|null,
 * attributes: Map<number, LfsStoredTag>}} LfsLiveEntry */
/** @typedef {{entries: LfsLiveEntry[], tail: LfsStoredTag|null,
 * globals: Map<number, LfsStoredTag>, rootAttributes: Map<number, LfsStoredTag>,
 * unsupported: number[]}} LfsLiveMetadata */
/** @typedef {{pair: BlockPair, rev: number, model: LfsLiveMetadata}} LfsPairState */
/** @typedef {{path: string, entry: LfsLiveEntry, pair: LfsPairState,
 * id: number, data: Uint8Array|null}} LfsFileState */

const LFS_NULL_BLOCK = 0xffffffff;
const LFS_MAX_TAG_DATA = 1022;
const LFS_IMAGE_LOCKS = new WeakMap();
const LFS_IMAGE_PARSERS = new WeakMap();

/**
 * Compare raw bytes without copies.
 * @param {Uint8Array} left @param {Uint8Array} right @returns {boolean}
 */
function lfsBytesEqual(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

/**
 * Compare filenames in unsigned-byte order.
 * @param {Uint8Array} left @param {Uint8Array} right @returns {number}
 */
function lfsCompareNames(left, right) {
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count; index++) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
}

/** @returns {LfsLiveEntry} */
function lfsEmptyLiveEntry() {
    return { name: null, structure: null, attributes: new Map() };
}

/**
 * Replay committed tags, retaining raw filenames, structures, and every live user attribute.
 * Per-pair global values supersede earlier values; XOR is applied across pairs, not commits.
 * @param {MetadataTag[]} tags
 * @returns {LfsLiveMetadata}
 */
function lfsReplayLiveMetadata(tags) {
    const model = {
        entries: [], tail: null, globals: new Map(), rootAttributes: new Map(), unsupported: []
    };
    for (const { tag, data } of tags) {
        const type = lfsTagType3(tag);
        const family = type & 0x700;
        const id = lfsTagId(tag);
        const deleted = lfsTagIsDelete(tag);
        const stored = { type, data };
        if (type === LFS_TYPE_CREATE || type === LFS_TYPE_DELETE) {
            if (deleted || data.length || id > model.entries.length || id === 0x3ff) {
                throw new Error('LFS_CORRUPT: invalid directory splice');
            }
            if (type === LFS_TYPE_CREATE) {
                model.entries.splice(id, 0, lfsEmptyLiveEntry());
            } else {
                if (id >= model.entries.length) throw new Error('LFS_CORRUPT: invalid delete');
                model.entries.splice(id, 1);
            }
            continue;
        }
        if (type === 0x5ff) continue; // An FCRC describes the old append area, not live state.
        if (family === 0x600) {
            model.tail = deleted ? null : stored;
            continue;
        }
        if (family === 0x700) {
            if (deleted) model.globals.delete(type);
            else model.globals.set(type, stored);
            continue;
        }
        if (id === 0x3ff && family === 0x300) {
            if (deleted) model.rootAttributes.delete(type);
            else model.rootAttributes.set(type, stored);
            continue;
        }
        if (id === 0x3ff || ![0x000, 0x200, 0x300].includes(family)) {
            model.unsupported.push(type);
            continue;
        }
        while (model.entries.length <= id) model.entries.push(lfsEmptyLiveEntry());
        const entry = model.entries[id];
        if (family === 0x000) entry.name = deleted ? null : stored;
        if (family === 0x200) entry.structure = deleted ? null : stored;
        if (family === 0x300) {
            if (deleted) entry.attributes.delete(type);
            else entry.attributes.set(type, stored);
        }
    }
    return model;
}

/**
 * Validate and inspect an entire bounded filesystem snapshot before allocating any blocks.
 * Unknown structures and pending recovery states are rejected, never silently discarded.
 */
class LittleFSImageWriter {
    /** @param {LittleFS} fs @param {Uint8Array} bytes @param {object} superblock */
    constructor(fs, bytes, superblock) {
        this.fs = fs;
        this.bytes = bytes;
        this.superblock = superblock;
        this.blockSize = superblock.blockSize;
        this.blockCount = superblock.blockCount;
        this.used = new Uint8Array(this.blockCount);
        this.pairs = new Map();
        this.files = new Map();
        this.nextFree = 0;
        this.allocated = [];
        this.changedBlocks = new Set();
    }

    /** @param {BlockPair} pair @returns {string} */
    pairKey(pair) {
        return pair[0] < pair[1] ? `${pair[0]},${pair[1]}` : `${pair[1]},${pair[0]}`;
    }

    /** @param {number} block @returns {void} */
    validateBlock(block) {
        if (!Number.isInteger(block) || block < 0 || block >= this.blockCount) {
            throw new Error(`LFS_CORRUPT: block ${block} is outside the filesystem`);
        }
    }

    /** @param {BlockPair} pair @returns {void} */
    validatePair(pair) {
        this.validateBlock(pair[0]);
        this.validateBlock(pair[1]);
        if (pair[0] === pair[1]) throw new Error('LFS_CORRUPT: repeated metadata block');
    }

    /** @param {number} block @returns {Uint8Array} */
    blockBytes(block) {
        this.validateBlock(block);
        return this.bytes.subarray(block * this.blockSize, (block + 1) * this.blockSize);
    }

    /** @param {LfsLiveMetadata} model @returns {BlockPair|null} */
    tailPair(model) {
        if (!model.tail) return null;
        const { type, data } = model.tail;
        if (![0x600, 0x601].includes(type) || data.length !== 8) {
            throw new Error('LFS_UNSUPPORTED: invalid or unknown tail structure');
        }
        const pair = [fromLe32At(data, 0), fromLe32At(data, 4)];
        if (pair[0] === LFS_NULL_BLOCK && pair[1] === LFS_NULL_BLOCK) {
            if (type === 0x601) throw new Error('LFS_CORRUPT: hard tail has no successor');
            return null;
        }
        this.validatePair(pair);
        return pair;
    }

    /** Scan metadata and validate the directory graph. @returns {Promise<LittleFSImageWriter>} */
    async inspect() {
        let pair = [0, 1];
        const globalState = new Uint8Array(12);
        while (pair) {
            this.validatePair(pair);
            const key = this.pairKey(pair);
            if (this.pairs.has(key)) throw new Error('LFS_CORRUPT: metadata tail cycle');
            for (const block of pair) {
                if (this.used[block]) throw new Error('LFS_CORRUPT: overlapping metadata pairs');
                this.used[block] = 1;
            }
            const dir = await this.fs._fetchDir(pair);
            const parsed = await this.fs._parseMetadataBlock(dir.pair[0]);
            if (!parsed.valid || !parsed.off) throw new Error('LFS_CORRUPT: no valid commit');
            const model = lfsReplayLiveMetadata(parsed.tags);
            if (model.unsupported.length) {
                const tag = model.unsupported[0].toString(16);
                throw new Error(`LFS_UNSUPPORTED: metadata type 0x${tag}; image unchanged`);
            }
            for (const [type, value] of model.globals) {
                if (type !== 0x7ff || value.data.length !== 12) {
                    throw new Error('LFS_UNSUPPORTED: unknown global state');
                }
                for (let index = 0; index < 12; index++) globalState[index] ^= value.data[index];
            }
            this.pairs.set(key, { pair: dir.pair.slice(), rev: parsed.rev, model });
            pair = this.tailPair(model);
        }
        if (globalState.some(byte => byte !== 0)) {
            throw new Error('LFS_RECOVERY_REQUIRED: pending move/orphan state; image unchanged');
        }
        for (const pairState of this.pairs.values()) this.validateEntries(pairState);
        this.indexDirectory(this.fs.rootPair, '/', new Set());
        return this;
    }

    /** @param {LfsPairState} pairState @returns {void} */
    validateEntries(pairState) {
        let previousName = null;
        for (const [id, entry] of pairState.model.entries.entries()) {
            if (!entry.name || !entry.structure) {
                throw new Error('LFS_CORRUPT: incomplete live directory entry');
            }
            const { type, data: name } = entry.name;
            if (![LFS_TYPE_REG, LFS_TYPE_DIR, LFS_TYPE_SUPERBLOCK].includes(type)) {
                throw new Error('LFS_UNSUPPORTED: unknown file type');
            }
            if (type === LFS_TYPE_SUPERBLOCK) {
                if (id !== 0 || utf8Decode(name) !== 'littlefs' ||
                    entry.structure.type !== LFS_TYPE_INLINESTRUCT ||
                    entry.structure.data.length !== 24) {
                    throw new Error('LFS_CORRUPT: invalid superblock entry');
                }
                continue;
            }
            if (!name.length || name.length > this.superblock.nameMax ||
                name.some(byte => byte === 0 || byte === 0x2f)) {
                throw new Error('LFS_CORRUPT: invalid filename');
            }
            if (previousName && lfsCompareNames(previousName, name) >= 0) {
                throw new Error('LFS_CORRUPT: directory names are not strictly ordered');
            }
            previousName = name;
            if (!lfsBytesEqual(new TextEncoder().encode(utf8Decode(name)), name)) {
                throw new Error('LFS_UNSUPPORTED: non-UTF-8 filename; image unchanged');
            }
            for (const attribute of entry.attributes.values()) {
                if (attribute.data.length > this.superblock.attrMax) {
                    throw new Error('LFS_CORRUPT: oversized user attribute');
                }
            }
            const structure = entry.structure;
            if (type === LFS_TYPE_DIR) {
                if (structure.type !== LFS_TYPE_DIRSTRUCT || structure.data.length !== 8) {
                    throw new Error('LFS_CORRUPT: invalid directory structure');
                }
                const child = [fromLe32At(structure.data, 0), fromLe32At(structure.data, 4)];
                if (!this.pairs.has(this.pairKey(child))) {
                    throw new Error('LFS_CORRUPT: directory is missing from metadata chain');
                }
                continue;
            }
            if (structure.type === LFS_TYPE_INLINESTRUCT) continue;
            if (structure.type !== LFS_TYPE_CTZSTRUCT || structure.data.length !== 8) {
                throw new Error('LFS_UNSUPPORTED: unknown file storage structure');
            }
            const chain = this.ctzBlocks(structure);
            for (const block of chain) {
                if (this.used[block]) throw new Error('LFS_CORRUPT: shared data block');
                this.used[block] = 1;
            }
        }
    }

    /**
     * Validate every CTZ skip link using a linear walk of the preceding-block links.
     * @param {LfsStoredTag} structure
     * @returns {number[]}
     */
    ctzBlocks(structure) {
        const size = fromLe32At(structure.data, 4);
        if (size > this.superblock.fileMax || size > this.bytes.length) {
            throw new Error('LFS_CORRUPT: invalid CTZ file length');
        }
        if (size === 0) return [];
        let capacity = this.blockSize;
        let count = 1;
        while (capacity < size) {
            capacity += this.blockSize - 4 * (ctz32(count) + 1);
            count++;
            if (count > this.blockCount) throw new Error('LFS_CORRUPT: excessive CTZ chain');
        }
        const chain = new Array(count);
        let block = fromLe32At(structure.data, 0);
        const seen = new Set();
        for (let index = count - 1; index >= 0; index--) {
            this.validateBlock(block);
            if (seen.has(block)) throw new Error('LFS_CORRUPT: CTZ cycle');
            seen.add(block);
            chain[index] = block;
            if (index) block = fromLe32At(this.blockBytes(block), 0);
        }
        for (let index = 1; index < count; index++) {
            const bytes = this.blockBytes(chain[index]);
            for (let skip = 0; skip <= ctz32(index); skip++) {
                if (fromLe32At(bytes, 4 * skip) !== chain[index - 2 ** skip]) {
                    throw new Error('LFS_CORRUPT: inconsistent CTZ skip pointer');
                }
            }
        }
        return chain;
    }

    /**
     * Index visible files without following soft tails as directory contents.
     * @param {BlockPair} firstPair @param {string} base @param {Set<string>} visited
     * @returns {void}
     */
    indexDirectory(firstPair, base, visited) {
        let pair = firstPair;
        let previousName = null;
        while (pair) {
            const key = this.pairKey(pair);
            if (visited.has(key)) throw new Error('LFS_CORRUPT: directory cycle or alias');
            visited.add(key);
            const state = this.pairs.get(key);
            if (!state) throw new Error('LFS_CORRUPT: untracked directory pair');
            for (const [id, entry] of state.model.entries.entries()) {
                if (entry.name.type === LFS_TYPE_SUPERBLOCK) continue;
                const nameBytes = entry.name.data;
                if (previousName && lfsCompareNames(previousName, nameBytes) >= 0) {
                    throw new Error('LFS_CORRUPT: split directory is not ordered');
                }
                previousName = nameBytes;
                const path = (base === '/' ? '' : base) + '/' + utf8Decode(nameBytes);
                if (this.files.has(path)) throw new Error('LFS_CORRUPT: duplicate path');
                this.files.set(path, { path, entry, pair: state, id, data: null });
                if (entry.name.type === LFS_TYPE_DIR) {
                    const data = entry.structure.data;
                    this.indexDirectory([fromLe32At(data, 0), fromLe32At(data, 4)], path, visited);
                }
            }
            pair = state.model.tail?.type === 0x601 ? this.tailPair(state.model) : null;
        }
    }

    /** @param {LfsLiveEntry} entry @returns {Uint8Array} */
    readEntry(entry) {
        if (entry.structure.type === LFS_TYPE_INLINESTRUCT) return entry.structure.data;
        const chain = this.ctzBlocks(entry.structure);
        const result = new Uint8Array(fromLe32At(entry.structure.data, 4));
        let offset = 0;
        for (let index = 0; index < chain.length; index++) {
            const headerSize = index === 0 ? 0 : 4 * (ctz32(index) + 1);
            const take = Math.min(this.blockSize - headerSize, result.length - offset);
            const blockData = this.blockBytes(chain[index]);
            result.set(blockData.subarray(headerSize, headerSize + take), offset);
            offset += take;
        }
        return result;
    }

    /** Reserve an unreferenced block; keep live data intact. @returns {number} */
    allocateBlock() {
        while (this.nextFree < this.blockCount && this.used[this.nextFree]) this.nextFree++;
        if (this.nextFree === this.blockCount) {
            throw new Error(
                'LFS_NOSPC: insufficient free blocks for copy-on-write; image unchanged');
        }
        const block = this.nextFree++;
        this.used[block] = 1;
        this.allocated.push(block);
        this.changedBlocks.add(block);
        this.blockBytes(block).fill(0xff);
        return block;
    }

    /** @param {Uint8Array} data @returns {LfsStoredTag} */
    writeCtz(data) {
        const blocks = [];
        let offset = 0;
        while (offset < data.length) {
            const index = blocks.length;
            const block = this.allocateBlock();
            const bytes = this.blockBytes(block);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const pointers = index === 0 ? 0 : ctz32(index) + 1;
            for (let skip = 0; skip < pointers; skip++) {
                view.setUint32(4 * skip, blocks[index - 2 ** skip], true);
            }
            const header = 4 * pointers;
            const take = Math.min(this.blockSize - header, data.length - offset);
            bytes.set(data.subarray(offset, offset + take), header);
            blocks.push(block);
            offset += take;
        }
        const structure = new Uint8Array(8);
        const view = new DataView(structure.buffer);
        view.setUint32(0, blocks.length ? blocks[blocks.length - 1] : LFS_NULL_BLOCK, true);
        view.setUint32(4, data.length, true);
        return { type: LFS_TYPE_CTZSTRUCT, data: structure };
    }

    /** @param {LfsLiveEntry[]} entries @param {LfsLiveMetadata} model @returns {MetadataTag[]} */
    liveTags(entries, model) {
        const tags = [];
        const add = (stored, id) => {
            if (stored) tags.push({ tag: lfsMktag(stored.type, id, stored.data.length),
                data: stored.data });
        };
        entries.forEach((entry, id) => {
            add(entry.name, id);
            add(entry.structure, id);
            for (const attribute of entry.attributes.values()) add(attribute, id);
        });
        for (const attribute of model.rootAttributes.values()) add(attribute, 0x3ff);
        add(model.tail, 0x3ff);
        for (const global of model.globals.values()) add(global, 0x3ff);
        return tags;
    }

    /** @param {LfsLiveEntry[]} entries @param {LfsLiveMetadata} model @returns {number} */
    metadataSize(entries, model) {
        const tagSize = this.liveTags(entries, model).reduce(
            (sum, item) => sum + 4 + item.data.length, 0);
        return 4 + tagSize + (this.superblock.version === 0x20001 ? 20 : 8);
    }

    /**
     * Write one fresh compacted metadata block. Program granularity for offline images is 1.
     * A v2.1 FCRC covers the following erased byte; v2.0 receives no incompatible FCRC tag.
     * @param {number} block @param {number} revision @param {MetadataTag[]} tags
     * @returns {void}
     */
    writeMetadata(block, revision, tags) {
        const bytes = this.blockBytes(block);
        bytes.fill(0xff);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        view.setUint32(0, revision >>> 0, true);
        let offset = 4;
        let previous = 0xffffffff;
        const put = (tag, data) => {
            if (data.length > LFS_MAX_TAG_DATA || offset + 4 + data.length > bytes.length) {
                throw new Error('LFS_NOSPC: compacted metadata does not fit');
            }
            view.setUint32(offset, (tag ^ previous) >>> 0, false);
            bytes.set(data, offset + 4);
            offset += 4 + data.length;
            previous = tag;
        };
        for (const item of tags) put(item.tag, item.data);
        if (this.superblock.version === 0x20001 && offset + 20 < bytes.length) {
            const fcrc = new Uint8Array(8);
            const fview = new DataView(fcrc.buffer);
            fview.setUint32(0, 1, true);
            fview.setUint32(4, crc32Update(0xffffffff, Uint8Array.of(0xff)), true);
            put(lfsMktag(0x5ff, 0x3ff, 8), fcrc);
        }
        if (offset + 8 > bytes.length) throw new Error('LFS_NOSPC: no space for metadata CRC');
        const crcTag = lfsMktag(0x500, 0x3ff, 4);
        view.setUint32(offset, (crcTag ^ previous) >>> 0, false);
        view.setUint32(offset + 4, crc32Update(0xffffffff, bytes, 0, offset + 4), true);
        this.changedBlocks.add(block);
    }

    /**
     * Compact the affected pair. Split into additional pairs only if live metadata needs it.
     * All new tails are prepared before the original pair receives its new revision.
     * @param {LfsPairState} state @returns {number}
     */
    compactDirectory(state) {
        const model = state.model;
        const chunks = [];
        if (this.metadataSize(model.entries, model) <= this.blockSize &&
            model.entries.length <= 1023) {
            chunks.push(model.entries);
        } else {
            const crcSpace = this.superblock.version === 0x20001 ? 20 : 8;
            const extraTags = [...model.globals.values(), ...model.rootAttributes.values()];
            const firstExtra = extraTags.reduce((sum, tag) => sum + 4 + tag.data.length, 0);
            let budget = this.blockSize - 4 - crcSpace - 12 - firstExtra;
            let group = [];
            for (const entry of model.entries) {
                const entryTags = [entry.name, entry.structure, ...entry.attributes.values()];
                const cost = entryTags.reduce((sum, tag) => sum + 4 + tag.data.length, 0);
                if (cost > budget || group.length === 1023) {
                    if (!group.length) {
                        throw new Error('LFS_NOSPC: one live entry cannot fit a metadata pair');
                    }
                    chunks.push(group);
                    group = [];
                    budget = this.blockSize - 4 - crcSpace - 12;
                }
                if (cost > budget) {
                    throw new Error('LFS_NOSPC: one live entry cannot fit a metadata pair');
                }
                group.push(entry);
                budget -= cost;
            }
            chunks.push(group);
        }
        const pairs = [state.pair];
        for (let index = 1; index < chunks.length; index++) {
            pairs.push([this.allocateBlock(), this.allocateBlock()]);
        }
        for (let index = chunks.length - 1; index >= 0; index--) {
            let tail = model.tail;
            if (index + 1 < chunks.length) {
                const data = new Uint8Array(8);
                const view = new DataView(data.buffer);
                view.setUint32(0, pairs[index + 1][0], true);
                view.setUint32(4, pairs[index + 1][1], true);
                tail = { type: 0x601, data };
            }
            const chunkModel = { ...model, tail,
                globals: index === 0 ? model.globals : new Map(),
                rootAttributes: index === 0 ? model.rootAttributes : new Map() };
            const block = index === 0 ? state.pair[1] : pairs[index][0];
            const revision = index === 0 ? (state.rev + 1) >>> 0 : 1;
            this.writeMetadata(block, revision, this.liveTags(chunks[index], chunkModel));
        }
        return chunks.length - 1;
    }

    /**
     * Create one new regular file directly in the filesystem root.
     * The entry is inserted in LittleFS bytewise filename order and the affected metadata
     * pair is compacted with the same copy-on-write machinery used by replacement.
     *
     * @param {string} path
     * @param {Uint8Array} data
     * @returns {object}
     */
    createRootFile(path, data) {
        if (!/^\/[^/]+$/.test(path)) {
            throw new Error('LFS_CREATE_UNSUPPORTED: only root-level files are supported.');
        }
        if (this.files.has(path)) {
            throw new Error(`LFS_EXIST: file already exists: ${path}`);
        }
        if (!(data instanceof Uint8Array)) {
            throw new Error('LFS_CREATE_INVALID: data must be Uint8Array.');
        }
        if (data.length > Math.min(this.superblock.fileMax, 0x7fffffff)) {
            throw new Error('LFS_FBIG: file exceeds the limit stored in the superblock');
        }

        const nameBytes = new TextEncoder().encode(path.slice(1));
        if (!nameBytes.length || nameBytes.length > this.superblock.nameMax ||
            nameBytes.some(byte => byte === 0 || byte === 0x2f)) {
            throw new Error('LFS_CREATE_INVALID: invalid filename.');
        }

        // Follow the root hard-tail chain and choose the metadata state whose sorted range
        // owns the new filename. compactDirectory() preserves the state's existing tail.
        const states = [];
        const seen = new Set();
        let pair = this.fs.rootPair.slice();
        while (pair) {
            const key = this.pairKey(pair);
            if (seen.has(key)) throw new Error('LFS_CORRUPT: root split-directory cycle');
            seen.add(key);

            const state = this.pairs.get(key);
            if (!state) throw new Error('LFS_CORRUPT: root directory pair is not tracked');
            states.push(state);

            pair = state.model.tail?.type === 0x601
                ? this.tailPair(state.model)
                : null;
        }
        if (!states.length) throw new Error('LFS_CORRUPT: root directory is missing');

        let target = states[states.length - 1];
        for (const state of states) {
            const normalEntries = state.model.entries.filter(entry =>
                entry.name && entry.name.type !== LFS_TYPE_SUPERBLOCK);
            if (!normalEntries.length) continue;
            const lastName = normalEntries[normalEntries.length - 1].name.data;
            if (lfsCompareNames(nameBytes, lastName) < 0) {
                target = state;
                break;
            }
        }

        let insertAt = target.model.entries.length;
        for (let index = 0; index < target.model.entries.length; index++) {
            const entry = target.model.entries[index];
            if (!entry.name || entry.name.type === LFS_TYPE_SUPERBLOCK) continue;
            const comparison = lfsCompareNames(nameBytes, entry.name.data);
            if (comparison === 0) throw new Error(`LFS_EXIST: file already exists: ${path}`);
            if (comparison < 0) {
                insertAt = index;
                break;
            }
        }

        const entry = {
            name: { type: LFS_TYPE_REG, data: nameBytes },
            structure: { type: LFS_TYPE_INLINESTRUCT, data: data.slice() },
            attributes: new Map()
        };
        target.model.entries.splice(insertAt, 0, entry);

        const inlineLimit = Math.min(
            LFS_MAX_TAG_DATA,
            this.superblock.attrMax,
            Math.floor(this.blockSize / 8)
        );
        if (data.length > inlineLimit) {
            entry.structure = this.writeCtz(data);
        }

        const addedMetadataPairs = this.compactDirectory(target);
        return {
            changed: true,
            created: true,
            oldSize: 0,
            oldStructType: null,
            addedMetadataPairs,
            storage: entry.structure.type === LFS_TYPE_CTZSTRUCT ? 'ctz' : 'inline'
        };
    }

    /** @param {string} path @param {Uint8Array|null} data @returns {object} */
    mutate(path, data) {
        const file = this.files.get(path);
        if (!file || file.entry.name.type !== LFS_TYPE_REG) {
            throw new Error(`LFS_NOENT: not an existing regular file: ${path}`);
        }
        const previousBytes = this.readEntry(file.entry);
        const oldSize = previousBytes.length;
        const oldStructType = file.entry.structure.type;
        if (data !== null && data.length > Math.min(this.superblock.fileMax, 0x7fffffff)) {
            throw new Error('LFS_FBIG: file exceeds the limit stored in the superblock');
        }
        if (data !== null && lfsBytesEqual(previousBytes, data)) {
            return { changed: false, oldSize, oldStructType, addedMetadataPairs: 0 };
        }
        if (data === null) {
            file.pair.model.entries.splice(file.id, 1);
        } else {
            const inlineLimit = Math.min(LFS_MAX_TAG_DATA, this.superblock.attrMax,
                Math.floor(this.blockSize / 8));
            const structure = { type: LFS_TYPE_INLINESTRUCT, data };
            file.entry.structure = structure;
            if (data.length > inlineLimit ||
                this.metadataSize(file.pair.model.entries, file.pair.model) > this.blockSize) {
                file.entry.structure = this.writeCtz(data);
            }
        }
        const addedMetadataPairs = this.compactDirectory(file.pair);
        return { changed: true, oldSize, oldStructType, addedMetadataPairs,
            storage: data === null ? 'deleted' :
                file.entry.structure.type === LFS_TYPE_CTZSTRUCT ? 'ctz' : 'inline' };
    }
}

/** @param {LittleFSParser} parser @returns {void} */
function lfsRegisterParser(parser) {
    let parsers = LFS_IMAGE_PARSERS.get(parser.sparseImage);
    if (!parsers) {
        parsers = new Set();
        LFS_IMAGE_PARSERS.set(parser.sparseImage, parsers);
    }
    parsers.add(parser);
}

/**
 * Remove overlap with an interval, preserving all bytes outside that interval.
 * @param {ByteSegment[]} segments @param {number} start @param {number} end
 * @returns {ByteSegment[]}
 */
function lfsOutsideSegments(segments, start, end) {
    const result = [];
    for (const segment of segments) {
        const segmentEnd = segment.address + segment.data.length;
        if (segment.address >= end || segmentEnd <= start) {
            result.push(segment);
            continue;
        }
        if (segment.address < start) {
            result.push({ address: segment.address,
                data: segment.data.subarray(0, start - segment.address) });
        }
        if (segmentEnd > end) {
            result.push({ address: end, data: segment.data.subarray(end - segment.address) });
        }
    }
    return result;
}

/**
 * Prepare and validate a mutation using private partition buffers, then publish synchronously.
 * Physical write callbacks are deliberately excluded: a raw flash write is not RAM-atomic.
 * @param {LittleFSParser} parser
 * @param {string} path
 * @param {Uint8Array|null} data
 * @param {Uint8Array} [expectedBytes]
 * @param {{allowCreate?: boolean}} [options={}]
 * @returns {Promise<MutationResult>}
 */
async function lfsMutateImage(parser, path, data, expectedBytes, options = {}, transaction = null) {
    const image = parser.sparseImage;
    transaction?.assertCurrent();
    if (image.readOnly) {
        throw new Error('LFS_READ_ONLY: the selected SparseImage is read-only.');
    }
    if (image.writeDataCallback || image.flushPrepareCallback) {
        throw new Error(
            'LFS_OFFLINE_ONLY: open a disk dump; device callbacks are not transactional');
    }
    const sb = parser.fsInfo?.superblock;
    if (!sb || ![0x20000, 0x20001].includes(sb.version)) {
        throw new Error('LFS_UNSUPPORTED: only on-disk LittleFS 2.0 and 2.1 are writable');
    }
    const fsLength = sb.blockSize * sb.blockCount;
    if (!Number.isSafeInteger(fsLength) || sb.blockSize < 128 || sb.blockCount < 2 ||
        fsLength > parser.size || parser.startOffset < 0 ||
        parser.startOffset + fsLength > image.size) {
        throw new Error('LFS_CORRUPT: filesystem geometry exceeds its image partition');
    }
    const start = parser.startOffset;
    const end = start + fsLength;
    await image.prefetch(start, fsLength);
    if (!image._isRangeCoveredAny(start, fsLength)) {
        throw new Error('LFS_IO: incomplete source image');
    }
    const baseline = image._materializeRange(start, end);
    const physicalBaseline = image._materializeReadRange(start, end);
    const stage = baseline.slice();
    const makeFs = bytes => new LittleFS({
        async read(offset, length) {
            if (offset < 0 || length < 0 || offset + length > bytes.length) {
                throw new Error('LFS_CORRUPT: read exceeds snapshot bounds');
            }
            return bytes.slice(offset, offset + length);
        }
    }, { fsOffset: 0, blockSize: sb.blockSize, blockCount: sb.blockCount });
    const beforeFs = makeFs(baseline);
    await beforeFs.mount();
    const before = await new LittleFSImageWriter(beforeFs, baseline, sb).inspect();
    const existedBefore = before.files.has(path);
    if (expectedBytes !== undefined) {
        const current = before.files.get(path);
        if (!current || !lfsBytesEqual(before.readEntry(current.entry), expectedBytes)) {
            throw new Error(`LFS_CONFLICT: ${path} changed since loading; reload before writing`);
        }
    }
    const stageFs = makeFs(stage);
    await stageFs.mount();
    const writer = await new LittleFSImageWriter(stageFs, stage, sb).inspect();
    const result = (!existedBefore && data !== null && options.allowCreate)
        ? writer.createRootFile(path, data)
        : writer.mutate(path, data);
    if (!result.changed) {
        return { success: true, path, bytesWritten: data?.length || 0,
            persisted: false, imageOnly: true, ...result };
    }
    const verifiedFs = makeFs(stage);
    const mounted = await verifiedFs.mount();
    const verified = await new LittleFSImageWriter(verifiedFs, stage, sb).inspect();
    if (JSON.stringify(mounted.superblock) !== JSON.stringify(sb)) {
        throw new Error('LFS_VERIFY_FAILED: superblock changed');
    }
    const expectedCount = before.files.size
        + (result.created ? 1 : 0)
        - (data === null ? 1 : 0);
    if (verified.files.size !== expectedCount) throw new Error('LFS_VERIFY_FAILED: entry count');
    for (const [filePath, previous] of before.files) {
        const current = verified.files.get(filePath);
        if (filePath === path && data === null) {
            if (current) throw new Error('LFS_VERIFY_FAILED: deleted file is still present');
            continue;
        }
        if (!current || current.entry.name.type !== previous.entry.name.type) {
            throw new Error(`LFS_VERIFY_FAILED: missing or changed entry ${filePath}`);
        }
        const previousAttrs = [...previous.entry.attributes];
        const currentAttrs = [...current.entry.attributes];
        if (previousAttrs.length !== currentAttrs.length || previousAttrs.some(([type, attr]) =>
            !current.entry.attributes.has(type) ||
            !lfsBytesEqual(attr.data, current.entry.attributes.get(type).data))) {
            throw new Error(`LFS_VERIFY_FAILED: attributes changed for ${filePath}`);
        }
        if (previous.entry.name.type !== LFS_TYPE_REG) continue;
        const expected = filePath === path ? data : before.readEntry(previous.entry);
        if (!lfsBytesEqual(verified.readEntry(current.entry), expected)) {
            throw new Error(`LFS_VERIFY_FAILED: file bytes differ for ${filePath}`);
        }
    }

    if (result.created) {
        const created = verified.files.get(path);
        if (!created || created.entry.name.type !== LFS_TYPE_REG) {
            throw new Error(`LFS_VERIFY_FAILED: created file is missing: ${path}`);
        }
        if (!lfsBytesEqual(verified.readEntry(created.entry), data)) {
            throw new Error(`LFS_VERIFY_FAILED: created file bytes differ for ${path}`);
        }
    }

    const flat = await verifiedFs.listAll();
    const normalizedFlat = flat.map(item => ({
        ...parser._makeFileNode(item.path, null, item.type === LFS_TYPE_DIR), size: item.size
    }));
    const tree = parser._buildFileTree(normalizedFlat);
    const nextWriteBuffer = lfsOutsideSegments(image.writeBuffer, start, end);
    const physicalSectorSize = 0x1000;
    for (let offset = 0; offset < stage.length; offset += physicalSectorSize) {
        const sectorEnd = Math.min(stage.length, offset + physicalSectorSize);
        const nextSector = stage.subarray(offset, sectorEnd);
        const baseSector = physicalBaseline.subarray(offset, sectorEnd);
        if (!lfsBytesEqual(nextSector, baseSector)) {
            nextWriteBuffer.push({
                address: start + offset,
                data: nextSector.slice()
            });
        }
    }
    nextWriteBuffer.sort((left, right) => left.address - right.address);
    const currentBytes = image._materializeRange(start, end);
    if (!lfsBytesEqual(currentBytes, baseline)) {
        throw new Error('LFS_CONFLICT: source changed during verification; transaction discarded');
    }
    transaction?.assertCurrent();
    // No await and no user callbacks between publishing bytes and invalidating parser caches.
    image.writeBuffer = nextWriteBuffer;
    for (const peer of LFS_IMAGE_PARSERS.get(image) || [parser]) {
        if (peer.startOffset !== parser.startOffset || peer.size !== parser.size) continue;
        peer.fs._dirCache.clear();
        peer.fs.rootPair = mounted.rootPair.slice();
        peer.flatFiles = normalizedFlat;
        peer.files = tree;
        peer.deletedPaths.delete(path);
        peer.virtualFiles.delete(path);
        peer.fsInfo = { valid: true, rootPair: mounted.rootPair,
            superblock: mounted.superblock, filesCount: normalizedFlat.length,
            files: tree, flatFiles: normalizedFlat };
        peer.littlefsInfo = peer.fsInfo;
    }
    return { success: true, path, bytesWritten: data?.length || 0, deleted: data === null,
        persisted: false, imageOnly: true, verified: true,
        createdViaMetadata: !!result.created,
        replacedViaMetadata: data !== null && !result.created,
        deletedViaMetadata: data === null, wipedOldCtz: false, oldBytesWiped: 0,
        allocatedBlocks: writer.allocated.length, changedBlocks: writer.changedBlocks.size,
        ...result };
}

/**
 * Serialize mutations across every parser of the same image.
 * @param {LittleFSParser} parser @param {string} path
 * @param {Uint8Array|null} data @param {Uint8Array} [expectedBytes]
 * @param {{allowCreate?: boolean}} [options={}]
 * @returns {Promise<MutationResult>}
 */
async function lfsQueueMutation(parser, path, data, expectedBytes, options = {}) {
    const image = parser.sparseImage;
    let transaction;
    try { transaction = image.beginMutation?.(); }
    catch (error) { return { success: false, path, imageUnchanged: true, error: String(error?.message || error) }; }
    const previous = LFS_IMAGE_LOCKS.get(image) || Promise.resolve();
    const payload = data === null ? null : data.slice();
    const expected = expectedBytes === undefined ? undefined : expectedBytes.slice();
    const mutationOptions = { ...options };
    const run = () => lfsMutateImage(parser, path, payload, expected, mutationOptions, transaction);
    const current = previous.then(run, run);
    LFS_IMAGE_LOCKS.set(image, current.catch(() => {}));
    try {
        return await current;
    } catch (error) {
        return { success: false, path, imageUnchanged: true,
            error: String(error?.message || error) };
    } finally {
        transaction?.release();
    }
}


    class LittleFS {

        /**
         * Configure the storage adapter, filesystem geometry, and directory cache.
         * @param {ByteStorage} storage
         * @param {LittleFsOptions} [options={}]
         */
        constructor(storage, options = {}) {
            this.storage = storage;
            this.blockSize = options.blockSize || 0x1000;
            this.blockCount = options.blockCount || 0;
            this.fsOffset = options.fsOffset || 0;
            this.rootPair = [0, 1];
            this._dirCache = new Map();
        }

        /**
         * Format a metadata block pair as a cache key.
         * @param {BlockPair} pair
         * @returns {string}
         */
        _pairKey(pair) {
            return `${pair[0]},${pair[1]}`;
        }

        /**
         * Read an absolute byte range from the storage adapter.
         * @param {number} absOffset
         * @param {number} size
         * @returns {Promise<Uint8Array>}
         */
        async _readBytes(absOffset, size) {
            return this.storage.read(absOffset, size);
        }

        /**
         * Read bytes relative to the configured filesystem offset.
         * @param {number} fsOffset
         * @param {number} size
         * @returns {Promise<Uint8Array>}
         */
        async _readFsBytes(fsOffset, size) {
            return this._readBytes(this.fsOffset + fsOffset, size);
        }

        /** @param {number} block @param {number} off @param {number} size */
        async _readBlock(block, off, size) {
            if (!Number.isInteger(block) || block < 0 || (this.blockCount && block >= this.blockCount) ||
                off < 0 || size < 0 || off + size > this.blockSize) {
                throw new Error('LFS_CORRUPT: block read outside filesystem geometry');
            }
            return this._readFsBytes(block * this.blockSize + off, size);
        }

        /**
         * Read one unsigned little-endian word from a filesystem block.
         * @param {number} block
         * @param {number} off
         * @returns {Promise<number>}
         */
        async _readLe32Block(block, off) {
            const wordBytes = await this._readBlock(block, off, 4);
            return fromLe32At(wordBytes, 0);
        }

        /**
         * Replay raw live tags through the same explicit name/structure/attribute precedence rules.
         * @param {MetadataTag[]} tags @returns {object}
         */
        _replayDirectoryTags(tags) {
            const model = lfsReplayLiveMetadata(tags);
            const entries = model.entries.map(live => {
                const structure = live.structure;
                const data = structure?.data;
                const type = structure?.type;
                return {
                    name: live.name ? utf8Decode(live.name.data) : null,
                    type: live.name?.type ?? null,
                    structType: type ?? null,
                    inlineData: type === LFS_TYPE_INLINESTRUCT ? data.slice() : null,
                    ctzHead: type === LFS_TYPE_CTZSTRUCT && data.length >= 8 ? fromLe32At(data, 0) : null,
                    ctzSize: type === LFS_TYPE_CTZSTRUCT && data.length >= 8 ? fromLe32At(data, 4) : null,
                    dirPair: type === LFS_TYPE_DIRSTRUCT && data.length >= 8 ?
                        [fromLe32At(data, 0), fromLe32At(data, 4)] : null
                };
            });
            const tail = model.tail?.data.length >= 8 ?
                [fromLe32At(model.tail.data, 0), fromLe32At(model.tail.data, 4)] :
                [LFS_NULL_BLOCK, LFS_NULL_BLOCK];
            return { entries, tail, split: model.tail?.type === 0x601 };
        }

        /**
         * Decode XOR-linked tags and retain the last CRC-validated metadata state.
         * @param {number} block
         * @returns {Promise<MetadataBlock>}
         */
        async _parseMetadataBlock(block) {
            const raw = await this._readBlock(block, 0, this.blockSize);
            const revision = fromLe32At(raw, 0);
            let offset = 4;
            let previousTag = 0xffffffff;
            let crc = crc32Update(0xffffffff, raw, 0, 4);
            let maybeErased = false;
            let bestCommitOff = 0;
            let bestCommitPtag = previousTag;
            const validTags = [];
            let currentCommitTags = [];
            while (offset + 4 <= raw.length) {
                const rawTagBytes = raw.subarray(offset, offset + 4);
                const encodedTag = fromBe32At(rawTagBytes, 0);
                const tag = toUint32(encodedTag ^ previousTag);
                if (!lfsTagIsValid(tag)) {
                    maybeErased = (lfsTagType2(previousTag) === 0x500);
                    break;
                }
                const entrySize = lfsTagDSize(tag);
                if (offset + entrySize > raw.length) {
                    break;
                }
                crc = crc32Update(crc, raw, offset, 4);
                const dataStart = offset + 4;
                const dataLength = entrySize - 4;
                const data = raw.subarray(dataStart, dataStart + dataLength);
                if (lfsTagType2(tag) === 0x500) {
                    if (data.length < 4) {
                        break;
                    }
                    const storedCrc = fromLe32At(data, 0);
                    if (crc !== storedCrc) {
                        break;
                    }
                    validTags.length = 0;
                    for (let i = 0; i < currentCommitTags.length; i++) {
                        validTags.push(currentCommitTags[i]);
                    }
                    bestCommitOff = offset + entrySize;
                    previousTag = tag;
                    previousTag = toUint32(previousTag ^ (((lfsTagChunk(tag) & 1) << 31) >>> 0));
                    bestCommitPtag = previousTag;
                    crc = 0xffffffff;
                    offset += entrySize;
                    continue;
                }
                if (dataLength > 0) {
                    crc = crc32Update(crc, raw, dataStart, dataLength);
                }
                currentCommitTags.push({
                    tag,
                    data: data.slice()
                });
                previousTag = tag;
                offset += entrySize;
            }
            if (bestCommitOff === 0 && !maybeErased) {
                return {
                    valid: false,
                    rev: revision,
                    tags: [],
                    entries: [],
                    tail: [0xffffffff, 0xffffffff],
                    split: false,
                    off: 0,
                    etag: 0xffffffff
                };
            }
            const replay = this._replayDirectoryTags(validTags);
            return {
                valid: true,
                rev: revision,
                tags: validTags,
                entries: replay.entries,
                tail: replay.tail,
                split: replay.split,
                off: bestCommitOff,
                etag: bestCommitPtag
            };
        }

        /**
         * Compare revision counters using signed-32-bit subtraction.
         * @param {number} a
         * @param {number} b
         * @returns {number}
         */
        static _scmp(a, b) {
            return ((a - b) | 0);
        }

        /**
         * Select and cache a valid metadata pair member using revision and committed offset.
         * @param {BlockPair} pair
         * @returns {Promise<DirectoryState>}
         */
        async _fetchDir(pair) {
            const key = this._pairKey(pair);
            if (this._dirCache.has(key)) {
                return this._dirCache.get(key);
            }
            const firstBlock = await this._parseMetadataBlock(pair[0]);
            const secondBlock = await this._parseMetadataBlock(pair[1]);
            let chosen;
            if (firstBlock.valid && secondBlock.valid) {
                const revisionOrder = LittleFS._scmp(firstBlock.rev, secondBlock.rev);
                if (revisionOrder > 0) {
                    chosen = firstBlock;
                }
                else if (revisionOrder < 0) {
                    chosen = secondBlock;
                }
                else {
                    if (firstBlock.off > secondBlock.off) {
                        chosen = firstBlock;
                    }
                    else if (secondBlock.off > firstBlock.off) {
                        chosen = secondBlock;
                    }
                    else {
                        chosen = firstBlock;
                    }
                }
            }
            else if (firstBlock.valid) {
                chosen = firstBlock;
            }
            else if (secondBlock.valid) {
                chosen = secondBlock;
            }
            else {
                throw new Error(`Invalid metadata pair ${pair[0]},${pair[1]}`);
            }
            const directory = {
                pair: [chosen === firstBlock ? pair[0] : pair[1], chosen === firstBlock
                    ? pair[1] : pair[0]],
                rev: chosen.rev,
                entries: chosen.entries,
                count: chosen.entries.length,
                tail: chosen.tail,
                split: chosen.split
            };
            this._dirCache.set(key, directory);
            return directory;
        }

        /**
         * Find the first entry with the requested name and return its slot identifier.
         * @param {DirectoryState} dir
         * @param {string} name
         * @returns {EntryMatch|null}
         */
        _findEntryInDir(dir, name) {
            for (let i = 0; i < dir.entries.length; i++) {
                const entry = dir.entries[i];
                if (entry && entry.name === name) {
                    return { id: i, entry: entry };
                }
            }
            return null;
        }

        /**
         * Traverse metadata pairs, locate the superblock, and adopt its root and geometry.
         * @returns {Promise<MountResult>}
         */
        async mount() {
            let cursorPair = [0, 1];
            const visited = new Set();
            let foundAny = false;
            let lastSuperRoot = null;
            let superblock = null;
            while (cursorPair[0] !== 0xffffffff && cursorPair[1] !== 0xffffffff) {
                const visitKey = [...cursorPair].sort((a, b) => a - b).join(',');
                if (visited.has(visitKey)) throw new Error('LFS_CORRUPT: global tail cycle');
                visited.add(visitKey);
                const directory = await this._fetchDir(cursorPair);
                for (let i = 0; i < directory.entries.length; i++) {
                    const entry = directory.entries[i];
                    if (!entry || !entry.name) {
                        continue;
                    }
                    if (entry.type === LFS_TYPE_SUPERBLOCK && entry.name === 'littlefs') {
                        foundAny = true;
                        lastSuperRoot = directory.pair.slice();
                        if (entry.structType === LFS_TYPE_INLINESTRUCT && entry.inlineData
                            && entry.inlineData.length >= 24) {
                            superblock = {
                                version: fromLe32At(entry.inlineData, 0),
                                blockSize: fromLe32At(entry.inlineData, 4),
                                blockCount: fromLe32At(entry.inlineData, 8),
                                nameMax: fromLe32At(entry.inlineData, 12),
                                fileMax: fromLe32At(entry.inlineData, 16),
                                attrMax: fromLe32At(entry.inlineData, 20)
                            };
                        }
                    }
                }
                if (!directory.tail || directory.tail[0] === 0xffffffff
                    || directory.tail[1] === 0xffffffff) {
                    break;
                }
                cursorPair = directory.tail.slice();
            }
            if (!foundAny || !lastSuperRoot) {
                throw new Error('No littlefs superblock found');
            }
            this.rootPair = lastSuperRoot;
            if (superblock) {
                this.blockSize = superblock.blockSize;
                this.blockCount = superblock.blockCount;
            }
            this._dirCache.clear();
            return {
                rootPair: this.rootPair.slice(),
                superblock: superblock
            };
        }

        /** @param {string} path @returns {Promise<ResolvedPath|null>} */
        async _resolvePath(path) {
            const full = normalizePath(path);
            if (full === '/') {
                const rootDir = await this._fetchDir(this.rootPair);
                return { parentDir: null, dir: rootDir, name: '/',
                    entry: { type: LFS_TYPE_DIR, dirPair: this.rootPair.slice(),
                        structType: LFS_TYPE_DIRSTRUCT }, id: 0x3ff };
            }
            const parts = full.split('/').filter(Boolean);
            let pair = this.rootPair;
            for (let index = 0; index < parts.length; index++) {
                const found = await this._findEntryAcrossPairs(pair, parts[index]);
                if (!found) return null;
                if (index === parts.length - 1) {
                    return { parentDir: found.dir, dir: found.dir, name: parts[index],
                        entry: found.entry, id: found.id };
                }
                if (found.entry.type !== LFS_TYPE_DIR || !found.entry.dirPair) return null;
                pair = found.entry.dirPair;
            }
            return null;
        }

        /**
         * Map a byte position to its CTZ block index and within-block offset.
         * @param {number} size
         * @param {number} blockSize
         * @returns {CtzIndex}
         */
        _ctzIndex(size, blockSize) {
            const payloadCapacity = blockSize - 8;
            let blockIndex = Math.floor(size / payloadCapacity);
            if (blockIndex === 0) {
                return { index: 0, off: size };
            }
            blockIndex = Math.floor((size - 4 * (popcount32((blockIndex - 1) >>> 0)
                + 2)) / payloadCapacity);
            const blockOffset = size - (payloadCapacity * blockIndex) - (4 * popcount32(
                blockIndex >>> 0));
            return { index: blockIndex, off: blockOffset };
        }

        /**
         * Follow CTZ skip pointers to locate the requested file byte.
         * @param {number} head
         * @param {number} fileSize
         * @param {number} pos
         * @returns {Promise<BlockLocation>}
         */
        async _ctzFind(head, fileSize, pos) {
            if (fileSize === 0) {
                return { block: 0xffffffff, off: 0 };
            }
            let current = this._ctzIndex(fileSize - 1, this.blockSize).index;
            const targetInfo = this._ctzIndex(pos, this.blockSize);
            const target = targetInfo.index;
            let blockOffset = targetInfo.off;
            while (current > target) {
                const delta = (current - target + 1) >>> 0;
                const skip = Math.min(npw2(delta) - 1, ctz32(current >>> 0));
                head = await this._readLe32Block(head, 4 * skip);
                current -= (1 << skip);
            }
            return { block: head >>> 0, off: blockOffset };
        }

        /**
         * Read an existing regular file from inline metadata or CTZ data blocks.
         * @param {string} path
         * @returns {Promise<Uint8Array>}
         */
        async readFile(path) {
            const resolved = await this._resolvePath(path);
            if (!resolved) {
                throw new Error(`Path not found: ${path}`);
            }
            const entry = resolved.entry;
            if (entry.type !== LFS_TYPE_REG) {
                throw new Error(`Not a file: ${path}`);
            }
            if (entry.structType === LFS_TYPE_INLINESTRUCT) {
                return entry.inlineData ? entry.inlineData.slice() : new Uint8Array(0);
            }
            if (entry.structType !== LFS_TYPE_CTZSTRUCT) {
                return new Uint8Array(0);
            }
            const contents = new Uint8Array(entry.ctzSize >>> 0);
            let position = 0;
            let block = 0xffffffff;
            let blockOffset = this.blockSize;
            while (position < contents.length) {
                if (blockOffset === this.blockSize) {
                    const location = await this._ctzFind(entry.ctzHead >>> 0, entry.ctzSize >>> 0,
                        position >>> 0);
                    block = location.block;
                    blockOffset = location.off;
                }
                const chunkSize = Math.min(contents.length - position,
                    this.blockSize - blockOffset);
                const chunk = await this._readBlock(block, blockOffset, chunkSize);
                contents.set(chunk, position);
                position += chunkSize;
                blockOffset += chunkSize;
            }
            return contents;
        }

        /** @param {string} [path='/'] @returns {Promise<DirectoryItem[]>} */
        async listDir(path = '/') {
            const resolved = await this._resolvePath(path);
            if (!resolved) throw new Error(`Path not found: ${path}`);
            if (resolved.entry.type !== LFS_TYPE_DIR || !resolved.entry.dirPair) {
                throw new Error(`Not a directory: ${path}`);
            }
            const result = [];
            const visited = new Set();
            let pair = resolved.entry.dirPair;
            while (pair) {
                const key = [...pair].sort((left, right) => left - right).join(',');
                if (visited.has(key)) throw new Error('LFS_CORRUPT: split directory cycle');
                visited.add(key);
                const dir = await this._fetchDir(pair);
                for (const entry of dir.entries) {
                    if (!entry?.name) continue;
                    result.push({ name: entry.name, type: entry.type,
                        size: entry.structType === LFS_TYPE_CTZSTRUCT ? entry.ctzSize >>> 0 :
                            entry.structType === LFS_TYPE_INLINESTRUCT ? entry.inlineData?.length || 0 : 0 });
                }
                pair = dir.split ? dir.tail : null;
            }
            return result.sort((left, right) => left.name.localeCompare(right.name));
        }

        /**
         * Walk directories iteratively, including hard-tail fragments and detecting graph cycles.
         * @param {BlockPair} pair @param {string} base @param {EntryVisitor} cb
         * @returns {Promise<void>}
         */
        async _walkDir(pair, base, cb) {
            const pending = [{ pair, base }];
            const visited = new Set();
            while (pending.length) {
                const item = pending.pop();
                const key = [...item.pair].sort((left, right) => left - right).join(',');
                if (visited.has(key)) throw new Error('LFS_CORRUPT: directory graph cycle');
                visited.add(key);
                const directory = await this._fetchDir(item.pair);
                if (directory.split) pending.push({ pair: directory.tail, base: item.base });
                const children = [];
                for (const entry of directory.entries) {
                    if (!entry?.name) continue;
                    const path = (item.base === '/' ? '' : item.base) + '/' + entry.name;
                    await cb(path, entry);
                    if (entry.type === LFS_TYPE_DIR && entry.dirPair) {
                        children.push({ pair: entry.dirPair, base: path });
                    }
                }
                pending.push(...children.reverse());
            }
        }

        /**
         * Collect and sort all named entries reachable from the root.
         * @returns {Promise<FlatEntry[]>}
         */
        async listAll() {
            const out = [];
            await this._walkDir(this.rootPair, '/', async (path, e) => {
                out.push({
                    path,
                    type: e.type,
                    size: e.structType === LFS_TYPE_CTZSTRUCT
                        ? (e.ctzSize >>> 0) : (e.structType === LFS_TYPE_INLINESTRUCT
                        && e.inlineData ? e.inlineData.length : 0)
                });
            });
            out.sort((a, b) => a.path.localeCompare(b.path));
            return out;
        }

        /**
         * Create directories and write regular files through the supplied target adapter.
         * @param {ExtractionTarget} targetFs
         * @param {string} outDir
         * @returns {Promise<FlatEntry[]>}
         */
        async extractAll(targetFs, outDir) {
            const all = await this.listAll();
            for (const item of all) {
                const relativePath = item.path.startsWith('/') ? item.path.slice(1) : item.path;
                const destinationPath = targetFs.join(outDir, relativePath);
                if (item.type === LFS_TYPE_DIR) {
                    await targetFs.mkdirp(destinationPath);
                }
                else if (item.type === LFS_TYPE_REG) {
                    await targetFs.mkdirp(targetFs.dirname(destinationPath));
                    const data = await this.readFile(item.path);
                    await targetFs.writeFile(destinationPath, data);
                }
            }
            return all;
        }
    
        /**
         * Follow hard tails within a directory, returning the exact pair that owns a matched entry.
         * @param {BlockPair} pair @param {string} name @returns {Promise<object|null>}
         */
        async _findEntryAcrossPairs(pair, name) {
            const visited = new Set();
            while (pair) {
                const key = [...pair].sort((left, right) => left - right).join(',');
                if (visited.has(key)) throw new Error('LFS_CORRUPT: split directory cycle');
                visited.add(key);
                const dir = await this._fetchDir(pair);
                const found = this._findEntryInDir(dir, name);
                if (found) return { ...found, dir };
                pair = dir.split ? dir.tail : null;
            }
            return null;
        }
}
    class LittleFSParser {

        /**
         * Configure an image partition and initialize parser and overlay metadata.
         * @param {SparseImage} sparseImage
         * @param {number} startOffset
         * @param {number} size
         */
        constructor(sparseImage, startOffset, size) {
            if (!sparseImage) {
                throw new Error('LittleFSParser requires a SparseImage');
            }
            this.sparseImage = sparseImage;
            this.startOffset = startOffset || 0;
            this.size = size || (sparseImage.size - this.startOffset);
            this.buffer = sparseImage;
            this.view = null;
            this.fs = null;
            this.fsInfo = null;
            this.littlefsInfo = null;
            this.files = [];
            this.flatFiles = [];
            this.deletedPaths = new Set();
            this.virtualFiles = new Map();

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
         * Initialize the parser through its existing parse entry point.
         * @returns {Promise<FilesystemInfo>}
         */
        async initialize() {
            return this.parse();
        }

        /**
         * Mount the image partition and rebuild filesystem information and file listings.
         * @returns {Promise<FilesystemInfo>}
         */
        async parse() {
            const partitionStart = this.startOffset;
            const partitionEnd = this.startOffset + this.size;
            const sparse = this.sparseImage;
            const storage = {

                /**
                 * Read bytes through the existing bounded or prefetched storage adapter.
                 * @param {number} absOffset
                 * @param {number} size
                 * @returns {Promise<Uint8Array>}
                 */
                async read(absOffset, size) {
                    const out = new Uint8Array(size);
                    out.fill(0xFF);
                    const reqStart = absOffset;
                    const reqEnd = absOffset + size;
                    const readStart = Math.max(reqStart, partitionStart);
                    const readEnd = Math.min(reqEnd, partitionEnd);
                    if (readEnd <= readStart) {
                        return out;
                    }
                    const localStart = readStart - reqStart;
                    const readSize = readEnd - readStart;
                    const chunk = await sparse.subarray_async(readStart, readStart + readSize);
                    out.set(chunk, localStart);
                    return out;
                }
            };
            this.fs = new LittleFS(storage, {
                fsOffset: this.startOffset,
                blockSize: 0x1000,
                blockCount: Math.floor(this.size / 0x1000)
            });
            const mounted = await this.fs.mount();
            this.flatFiles = await this._listFilesFlat();
            this.files = this._buildFileTree(this.flatFiles);
            this.fsInfo = {
                valid: true,
                rootPair: mounted.rootPair,
                superblock: mounted.superblock,
                filesCount: this.flatFiles.length,
                files: this.files,
                flatFiles: this.flatFiles
            };
            this.littlefsInfo = this.fsInfo;
            lfsRegisterParser(this);
            return this.fsInfo;
        }

        /**
         * Normalize mounted entries into the file-manager metadata schema.
         * @returns {Promise<FileNode[]>}
         */
        async _listFilesFlat() {
            if (!this.fs) {
                throw new Error('LittleFSParser not initialized');
            }
            const flat = await this.fs.listAll();
            return flat.map((item) => {
                const normalized = normalizePath(item.path);
                const parts = normalized.split('/').filter(Boolean);
                const name = parts.length ? parts[parts.length - 1] : '/';
                const itemType = typeof item.type === 'string'
                    ? item.type.toLowerCase() : item.type;
                const isDirectory = item && (item.isDirectory === true ||
                    itemType === LFS_TYPE_DIR ||
                    itemType === 'dir' ||
                    itemType === 'directory' ||
                    normalized === '/');
                return {
                    name,
                    path: normalized,
                    size: item.size >>> 0,
                    isDirectory,
                    type: isDirectory ? 'dir' : 'file',
                    attributes: isDirectory ? ['Directory'] : ['Archive'],
                    date: '',
                    time: ''
                };
            });
        }

        /**
         * Normalize the supported byte-buffer, text, or number-array input shapes.
         * @param {Uint8Array|ArrayBuffer|string|number[]} data
         * @returns {Uint8Array}
         */
        _toUint8Array(data) {
            if (data instanceof Uint8Array) {
                return data;
            }
            if (data instanceof ArrayBuffer) {
                return new Uint8Array(data);
            }
            if (typeof data === 'string') {
                if (typeof TextEncoder !== 'undefined') {
                    return new TextEncoder().encode(data);
                }
                const bytes = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    bytes[i] = data.charCodeAt(i) & 0xFF;
                }
                return bytes;
            }
            if (Array.isArray(data)) {
                return Uint8Array.from(data);
            }
            throw new Error(
                'Unsupported data type, expected Uint8Array/ArrayBuffer/string/number[]');
        }

        /**
         * Encode a word as four big-endian bytes.
         * @param {number} v
         * @returns {Uint8Array}
         */
        _be32Bytes(v) {
            const out = new Uint8Array(4);
            out[0] = (v >>> 24) & 0xFF;
            out[1] = (v >>> 16) & 0xFF;
            out[2] = (v >>> 8) & 0xFF;
            out[3] = v & 0xFF;
            return out;
        }

        /**
         * Encode a word as four little-endian bytes.
         * @param {number} v
         * @returns {Uint8Array}
         */
        _le32Bytes(v) {
            const out = new Uint8Array(4);
            out[0] = v & 0xFF;
            out[1] = (v >>> 8) & 0xFF;
            out[2] = (v >>> 16) & 0xFF;
            out[3] = (v >>> 24) & 0xFF;
            return out;
        }

        /**
         * Encode UTF-8 when available, retaining the original low-byte fallback.
         * @param {string} text
         * @returns {Uint8Array}
         */
        _encodeUtf8(text) {
            if (typeof TextEncoder !== 'undefined') {
                return new TextEncoder().encode(text);
            }
            const out = new Uint8Array(text.length);
            for (let i = 0; i < text.length; i++) {
                out[i] = text.charCodeAt(i) & 0xFF;
            }
            return out;
        }

        /**
         * Return the parent of a normalized path, using / for root-level entries.
         * @param {string} path
         * @returns {string}
         */
        _dirname(path) {
            const normalized = normalizePath(path);
            if (normalized === '/') {
                return '/';
            }
            const separatorIndex = normalized.lastIndexOf('/');
            if (separatorIndex <= 0) {
                return '/';
            }
            return normalized.slice(0, separatorIndex);
        }

        /**
         * Return the last component of a normalized path.
         * @param {string} path
         * @returns {string}
         */
        _basename(path) {
            const normalized = normalizePath(path);
            const separatorIndex = normalized.lastIndexOf('/');
            if (separatorIndex < 0) {
                return normalized;
            }
            return normalized.slice(separatorIndex + 1);
        }

        /**
         * Raw append is no longer a supported mutation entry point. Use writeFile/deleteFile.
         * @param {number} dirBlock @param {number} ptagStart @param {number} commitStartOff
         * @param {MetadataTag[]} tagItems @returns {Promise<void>}
         */
        async _appendDirCommit(dirBlock, ptagStart, commitStartOff, tagItems) {
            throw new Error('LFS_TRANSACTION_REQUIRED: raw metadata appends are disabled');
        }

        /**
         * Retain the former helper signature without erasing still-referenced CTZ blocks.
         * @param {DirectoryEntry} entry @returns {Promise<object>}
         */
        async _wipeCtzData(entry) {
            return { wiped: false, bytesWiped: 0 };
        }

        /**
         * Compatibility entry point; replacement now uses staged CTZ/metadata allocation.
         * @param {string} path @param {Uint8Array} bytes @param {ResolvedPath} resolved
         * @returns {Promise<MutationResult>}
         */
        async _replaceViaMetadataCommit(path, bytes, resolved) {
            return lfsQueueMutation(this, normalizePath(path), bytes);
        }

        /**
         * Build file-manager metadata for an overlay entry.
         * @param {string} path
         * @param {Uint8Array|null} data
         * @param {boolean} [isDirectory=false]
         * @returns {FileNode}
         */
        _makeFileNode(path, data, isDirectory = false) {
            const normalized = normalizePath(path);
            const parts = normalized.split('/').filter(Boolean);
            const name = parts.length ? parts[parts.length - 1] : '/';
            return {
                name,
                path: normalized,
                size: isDirectory ? 0 : (data ? data.length >>> 0 : 0),
                isDirectory,
                type: isDirectory ? 'dir' : 'file',
                attributes: isDirectory ? ['Directory'] : ['Archive'],
                date: '',
                time: ''
            };
        }

        /**
         * Filter deleted paths, append virtual entries, and sort using the original overlay rules.
         * @param {FileNode[]} baseFlat
         * @returns {FileNode[]}
         */
        _mergeOverlay(baseFlat) {
            const files = [];
            for (const file of baseFlat) {
                if (this.deletedPaths.has(file.path)) {
                    continue;
                }
                files.push(file);
            }
            for (const [path, vf] of this.virtualFiles.entries()) {
                if (this.deletedPaths.has(path)) {
                    continue;
                }
                files.push(this._makeFileNode(path, vf.data, vf.isDirectory));
            }
            files.sort((a, b) => a.path.localeCompare(b.path));
            return files;
        }

        /**
         * Attach entries to known directory parents and sort each level by path.
         * @param {FileNode[]} flatFiles
         * @returns {FileNode[]}
         */
        _buildFileTree(flatFiles) {
            const byPath = new Map();
            const roots = [];
            for (const file of flatFiles) {
                byPath.set(file.path, {
                    ...file,
                    children: file.isDirectory ? [] : undefined
                });
            }
            for (const node of byPath.values()) {
                const parentPath = node.path.includes('/') ? node.path.substring(0,
                    node.path.lastIndexOf('/')) : '';
                const normalizedParent = parentPath || '/';
                if (node.path === '/' || normalizedParent === '/'
                    || !byPath.has(normalizedParent)) {
                    roots.push(node);
                    continue;
                }
                const parent = byPath.get(normalizedParent);
                if (parent && parent.children) {
                    parent.children.push(node);
                }
                else {
                    roots.push(node);
                }
            }

            /**
             * Sort each file-tree level by path in place.
             * @param {FileNode[]} arr
             * @returns {void}
             */
            const sortRecursive = (arr) => {
                arr.sort((a, b) => a.path.localeCompare(b.path));
                for (const n of arr) {
                    if (n.children) {
                        sortRecursive(n.children);
                    }
                }
            };
            sortRecursive(roots);
            return roots;
        }

        /**
         * Refresh both flat and hierarchical listings from mounted entries and overlays.
         * @returns {Promise<FileNode[]>}
         */
        async listFiles() {
            if (!this.fs) {
                throw new Error('LittleFSParser not initialized');
            }
            const baseFlat = await this._listFilesFlat();
            this.flatFiles = this._mergeOverlay(baseFlat);
            this.files = this._buildFileTree(this.flatFiles);
            return this.files;
        }

        /**
         * Search the file tree first and the flat listing second for a normalized path.
         * @param {string} targetPath
         * @returns {FileNode|null}
         */
        findFileByPath(targetPath) {
            const normalized = normalizePath(targetPath);

            /**
             * Search the current file-tree branch for the normalized target path.
             * @param {FileNode[]|null} files
             * @returns {FileNode|null}
             */
            const searchRecursive = (files) => {
                if (!files) {
                    return null;
                }
                for (const file of files) {
                    if (file.path === normalized) {
                        return file;
                    }
                    if (file.children) {
                        const found = searchRecursive(file.children);
                        if (found) {
                            return found;
                        }
                    }
                }
                return null;
            };
            const found = searchRecursive(this.files || []);
            if (found) {
                return found;
            }
            for (const file of this.flatFiles || []) {
                if (file.path === normalized) {
                    return file;
                }
            }
            return null;
        }

        /**
         * Resolve a path or entry and read its virtual overlay or mounted-file bytes.
         * @param {FileReference} pathOrEntry
         * @returns {Promise<Uint8Array>}
         */
        async readFile(pathOrEntry) {
            if (!this.fs) {
                throw new Error('LittleFSParser not initialized');
            }
            const path = typeof pathOrEntry === 'string' ? pathOrEntry : (pathOrEntry
                && pathOrEntry.path);
            if (!path) {
                throw new Error('readFile requires a path or file entry');
            }
            const normalized = normalizePath(path);
            if (this.deletedPaths.has(normalized)) {
                throw new Error(`Path not found: ${normalized}`);
            }
            if (this.virtualFiles.has(normalized)) {
                return this.virtualFiles.get(normalized).data.slice();
            }
            return this.fs.readFile(normalized);
        }

        /**
         * Wrap the selected file bytes in a downloadable binary Blob.
         * @param {FileReference} fileEntry
         * @returns {Promise<Blob>}
         */
        async extractFile(fileEntry) {
            const data = await this.readFile(fileEntry);
            return new Blob([data], { type: 'application/octet-stream' });
        }

        /**
         * Replace an existing file without an inline-size limit, preserving the external signature.
         * @param {FileReference} pathOrEntry
         * @param {Uint8Array|ArrayBuffer|string|number[]} data
         * @returns {Promise<MutationResult>}
         */
        async writeFile(pathOrEntry, data) {
            if (!this.fs) return { success: false, error: 'LittleFSParser not initialized' };
            const path = typeof pathOrEntry === 'string' ? pathOrEntry : pathOrEntry?.path;
            if (!path) return { success: false, error: 'writeFile requires a path or file entry' };
            const normalized = normalizePath(path);
            if (this.virtualFiles.has(normalized)) {
                return { success: false, path: normalized, error: 'Reload image before editing overlays.' };
            }
            return lfsQueueMutation(this, normalized, this._toUint8Array(data));
        }

        /**
         * Add a new root-level regular file, or delegate to replacement if it already exists.
         * Creation uses the same private-snapshot verification and buffered sector publication
         * as other LittleFS mutations.
         * @param {string} path
         * @param {Uint8Array|ArrayBuffer|string|number[]} data
         * @returns {Promise<MutationResult>}
         */
        async addFile(path, data) {
            if (!this.fs) {
                return { success: false, error: 'LittleFSParser not initialized' };
            }
            const normalized = normalizePath(path);
            const bytes = this._toUint8Array(data);

            if (!/^\/[^/]+$/.test(normalized)) {
                return {
                    success: false,
                    path: normalized,
                    error: 'Persistent create currently supports root-level files only.'
                };
            }

            const existingVirtual = this.virtualFiles.get(normalized);
            if (existingVirtual) {
                return {
                    success: false,
                    error: 'Persistent-only mode: add on virtual overlay path is disabled.',
                    path: normalized
                };
            }
            if (this.deletedPaths.has(normalized)) {
                return {
                    success: false,
                    path: normalized,
                    error: 'Persistent-only mode: add for deleted overlay path is disabled.'
                };
            }

            const existing = await this.fs._resolvePath(normalized);
            if (existing && existing.entry && existing.entry.type === LFS_TYPE_REG) {
                return this.writeFile(normalized, bytes);
            }
            if (existing && existing.entry && existing.entry.type === LFS_TYPE_DIR) {
                return {
                    success: false, error: 'Path points to a directory', path: normalized
                };
            }

            return lfsQueueMutation(
                this,
                normalized,
                bytes,
                undefined,
                { allowCreate: true }
            );
        }

        /**
         * Delete a regular file in a verified private image; its obsolete blocks become reusable.
         * This is logical deletion, not secure erasure.
         * @param {FileReference} fileEntry @returns {Promise<MutationResult>}
         */
        async deleteFile(fileEntry) {
            if (!this.fs) return { success: false, error: 'LittleFSParser not initialized' };
            const path = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
            if (!path) return { success: false, error: 'deleteFile requires a path or file entry' };
            return lfsQueueMutation(this, normalizePath(path), null);
        }
    
        /**
         * Compare the current source file inside the image lock before replacing it.
         * @param {FileReference} pathOrEntry @param {BinaryInput} data
         * @param {Uint8Array} expectedBytes @returns {Promise<MutationResult>}
         */
        async writeFileChecked(pathOrEntry, data, expectedBytes) {
            if (!this.fs) return { success: false, error: 'LittleFSParser not initialized' };
            const path = typeof pathOrEntry === 'string' ? pathOrEntry : pathOrEntry?.path;
            if (!path) return { success: false, error: 'writeFileChecked requires a path or file entry' };
            return lfsQueueMutation(this, normalizePath(path), this._toUint8Array(data), expectedBytes);
        }
}

    /**
     * Publish the same browser/global and CommonJS exports.
     * @param {LittleFsExports} api
     * @returns {void}
     */
    function expose(api) {
        if (typeof module !== 'undefined' && module.exports) {
            module.exports = api;
        }
        globalScope.LittleFS = api.LittleFS;
        globalScope.LittleFSParser = api.LittleFSParser;
        globalScope.createNodeSparseImageReader = api.createNodeSparseImageReader;
    }

    /**
     * Open a Node file and adapt its reads and optional writes to SparseImage.
     * @param {string} inputPath
     * @param {typeof SparseImage|null|undefined} sparseImageCtor
     * @param {{writable?: boolean}} [options={}]
     * @returns {Promise<NodeImageReader>}
     */
    async function createNodeSparseImageReader(inputPath, sparseImageCtor, options = {}) {
        const fs = require('fs');
        const SparseImage = sparseImageCtor || globalScope.SparseImage;
        if (!SparseImage) {
            throw new Error(
                'createNodeSparseImageReader requires SparseImage constructor from caller');
        }
        const stat = await fs.promises.stat(inputPath);
        const writable = !!options.writable;
        const fd = await fs.promises.open(inputPath, writable ? 'r+' : 'r');
        const sparse = new SparseImage(stat.size, async (address, size) => {
            const buf = Buffer.alloc(size);
            const r = await fd.read(buf, 0, size, address);
            return new Uint8Array(buf.buffer, buf.byteOffset, r.bytesRead);
        }, writable ? async (address, data) => {
            const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            await fd.write(buf, 0, data.byteLength, address);
        } : null);
        return {
            size: stat.size,
            sparse,
            writable,

            /**
             * Read bytes through the existing bounded or prefetched storage adapter.
             * @param {number} offset
             * @param {number} size
             * @returns {Promise<Uint8Array>}
             */
            async read(offset, size) {
                await sparse.prefetch(offset, size);
                return sparse.subarray(offset, offset + size);
            },

            /**
             * Flush the wrapped sparse image when its flush method is available.
             * @returns {Promise<void>}
             */
            async flush() {
                if (typeof sparse.flush === 'function') {
                    await sparse.flush();
                }
            },

            /**
             * Flush writable buffered data, then close the underlying Node file handle.
             * @returns {Promise<void>}
             */
            async close() {
                if (writable && typeof sparse.flush === 'function') {
                    await sparse.flush();
                }
                await fd.close();
            }
        };
    }
    expose({
        LittleFS,
        LittleFSParser,
        createNodeSparseImageReader
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
if (typeof module !== 'undefined' && module.exports && require.main === module) {
    (async () => {
        const fs = require('fs');
        const path = require('path');
        const vm = require('vm');
        const { LittleFS, createNodeSparseImageReader } = module.exports;

        /**
         * Parse the existing decimal or 0x-prefixed command-line integer syntax.
         * @param {string|number} v
         * @returns {number}
         */
        function parseNum(v) {
            if (typeof v === 'number') {
                return v;
            }
            if (/^0x/i.test(v)) {
                return parseInt(v, 16);
            }
            return parseInt(v, 10);
        }
        const args = process.argv.slice(2);
        const opts = {
            flash: 'W25Q128BV@SOIC8.BIN',
            offset: 0x820000,
            out: 'extracted_littlefs_from_js'
        };
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '--flash' && i + 1 < args.length) {
                opts.flash = args[++i];
            }
            else if (a === '--offset' && i + 1 < args.length) {
                opts.offset = parseNum(args[++i]);
            }
            else if (a === '--out' && i + 1 < args.length) {
                opts.out = args[++i];
            }
        }
        const sparseCode = await fs.promises.readFile(path.resolve('SparseImage.js'), 'utf8');
        const sparseSandbox = {
            console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, setTimeout,
                clearTimeout
        };
        vm.createContext(sparseSandbox);
        vm.runInContext(`${sparseCode}\nthis.__SparseImage = SparseImage;`, sparseSandbox,
            { filename: 'SparseImage.js' });
        const SparseImageCtor = sparseSandbox.__SparseImage;
        if (!SparseImageCtor) {
            throw new Error('Failed to load SparseImage constructor');
        }
        const reader = await createNodeSparseImageReader(path.resolve(opts.flash), SparseImageCtor);
        try {
            const maxFsSize = reader.size - opts.offset;
            const lfs = new LittleFS(reader, {
                fsOffset: opts.offset,
                blockSize: 0x1000,
                blockCount: Math.floor(maxFsSize / 0x1000)
            });
            const mounted = await lfs.mount();
            console.log('Mounted littlefs root pair:', mounted.rootPair, 'superblock:',
                mounted.superblock);
            const targetFs = {
                join: path.join,
                dirname: path.dirname,

                /**
                 * Create an extraction directory and any missing parent directories.
                 * @param {string} p
                 * @returns {Promise<void>}
                 */
                async mkdirp(p) {
                    await fs.promises.mkdir(p, { recursive: true });
                },

                /**
                 * Write extracted bytes through the Node filesystem adapter.
                 * @param {string} p
                 * @param {Uint8Array} data
                 * @returns {Promise<void>}
                 */
                async writeFile(p, data) {
                    await fs.promises.writeFile(p, Buffer.from(data));
                }
            };
            const outDir = path.resolve(opts.out);
            await fs.promises.mkdir(outDir, { recursive: true });
            const all = await lfs.extractAll(targetFs, outDir);
            console.log('Extracted entries:', all.length);
            const certProbe = all.find((x) => x.path === '/cert/ca.der.crypt');
            const settingsProbe = all.find((x) => x.path === '/settings');
            console.log('Found /settings:', !!settingsProbe);
            console.log('Found /cert/ca.der.crypt:', !!certProbe);
            if (!settingsProbe || !certProbe) {
                process.exitCode = 2;
            }
        }
        finally {
            await reader.close();
        }
    })().catch((err) => {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    });
}
