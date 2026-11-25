// Optional existing sibling FFmpeg plugin; preserve the deployment prefix.
const FFMPEG_PLUGIN_BASE = '../../FFmpeg/assets/vendor/ffmpeg/';
/* Single-thread FFmpeg core in a dedicated worker; source tags and names are never logged. */
let core = null;
const PROFILE = ['-c:a','libopus','-ar','48000','-ac','2','-b:a','128k','-vbr','on',
    '-frame_duration','20','-application','audio','-mapping_family','0'];
const FILES = ['input.mp3', 'output.opus'];
const OGG_HEADER_BYTES = 27, OPUS_HEAD_BYTES = 19, SAMPLE_RATE = 48000;
const DURATION_TOLERANCE_SECONDS = 0.15; // MP3 encoder delay and padding, including Xing frames.

/** Explicit same-origin URLs prevent the core from fetching a CDN fallback. */
async function loadCore() {
    if (core) return;
    const coreURL = new URL(FFMPEG_PLUGIN_BASE + 'ffmpeg-core.js', self.location.href).href;
    const wasmURL = new URL(FFMPEG_PLUGIN_BASE + 'ffmpeg-core.wasm', self.location.href).href;
    try {
        importScripts(coreURL);
        const loaded = await createFFmpegCore({ mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL })) });
        loaded.setLogger(() => {}); loaded.setProgress(() => {});
        core = loaded;
    } catch (error) {
        throw new Error('FFmpeg audio plugin is missing or could not load. Install it in the FFmpeg plugin folder, then try again. Ogg/Opus files do not require this plugin.', { cause: error });
    }
}

/** Compare decoded duration using the Ogg end granule, before the caller checks every CRC. */
function verifyOutput(bytes, expectedDuration) {
    let offset = 0, endGranule = 0n, preSkip = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < bytes.length) {
        if (offset + OGG_HEADER_BYTES > bytes.length || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS') throw new Error('Converted Ogg page is invalid.');
        const segments = bytes[offset + 26], payload = offset + OGG_HEADER_BYTES + segments;
        if (!segments || payload > bytes.length) throw new Error('Converted Ogg page is incomplete.');
        let pageEnd = payload;
        for (let index = 0; index < segments; index++) pageEnd += bytes[offset + OGG_HEADER_BYTES + index];
        if (pageEnd > bytes.length) throw new Error('Converted Ogg payload is incomplete.');
        // The fixed encoder emits one complete OpusHead on its first page.
        if (!offset) {
            if (pageEnd - payload !== OPUS_HEAD_BYTES || String.fromCharCode(...bytes.subarray(payload, payload + 8)) !== 'OpusHead' ||
                bytes[payload + 9] !== 2 || view.getUint32(payload + 12, true) !== SAMPLE_RATE || bytes[payload + 18] !== 0) throw new Error('Converted Opus profile is invalid.');
            preSkip = view.getUint16(payload + 10, true);
        }
        if (bytes[offset + 5] & 4) endGranule = view.getBigUint64(offset + 6, true);
        offset = pageEnd;
    }
    if (!endGranule || Math.abs((Number(endGranule) - preSkip) / SAMPLE_RATE - expectedDuration) > DURATION_TOLERANCE_SECONDS) throw new Error('Converted audio failed duration verification.');
}

/** All temporary files must be released before a successful result is published. */
self.onmessage = async ({ data }) => {
    const { id, type } = data;
    let output, failure;
    try {
        if (type === 'load') { await loadCore(); self.postMessage({ id }); return; }
        if (type !== 'convert' || !core) throw new Error('Audio converter is not ready.');
        core.FS.writeFile('input.mp3', new Uint8Array(data.input));
        // Strict decoder errors prevent FFmpeg's damaged-packet recovery from looking successful.
        core.exec('-v','error','-xerror','-err_detect','explode','-f','mp3','-i','input.mp3',
            '-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1', ...PROFILE,'-f','ogg','output.opus');
        const result = core.ret; core.reset();
        if (result !== 0) throw new Error('MP3 could not be converted completely. The track may be damaged or unsupported.');
        output = core.FS.readFile('output.opus');
        verifyOutput(output, data.duration);
    } catch (error) {
        failure = error instanceof Error ? error.message : 'Audio conversion failed.';
    } finally {
        try { if (core) for (const name of FILES) if (core.FS.analyzePath(name).exists) core.FS.unlink(name); }
        catch { failure = 'Audio converter could not release temporary files. Please try again.'; }
    }
    if (failure) self.postMessage({ id, error: failure });
    else if (output) self.postMessage({ id, output: output.buffer }, [output.buffer]);
};
