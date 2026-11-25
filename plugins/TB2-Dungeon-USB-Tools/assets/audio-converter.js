/** Local, lazy MP3 conversion. Only one track and one worker are active per import. */
class Tb2AudioConverter {
    static MAX_MP3_BYTES = 128 * 1024 * 1024;
    static MAX_MP3_SECONDS = 2 * 60 * 60;
    static LOAD_TIMEOUT_MS = 60000;
    static CONVERT_TIMEOUT_MS = 30 * 60 * 1000;
    static ASSET_BASE = typeof document === 'undefined' ? null :
        new URL(CoreFlasherApp.extensions.asset('usb-tools', 'assets/'), document.baseURI);
    constructor() { this.worker = null; this.pending = null; this.sequence = 0; }

    /** Count complete MPEG Layer III frames, including VBR; do not trust extension or bitrate estimates. */
    static mp3Duration(bytes) {
        let start = 0, end = bytes.length, duration = 0, frames = 0, format = null, declaredFrames = null;
        const ascii = (offset, size) => String.fromCharCode(...bytes.subarray(offset, offset + size));
        if (ascii(0, 3) === 'ID3') {
            if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes.subarray(6, 10).some(value => value & 128)) throw new Error('Invalid MP3 ID3 header.');
            const size = bytes.slice(6, 10).reduce((value, part) => value * 128 + part, 0);
            start = 10 + size + (bytes[3] === 4 && bytes[5] & 16 ? 10 : 0);
        }
        if (end >= 128 && ascii(end - 128, 3) === 'TAG') end -= 128;
        // APEv2 is trailing metadata, not an extra MPEG frame. Preserve nothing from it.
        if (end >= 32 && ascii(end - 32, 8) === 'APETAGEX') {
            const size = new DataView(bytes.buffer, bytes.byteOffset + end - 32, 32).getUint32(12, true);
            if (size < 32 || size > end - start) throw new Error('Invalid MP3 trailing metadata.');
            end -= size;
        }
        const mpeg1Rates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
        const mpeg2Rates = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
        while (start < end) {
            if (start + 4 > end || bytes[start] !== 255 || (bytes[start + 1] & 224) !== 224) throw new Error('MP3 contains invalid or incomplete audio frames.');
            const version = bytes[start + 1] >> 3 & 3, layer = bytes[start + 1] >> 1 & 3;
            const bitrateIndex = bytes[start + 2] >> 4, sampleIndex = bytes[start + 2] >> 2 & 3;
            if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || sampleIndex === 3) throw new Error('Unsupported MP3 audio format.');
            const rate = [44100,48000,32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
            const currentFormat = `${version}/${rate}`;
            if (format !== null && format !== currentFormat) throw new Error('MP3 changes format within the track.');
            format = currentFormat;
            const bitrate = (version === 3 ? mpeg1Rates : mpeg2Rates)[bitrateIndex] * 1000;
            const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + (bytes[start + 2] >> 1 & 1);
            if (start + length > end) throw new Error('MP3 ends with an incomplete audio frame.');
            // Xing/Info counts exclude their own metadata frame. Detect whole-frame truncation too.
            if (!frames) {
                const mono = (bytes[start + 3] >> 6) === 3;
                const sideBytes = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
                const tag = start + 4 + ((bytes[start + 1] & 1) ? 0 : 2) + sideBytes;
                if (tag + 12 <= start + length && ['Xing', 'Info'].includes(ascii(tag, 4))) {
                    const header = new DataView(bytes.buffer, bytes.byteOffset + tag, 12);
                    if (header.getUint32(4) & 1) declaredFrames = header.getUint32(8) + 1;
                }
                const vbri = start + 4 + 32;
                if (vbri + 18 <= start + length && ascii(vbri, 4) === 'VBRI') {
                    declaredFrames = new DataView(bytes.buffer, bytes.byteOffset + vbri, 18).getUint32(14);
                }
            }
            start += length; duration += (version === 3 ? 1152 : 576) / rate; frames++;
            if (duration > this.MAX_MP3_SECONDS + 0.15) throw new Error('MP3 tracks must not exceed two hours.');
        }
        if (frames < 2 || start !== end) throw new Error('No complete MP3 audio track found.');
        if (declaredFrames !== null && declaredFrames !== frames) throw new Error('MP3 frame count does not match its duration header. The track may be truncated.');
        return duration;
    }

    /** Worker errors and aborts reject the active request and release the full WASM heap. */
    dispose(reason = new Error('Audio conversion stopped.')) {
        this.worker?.terminate(); this.worker = null;
        if (this.pending) { this.pending.reject(reason); this.pending = null; }
    }
    request(type, data, signal, timeout, transfer = []) {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const id = ++this.sequence;
            const abort = () => this.dispose(new DOMException('Audio conversion cancelled.', 'AbortError'));
            const timer = setTimeout(() => this.dispose(new Error('Audio converter timed out. Try a shorter track.')), timeout);
            const finish = callback => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = null; callback(value); };
            this.pending = { id, resolve: finish(resolve), reject: finish(reject) };
            signal?.addEventListener('abort', abort, { once: true });
            try { this.worker.postMessage({ id, type, ...data }, transfer); }
            catch (error) { this.dispose(error); }
        });
    }
    async load(signal) {
        if (this.worker) return;
        this.worker = new Worker(new URL('audio-converter-worker.js', Tb2AudioConverter.ASSET_BASE));
        this.worker.onmessage = ({ data }) => {
            if (this.pending?.id !== data.id) return;
            if (data.error) this.dispose(new Error(data.error)); else this.pending.resolve(data);
        };
        this.worker.onerror = event => { event.preventDefault(); this.dispose(new Error('Audio converter could not run. Reload the page and try again.')); };
        await this.request('load', {}, signal, Tb2AudioConverter.LOAD_TIMEOUT_MS);
    }

    /** Leave recognized Ogg bytes untouched; load WASM only for a structurally valid MP3. */
    async prepare(file, { signal, progress = () => {} } = {}) {
        signal?.throwIfAborted();
        const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
        if (String.fromCharCode(...header) === 'OggS') return file;
        if (file.size > Tb2AudioConverter.MAX_MP3_BYTES) throw new Error('MP3 tracks must not exceed 128 MiB.');
        const input = new Uint8Array(await file.arrayBuffer());
        const duration = Tb2AudioConverter.mp3Duration(input);
        signal?.throwIfAborted(); progress('Loading local MP3 converterâ€¦');
        await this.load(signal); progress('Converting MP3 to Ogg/Opusâ€¦');
        const result = await this.request('convert', { input: input.buffer, duration }, signal,
            Tb2AudioConverter.CONVERT_TIMEOUT_MS, [input.buffer]);
        signal?.throwIfAborted();
        return new File([result.output], 'converted.opus', { type: 'audio/ogg' });
    }
}
if (typeof module !== 'undefined') module.exports = { Tb2AudioConverter };
