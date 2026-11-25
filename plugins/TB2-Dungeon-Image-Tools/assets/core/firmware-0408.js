/** Diagnostic Image firmware reconstruction and builder. */
class Firmware0408 extends FirmwareImage {
    static CONTAINER_SIZE = 0x17F3C4;
    static CONTAINER_SHA = '990a95d7b5019860a9291f52235f4df031f1dc27248cc5cc0d86874cfcf28fbe';
    static TRAILER_SHA = '59ddef29c93dadffe9c962aadfa147f5a073507b295bd69ab53f471788feaa22';
    static SLOT_SHA = '132e887619fdc2c66b048b6f3c627d41a3572a55f967062ef5ee56f88af15259';
    static BOOT_SHA = 'f16e0e57399f2cb6bff03f3537ed313963a7d08a7e7ca9a54723b7bb05cd344c';
    static SOURCE_SHA = '25bdf056d42d075ee8f4f0c9a3e58366e053b829a48e38a8cb1f9f2cc05d8d7d';

    /** Preconfirmed full-image boot status; never written inside the signed container. */
    static confirmedTrailer() {
        const trailer = new Uint8Array(this.TRAILER_SIZE).fill(0xFF);
        trailer[0] = trailer[8] = 1;
        trailer.set(this.TRAILER_MAGIC.match(/../g).map(byte => parseInt(byte, 16)), 16);
        return trailer;
    }

    /** Pin the only firmware accepted by Diagnostic Image. */
    static templateDefinition() {
        return {start:this.PRIMARY, version:'0.40.8+0', containerSize:this.CONTAINER_SIZE,
            containerSha:this.CONTAINER_SHA, slotSha:this.SLOT_SHA};
    }

    /** Decode only the two allowlisted parts; the exact size prevents hidden extra regions. */
    static async decodeTemplate(compressed) {
        const definition = this.templateDefinition();
        if (!(compressed instanceof Uint8Array) || compressed.length > definition.containerSize + this.TRAILER_SIZE) throw new Error('Invalid compressed template size.');
        const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        const expected = definition.containerSize + this.TRAILER_SIZE, raw = new Uint8Array(expected);
        let offset = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (offset + value.length > expected) throw new Error('Template contains extra data.');
                raw.set(value, offset); offset += value.length;
            }
        } finally { await reader.cancel(); }
        if (offset !== expected) throw new Error('Template is truncated.');
        const container = raw.slice(0, definition.containerSize), trailer = raw.slice(definition.containerSize);
        if (await this.hash(container) !== definition.containerSha || await this.hash(trailer) !== this.TRAILER_SHA) throw new Error('Template integrity check failed.');
        const slot = new Uint8Array(this.SLOT_SIZE).fill(0xFF);
        slot.set(container); slot.set(trailer, this.SLOT_SIZE - 32);
        if (await this.hash(slot) !== definition.slotSha) throw new Error('Reconstructed diagnostic slot hash mismatch.');
        return slot;
    }

    /** Extract only the pinned primary container from a complete user-provided dump. */
    static async templateFromDump(dump) {
        const definition = this.templateDefinition();
        if (!(dump instanceof Uint8Array) || dump.length !== this.SIZE) throw new Error('A complete 16 MiB dump is required.');
        const firmware = await this.inspectSlot(dump, this.PRIMARY);
        if (!firmware.occupied || firmware.version !== definition.version ||
            firmware.length !== definition.containerSize) throw new Error('Dump has no supported 0.40.8 firmware in slot 0.');
        const container = dump.subarray(this.PRIMARY, this.PRIMARY + definition.containerSize);
        if (await this.hash(container) !== definition.containerSha) throw new Error('Diagnostic firmware integrity check failed.');
        const slot = new Uint8Array(this.SLOT_SIZE).fill(0xFF);
        slot.set(container);slot.set(this.confirmedTrailer(), this.SLOT_SIZE - this.TRAILER_SIZE);
        if (await this.hash(slot) !== definition.slotSha) throw new Error('Reconstructed diagnostic slot hash mismatch.');
        return slot;
    }

    /** Accept the existing compressed resource or a full dump from the local file picker. */
    static async template(bytes) {
        if (!(bytes instanceof Uint8Array)) throw new Error('Select a firmware file.');
        if (bytes.length === this.SIZE) return this.templateFromDump(bytes);
        if (bytes[0] === 0x1F && bytes[1] === 0x8B) return this.decodeTemplate(bytes);
        throw new Error('Select a complete 0.40.8 dump or its resource.bin.gz file.');
    }

    /** Discover aligned LittleFS regions outside signed containers and preserve them whole. */
    static regions(bytes, slots) {
        const regions = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const magic = [108,105,116,116,108,101,102,115];
        for (let start = this.PRIMARY; start < this.SIZE; start += 0x1000) {
            if (slots.some(slot => start >= slot.start && start < slot.end) || regions.some(r => start >= r[0] && start < r[1])) continue;
            if (!magic.every((byte, i) => bytes[start + 8 + i] === byte)) continue;
            const blockSize = view.getUint32(start + 24, true), count = view.getUint32(start + 28, true);
            const end = start + blockSize * count;
            if (blockSize !== 4096 || count < 2 || end > this.SIZE ||
                slots.some(slot => this.overlap([start, end], [slot.start, slot.end]))) throw new Error(`Unsupported LittleFS region at ${this.offset(start)}.`);
            regions.push([start, end]);
        }
        if (!regions.some(r => r[0] === this.LFS && r[1] === this.SIZE)) throw new Error('Expected target LittleFS was not found.');
        return regions;
    }

    /** Refuse unexplained programmed bytes rather than erase them as padding. */
    static inventory(bytes, slots, regions) {
        const allowed = [...regions, this.PROTECTED,
            ...slots.map(s => [s.start, s.end]),
            ...slots.map(s => [s.start + this.SLOT_SIZE - 32, s.start + this.SLOT_SIZE])];
        for (let at = this.PRIMARY; at < this.LFS;) {
            const known = allowed.find(r => at >= r[0] && at < r[1]);
            if (known) { at = known[1]; continue; }
            if (bytes[at] !== 0xFF) throw new Error(`Unclassified target data at ${this.offset(at)}; nothing was changed.`);
            at++;
        }
    }

    /** Pure candidate build; filesystem verification is supplied by the existing parser.
     * @param {Uint8Array} input @param {Uint8Array} slot @param {function(Uint8Array,number,number):Promise<string>} tree
     */
    static async build(input, slot, tree) {
        if (!(input instanceof Uint8Array) || input.length !== this.SIZE) throw new Error('A complete 16 MiB image is required.');
        if (slot.length !== this.SLOT_SIZE || await this.hash(slot) !== this.SLOT_SHA) throw new Error('Unverified template.');
        if (await this.hash(input.subarray(0, this.PRIMARY)) !== this.BOOT_SHA) throw new Error('Unsupported target bootloader; no transplant performed.');
        const slots = await Promise.all([this.inspectSlot(input, this.PRIMARY), this.inspectSlot(input, this.SECONDARY)]);
        if (slots.some(s => this.overlap([s.start,s.end], this.PROTECTED))) throw new Error('A signed target image overlaps the protected target sector.');
        const regions = this.regions(input, slots);
        if (regions.some(r => this.overlap(r, [this.PRIMARY, this.SECONDARY]))) throw new Error('Target filesystem collides with the replacement primary slot.');
        this.inventory(input, slots, regions);
        if (typeof tree !== 'function') throw new Error('Filesystem verifier unavailable.');
        const beforeTrees = await Promise.all(regions.map(r => tree(input, r[0], r[1] - r[0])));
        const output = input.slice();
        output.fill(0xFF, this.PRIMARY, this.LFS);
        output.set(slot, this.PRIMARY);
        const preserved = [[0,this.PRIMARY], ...regions, this.PROTECTED];
        for (const [start,end] of preserved) output.set(input.subarray(start,end), start);
        for (const [start,end] of preserved) {
            if (!this.equal(input.subarray(start,end), output.subarray(start,end))) throw new Error('Protected target data changed.');
        }
        if (await this.hash(output.subarray(this.PRIMARY,this.SECONDARY)) !== this.SLOT_SHA) throw new Error('Primary slot verification failed.');
        const primary = await this.inspectSlot(output,this.PRIMARY);
        if (primary.version !== '0.40.8+0' || primary.headerSize !== 0x400 || primary.payloadSize !== 0x17EDF4 || primary.resetPc !== 0x6002C2F1) throw new Error('Unexpected template firmware profile.');
        if ((await this.inspectSlot(output,this.SECONDARY)).occupied || !this.erased(output.subarray(this.LFS-32,this.LFS))) throw new Error('Secondary slot is still bootable.');
        const afterTrees = await Promise.all(regions.map(r => tree(output, r[0], r[1] - r[0])));
        if (beforeTrees.some((value,i) => value !== afterTrees[i])) throw new Error('Target file tree changed.');
        const allowedDiff = [[this.PRIMARY,this.LFS]];
        for (let at=0; at<this.SIZE; at++) {
            if (input[at] !== output[at] && (!allowedDiff.some(r=>at>=r[0]&&at<r[1]) || preserved.some(r=>at>=r[0]&&at<r[1]))) throw new Error('Unexpected image difference.');
        }
        await this.setProduction(output);
        return { bytes: output, report: { format: 'core-flasher-firmware-candidate-v1', version: '0.40.8+0',
            inputSha256: await this.hash(input), outputSha256: await this.hash(output), templateSlotSha256: this.SLOT_SHA,
            previousSlots: slots.map(s=>({ offset:this.offset(s.start), version:s.version })),
            allowedDiff: [...allowedDiff,[this.LFS,this.SIZE]].map(r=>r.map(v=>this.offset(v))), preserved: preserved.filter(r=>r[0]!==this.LFS).map(r=>r.map(v=>this.offset(v))),
            signature: 'present-not-cryptographically-verified', settings: 'lifecycle-production-other-records-preserved',
            lifecycle: {key:this.LIFECYCLE_KEY, value:this.PRODUCTION, verified:true},
            runtimeCompatibility: 'not-verified', hardware: 'not-tested' } };
    }

    /** Validate all records, then patch only the latest lifecycle value, preserving history. */
    static productionSettings(bytes) {
        let offset=0,lastValueOffset=-1;
        while(offset<bytes.length){
            if(offset+2>bytes.length)throw new Error('Truncated settings header.');
            const start=offset+2,end=start+(bytes[offset]|bytes[offset+1]<<8);
            if(end>bytes.length)throw new Error('Truncated settings record.');
            const separator=bytes.indexOf(0x3d,start);
            if(separator<start || separator>=end)throw new Error('Invalid settings record.');
            const key=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(start,separator));
            if(key===this.LIFECYCLE_KEY){
                if(end-separator-1!==1)throw new Error('Lifecycle setting must contain exactly one byte.');
                lastValueOffset=separator+1;
            }
            offset=end;
        }
        if(lastValueOffset<0)throw new Error('Lifecycle setting missing; no candidate applied.');
        const result=bytes.slice();
        result[lastValueOffset]=this.PRODUCTION;
        return result;
    }

    /** Mutate an isolated LittleFS overlay, verify exact settings and all other logical files. */
    static async setProduction(output) {
        const image=SparseImage.fromBuffer(output.slice());
        const parser=new LittleFSParser(image,this.LFS,this.SIZE-this.LFS);
        await parser.initialize();
        const before=await parser.readFile('/settings');
        const expected=this.productionSettings(before);
        if(this.equal(before,expected))return;
        const beforeTree=JSON.parse(await this.fileTree(output,this.LFS,this.SIZE-this.LFS));
        const write=await parser.writeFileChecked('/settings',expected,before);
        if(!write?.success)throw new Error('Could not stage production lifecycle settings.');
        const candidate=image.subarray(0,this.SIZE).slice();
        const verifier=new LittleFSParser(SparseImage.fromBuffer(candidate),this.LFS,this.SIZE-this.LFS);
        await verifier.initialize();
        if(!this.equal(await verifier.readFile('/settings'),expected))throw new Error('Production lifecycle readback failed.');
        const afterTree=JSON.parse(await this.fileTree(candidate,this.LFS,this.SIZE-this.LFS));
        const otherFiles=entries=>JSON.stringify(entries.filter(entry=>entry[0]!=='/settings'));
        if(otherFiles(beforeTree)!==otherFiles(afterTree) || !this.equal(output.subarray(0,this.LFS),candidate.subarray(0,this.LFS))) {
            throw new Error('Production settings changed unrelated target data.');
        }
        output.set(candidate);
    }

    /** Stage onto an isolated overlay; retain the original immutable backing and pending edits. */
    static stage(image, candidate) {
        const staged = new SparseImage(image.size, null, null, null, image.sectorSize);
        staged.readBuffer = image.readBuffer.slice();
        if (image.size !== this.SIZE || candidate.length !== this.SIZE) throw new Error('Complete candidate required.');
        // The candidate already includes retained edits. Rebuild against immutable reads so
        // bytes restored to the backing value cannot leave an older pending write behind.
        staged.write(0, candidate);
        if (!this.equal(staged.subarray(0,this.SIZE),candidate)) throw new Error('Sparse overlay verification failed.');
        return staged.writeBuffer;
    }
}
