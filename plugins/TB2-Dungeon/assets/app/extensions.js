/** Local extensions contribute to one application, without owning core state. */
(() => {
    const app = window.CoreFlasherApp;
    const supported = ['uuid-scanner', 'usb-tools', 'image-tools', 'overworld'];
    const descriptions = new Map(), roots = new Map(), status = new Map();
    const API_VERSION = 1, TIMEOUT_MS = 10000;
    let expectedManifest = null;

    /** Resource paths stay inside the installed package. */
    function asset(id, path) {
        const base = roots.get(id);
        if (!base) throw new Error(`Extension is not available: ${id}`);
        const url = new URL(path, base);
        if (!url.href.startsWith(base.href)) throw new Error('Resource escapes its package.');
        return url.href;
    }
    function loadResource(url, optional = false) {
        return new Promise((resolve, reject) => {
            const stylesheet = new URL(url, document.baseURI).pathname.endsWith('.css');
            const element = document.createElement(stylesheet ? 'link' : 'script');
            let executionError = null, settled = false;
            // Script load events alone also report success after a JavaScript exception.
            const onExecutionError = event => {
                if (!event.filename || new URL(event.filename,document.baseURI).href !== new URL(url,document.baseURI).href) return;
                executionError = event.error || new Error(event.message);
                event.preventDefault();
            };
            if (!stylesheet) window.addEventListener('error',onExecutionError);
            if (stylesheet) { element.rel = 'stylesheet'; element.href = url; }
            else { element.async = false; element.src = url; }
            const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), TIMEOUT_MS);
            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                window.removeEventListener('error',onExecutionError);
                element.onload = element.onerror = null;
                if (error) {
                    element.remove();
                    if (optional && !executionError) resolve(false); else reject(error);
                } else resolve(element);
            }
            element.onload = () => finish(executionError);
            element.onerror = () => finish(new Error(`Could not load ${url}`));
            document.head.append(element);
        });
    }

    /** Manifest scripts describe data only; their implementations are loaded later. */
    function describe(manifest, source) {
        if (!expectedManifest || manifest.id !== expectedManifest.id || source !== expectedManifest.url) {
            if (expectedManifest) expectedManifest.error = new Error('Manifest identity mismatch.');
            return;
        }
        if (descriptions.has(manifest.id)) {
            status.set(manifest.id, {id:manifest.id,state:'error',message:'Duplicate extension ID.'});
            return;
        }
        descriptions.set(manifest.id, manifest);
        roots.set(manifest.id, new URL('.', source));
    }
    /** Bind registration to the requested identity, including renamed TC folders. */
    async function loadManifest(id, url, optional = false) {
        expectedManifest = {id,url};
        try {
            const loaded = await loadResource(url,optional);
            if (expectedManifest.error) throw expectedManifest.error;
            if (loaded && !descriptions.has(id)) throw new Error('Manifest did not register its package.');
        } catch (error) { disable(id,error); }
        finally { expectedManifest = null; }
    }
    async function discoverTeddyCloud() {
        const endpoint = new URL('../../api/plugins/getPlugins', document.baseURI);
        const response = await fetch(endpoint, {signal:AbortSignal.timeout(TIMEOUT_MS),cache:'no-store'});
        if (!response.ok) throw new Error(`Plugin list unavailable (HTTP ${response.status}).`);
        const folders = await response.json();
        if (!Array.isArray(folders)) throw new Error('Invalid TC plugin list.');
        const packages = [];
        for (const folder of folders) {
            if (typeof folder !== 'string' || !folder || /[\\/]/.test(folder) || folder === '.' || folder === '..') continue;
            const base = new URL(`../${encodeURIComponent(folder)}/`, document.baseURI);
            let metadata;
            try {
                const reply = await fetch(new URL('plugin.json',base), {signal:AbortSignal.timeout(TIMEOUT_MS),cache:'no-store'});
                if (!reply.ok) continue;
                metadata = await reply.json();
            } catch (error) { console.warn(`Could not read plugin metadata: ${folder}`,error); continue; }
            if (supported.includes(metadata?.tb2Dungeon?.id)) packages.push({base,metadata:metadata.tb2Dungeon});
        }
        const duplicate = new Set(packages.filter(item=>packages.filter(other=>other.metadata.id === item.metadata.id).length > 1).map(item=>item.metadata.id));
        for (const {base,metadata} of packages) {
            if (duplicate.has(metadata.id)) {
                status.set(metadata.id,{id:metadata.id,state:'error',message:'Duplicate extension ID.'});
                continue;
            }
            await loadManifest(metadata.id,new URL('extension.js',base).href);
        }
    }

    /** Accept a complete package only after validating it together with existing cards. */
    async function install(manifest, context) {
        const {id} = manifest;
        if (status.get(id)?.state === 'error') return;
        if (manifest.coreApi !== API_VERSION || !Array.isArray(manifest.files) || !Array.isArray(manifest.cards) ||
            typeof manifest.version !== 'string' || !manifest.version ||
            manifest.role !== (id === 'overworld' ? 'entry' : 'cards') ||
            (manifest.resources && !Array.isArray(manifest.resources))) {
            status.set(id,{id,state:'error',message:'Incompatible or invalid manifest.'}); return;
        }
        const registry = app.registry, staged = new app.CardRegistry();
        const templates = {...app.cardTemplates}, controllers = {...app.cardControllers};
        const elements = [];
        app.registry = staged;
        try {
            // Resolve the complete inventory before committing definitions or loading code.
            const files = manifest.files.map(file=>asset(id,file));
            const resources = (manifest.resources || []).map(file=>asset(id,file));
            for (const file of files) elements.push(await loadResource(file));
            if (staged.definitions.length !== manifest.cards.length || manifest.cards.some(card=>!staged.get(card.id)))
                throw new Error('Incomplete card registration.');
            const candidate = new app.CardRegistry();
            for (const definition of registry.definitions) candidate.register(definition);
            for (const definition of staged.definitions) candidate.register({...definition,packageId:id});
            candidate.validate(context);
            if (manifest.role === 'entry' && (typeof app.overworld?.initialize !== 'function' || typeof app.overworld?.open !== 'function'))
                throw new Error('Entry provider is incomplete.');
            registry.definitions = candidate.definitions;
            app.manifest.push(...manifest.cards.map(card=>({...card,packageId:id})));
            app.runtimeFiles.push(...files,...resources,asset(id,'extension.js'));
            status.set(id,{id,state:'ready',version:manifest.version,role:manifest.role});
        } catch (error) {
            elements.forEach(element=>element.remove());
            for (const key of Object.keys(app.cardTemplates)) delete app.cardTemplates[key];
            for (const key of Object.keys(app.cardControllers)) delete app.cardControllers[key];
            Object.assign(app.cardTemplates,templates);
            Object.assign(app.cardControllers,controllers);
            status.set(id,{id,state:'error',message:error.message});
            console.error(`Extension ${id} disabled:`,error);
        } finally { app.registry = registry; }
    }
    /** Failed optional packages stay visible as errors, never as successful installations. */
    function disable(id,error) {
        status.set(id,{id,state:'error',message:error.message});
    }
    async function load(context) {
        supported.forEach(id=>status.set(id,{id,state:'absent'}));
        if (app.delivery === 'teddycloud') {
            try { await discoverTeddyCloud(); }
            catch (error) {
                for (const id of supported) if (status.get(id).state === 'absent') status.set(id,{id,state:'error',message:error.message});
            }
        } else {
            for (const id of supported) await loadManifest(id,new URL(`extensions/${id}/extension.js`,document.baseURI).href,true);
        }
        for (const id of supported) if (descriptions.has(id)) await install(descriptions.get(id),context);
    }

    /** The overview remains reachable when an optional destination is unavailable. */
    function mountOverview(container) {
        const details = document.createElement('details'); details.className = 'dungeon-extensions';
        const summary = document.createElement('summary'); summary.textContent = 'Dungeon extensions'; details.append(summary);
        for (const {id,state,message,version} of status.values()) {
            const row = document.createElement('p');
            row.textContent = `${id.replaceAll('-',' ')}: ${state === 'ready' ? `Installed · ${version}` : state === 'absent' ? 'Not installed' : message}`;
            details.append(row);
        }
        container.append(details); app.extensionOverview = details;
    }
    async function showOverview() {
        const manager = app.context.manager, card = manager.tiles.find(tile=>tile.element.id === 'tile-interface');
        await manager.startCardTravel(card,manager.layerFor(card));
        app.extensionOverview.open = true;
        app.extensionOverview.querySelector('summary').focus();
    }
    app.extensions = {asset,describe,load,loadResource,mountOverview,showOverview,disable,
        has:id=>status.get(id)?.state === 'ready', statuses:()=>[...status.values()]};
})();
