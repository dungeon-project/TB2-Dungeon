/* Same-origin TeddyCloud file APIs. No box overlay, remote server or audio conversion. */
'use strict';
const TC_IMAGE_REQUEST_TIMEOUT_MS = 120000;
const TC_IMAGE_JSON_RESPONSE_BYTES = 1024 * 1024;
const TC_IMAGE_OPERATION_RESPONSE_BYTES = 8192;
const TC_IMAGE_MAX_PATH_CHARACTERS = 220;
const TC_IMAGE_DIRECTORY_PATH_BYTES = 128;
const TC_IMAGE_BOX_NAME_CHARACTERS = 100;

/** Storage contract for the Image Manager, backed by this server's file APIs. */
class TcImageStorage {
    constructor(base = location.origin + '/') {
        this.base = new URL(base);
        this.timeout = TC_IMAGE_REQUEST_TIMEOUT_MS;
        if (this.base.origin !== location.origin) throw new Error('The image archive must use this TeddyCloud server.');
    }
    url(route, path) {
        const url = new URL(route, this.base);
        if (path !== undefined) url.searchParams.set('path', '/' + path + '/');
        return url;
    }
    safe(path) {
        if (typeof path !== 'string' || (path !== 'firmware' && !path.startsWith('firmware/')) || path.length > TC_IMAGE_MAX_PATH_CHARACTERS ||
            path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) throw new Error('Invalid image archive path.');
        return path;
    }
    /** Bound reads and reject redirects; a login page is not a successful file response. */
    async request(url, options = {}, maximum = TC_IMAGE_JSON_RESPONSE_BYTES) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
            if (!response.ok) throw new Error(`TeddyCloud request failed (HTTP ${response.status}). Check access and archive availability.`);
            if (Number(response.headers.get('content-length')) > maximum) throw new Error('TeddyCloud response exceeds the expected size.');
            const reader = response.body.getReader();
            const parts = [];
            let length = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    length += value.length;
                    if (length > maximum) {
                        await reader.cancel();
                        throw new Error('TeddyCloud response exceeds the expected size.');
                    }
                    parts.push(value);
                }
            } finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const part of parts) {
                bytes.set(part, offset);
                offset += part.length;
            }
            return bytes;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('TeddyCloud request timed out. Refresh before retrying; a write may have completed.');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
    async json(url) {
        try {
            return JSON.parse(new TextDecoder().decode(await this.request(url)));
        } catch (error) {
            throw new Error(`Could not read TeddyCloud data: ${error.message}`);
        }
    }
    async boxes() {
        const data = await this.json(this.url('api/getBoxes'));
        if (!Array.isArray(data.boxes)) throw new Error('This server does not provide a compatible box list.');
        const boxes = [];
        this.boxWarnings = [];
        this.excludedBoxIds = new Set();
        const models = [];
        for (const route of ['api/tonieboxesJson', 'api/tonieboxesCustomJson']) {
            try {
                const catalog = await this.json(this.url(route));
                if (Array.isArray(catalog)) models.push(...catalog);
            } catch (error) { this.boxWarnings.push('Box pictures unavailable; neutral icons are shown.'); }
        }
        // The overlay generation is authoritative: 2 means TB2, independent of chip telemetry.
        for (const box of data.boxes.filter(box => typeof box.ID === 'string')) {
            const versionUrl = this.url('api/settings/get/toniebox.boxGeneration');
            versionUrl.searchParams.set('overlay', box.ID);
            try {
                const version = new TextDecoder().decode(await this.request(versionUrl, {}, TC_IMAGE_OPERATION_RESPONSE_BYTES)).trim();
                if (version !== '2') { this.excludedBoxIds.add('tc:' + box.ID); continue; }
            } catch (error) { this.boxWarnings.push('A box with unknown generation was excluded from selection.'); continue; }
            const model = models.find(item => item.id === box.boxModel);
            let picture = '';
            if (typeof model?.img_src === 'string') {
                try {
                    const url = new URL(model.img_src, this.base);
                    if (!url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === this.base.origin))) picture = url.href;
                } catch { /* Invalid catalog image addresses use the local neutral icon. */ }
            }
            boxes.push({ id: 'tc:' + box.ID, name: String(box.boxName || box.commonName || box.ID).slice(0, TC_IMAGE_BOX_NAME_CHARACTERS), picture });
        }
        return boxes;
    }

    async list(path) {
        this.safe(path);
        if (new TextEncoder().encode('/' + path + '/').length >= TC_IMAGE_DIRECTORY_PATH_BYTES) throw new Error('Archive folder path is too long for this server.');
        const data = await this.json(this.url('api/fileIndexV2', path));
        if (!Array.isArray(data.files)) throw new Error('This server does not provide a compatible file list.');
        return data.files.filter(file => !['.','..'].includes(file.name)).map(file => {
            if (typeof file.name !== 'string' || /[\/\\\x00-\x1f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.isDir !== 'boolean') throw new Error('Invalid archive file list.');
            return { name: file.name, size: file.size, isDir: file.isDir };
        });
    }
    /** Distinguish an empty installation from a failed archive request without creating folders. */
    async archiveExists() {
        const data = await this.json(this.url('api/fileIndexV2', ''));
        if (!Array.isArray(data.files)) throw new Error('This server does not provide a compatible file list.');
        return data.files.some(file => file.name === 'firmware' && file.isDir === true);
    }
    /** The raw endpoint serves exact bytes, unlike /content/download's audio workflow. */
    read(path, maximum) {
        this.safe(path);
        return this.request(this.url('content/json/' + path.split('/').map(encodeURIComponent).join('/')), {}, maximum);
    }
    async mutate(route, body, contentType = 'text/plain') {
        const bytes = await this.request(this.url(route), {
            method: 'POST', body, headers: { 'Content-Type': contentType }
        }, TC_IMAGE_OPERATION_RESPONSE_BYTES);
        if (new TextDecoder().decode(bytes).trim() !== 'OK') throw new Error('TeddyCloud did not confirm the file operation. Refresh before retrying.');
    }
    async mkdir(path) {
        this.safe(path);
        try {
            await this.list(path);
            return;
        } catch {
            // Preserve the existing create-and-verify fallback after a failed listing.
            // This method is called only after an explicit user write action.
        }
        await this.mutate('api/dirCreate', '/' + path);
        await this.list(path);
    }
    remove(path) {
        return this.mutate('api/fileDelete', '/' + this.safe(path));
    }
    move(source, target) {
        return this.mutate('api/fileMove', new URLSearchParams({ source: '/' + this.safe(source), target: '/' + this.safe(target) }).toString(), 'application/x-www-form-urlencoded');
    }
    /** Do not abort an in-flight POST: cancellation is honored at the next verified file boundary. */
    async write(path, bytes, progress = () => {}) {
        this.safe(path);
        const directorySeparator = path.lastIndexOf('/');
        const body = new FormData();
        body.append('file', new Blob([bytes], { type: 'application/octet-stream' }), path.slice(directorySeparator + 1));
        progress('Uploading image data…');
        const response = await this.request(this.url('api/fileUpload', path.slice(0, directorySeparator)),
            { method: 'POST', body }, TC_IMAGE_OPERATION_RESPONSE_BYTES);
        if (new TextDecoder().decode(response).trim() !== 'OK') throw new Error('TeddyCloud did not confirm the upload. Refresh before retrying.');
        progress('Verifying uploaded bytes…');
    }
}
if (typeof window !== 'undefined') {
    const prefix = location.pathname.match(/^(.*?)\/(?:web\/)?plugins\//)?.[1] || '';
    window.CoreFlasherImageStorage = () => new TcImageStorage(location.origin + prefix + '/');
}
if (typeof module !== 'undefined') module.exports = { TcImageStorage };
