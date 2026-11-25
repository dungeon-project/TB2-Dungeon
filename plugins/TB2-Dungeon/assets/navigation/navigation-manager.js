/** Owns tile lifecycle, navigation state, route execution and camera transitions. */
class TileManager {

    /**
     * Initialize navigation controls and discover the embedded tile classes.
     */
    constructor() {
        this.currentX = 0;
        this.currentY = 0;
        this.canvas = document.getElementById('mainCanvas');
        this.tiles = [];
        this.layers = {};
        this.activeLayer = null;
        this.transition = null;
        this.queuedTarget = null;
        this.spaceDirection = 1;
        this.lastTiles = {};
        this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.initControls();
        this.discoverTiles();
        TileManager.layerOrder = Object.freeze(['documentation', 'entry', 'settings', 'workspace',
            ...(this.tiles.some(tile => tile.definition.placement.layer === 'images') ? ['images'] : [])]);
        this.createLayers();
        this.cardShortcutsEnabled = !window.CoreFlasherStartup?.read("card-shortcuts-disabled");
        this.updateShortcutBadges();
    }

    refreshDirectionButtons() {
        const arrows = { ArrowUp: '↑', ArrowLeft: '←', ArrowDown: '↓', ArrowRight: '→' };
        for (const button of this.layerControls.querySelectorAll('button')) {
            const target = this.directionTarget(button.dataset.key);
            button.hidden = !target;
            if (!target) {
                button.querySelector('.nav-destination')?.getAnimations().forEach(animation => animation.cancel());
                continue;
            }
            const label = target.overworld ? 'Enter the Dungeon' : target.layer !== undefined
                ? this.areaName(TileManager.layerOrder[target.layer]) : this.cardTitle(target.tile);
            this.updateNavigationLabel(button, arrows[button.dataset.key], label);
        }
    }

    isTileVisible(tile) {
        return !!tile && window.CoreFlasherApp.registry.isVisible(tile);
    }

    showUsbToolStatus(message) {
        const card = this.tiles.find(tile => tile.element.id === 'tile-file-manager');
        let notice = card.element.querySelector('.js-usb-tool-status');
        if (!notice) {
            notice = document.createElement('p'); notice.className = 'js-usb-tool-status text-sm text-warning';
            notice.setAttribute('role', 'status'); card.element.firstElementChild.appendChild(notice);
        }
        notice.textContent = message;
    }

    /** Reconcile actual visibility without recreating controllers or interrupting unrelated work. */
    refreshUsbTools() {
        const context = window.CoreFlasherApp.context;
        const hidden = this.tiles.filter(tile => tile.definition.requiresTb2Usb && !this.isTileVisible(tile));
        for (const tile of this.tiles.filter(tile => tile.definition.requiresTb2Usb)) {
            const hide = hidden.includes(tile);
            const changed = tile.element.hidden !== hide;
            tile.element.hidden = hide; tile.element.inert = hide;
            if (changed && hide) tile.onUsbLost?.();
            tile.update();
        }
        const current = this.getTileAt(this.currentX, this.currentY);
        const affected = hidden.includes(current) || hidden.some(tile => tile.element.id === this.routeTravel?.targetId) ||
            hidden.includes(this.transition?.finalTile) || hidden.some(tile => this.queuedTarget?.[0] === tile.x && this.queuedTarget?.[1] === tile.y);
        if (affected) {
            const fallback = this.tiles.find(tile => tile.element.id === 'tile-file-manager');
            this.mapTravelView?.cancel?.();
            this.routeTravel = null; this.mapTravelActive = false; this.queuedTarget = null;
            for (const {grid} of Object.values(this.layers)) grid.style.transitionDuration = '';
            if (this.transition) {
                this.transition.finalTile = fallback; this.transition.finalLayer = this.layerFor(fallback);
                this.finishTransition(this.transition);
            } else {
                this.placeTile(fallback, this.layerFor(fallback)); this.activateTile(fallback, true); this.centerTile(fallback, true);
            }
            this.showUsbToolStatus('TB2 USB interface is no longer visible. USB tools were hidden; running actions are stopping.');
        }
        this.updateShortcutBadges();
        this.refreshDirectionButtons();
        this.shortcutHelp?.refresh();
        context.emit('usb-presence', context.usbPresence.state);
    }

    /** Instantiate registered card controllers without evaluating embedded source. */
    discoverTiles() {
        this.tiles = window.CoreFlasherApp.registry.instantiate(
            this, this.canvas, window.CoreFlasherApp.context);
        for (const tile of this.tiles) {
            const position = this.getNavigationPosition(tile);
            tile.element.style.gridColumn = String(position.x + 3);
            tile.element.style.gridRow = String(position.y + 3);
            tile.element.tabIndex = -1;
        }
    }

    /**
     * Find the first registered tile at the supplied coordinates.
     * @param {number} x
     * @param {number} y
     * @returns {Tile|undefined}
     */
    getTileAt(x, y) {
        return this.tiles.find(t => t.x === x && t.y === y);
    }

    /** Return visual coordinates while retaining controller coordinates for lookups.
     * @param {Tile} tile
     * @returns {{x: number, y: number}}
     */
    getNavigationPosition(tile) {
        const x = tile.element.id === 'tile-firmware-0408' && !this.tiles.some(card => card.element.id === 'tile-cracker-pane')
            ? 1 : Number(tile.element.dataset.navX);
        return { x, y: Number(tile.element.dataset.navY) };
    }

    /**
     * Update every tile in registration order, isolating each tile's failure.
     * sourceTile remains an accepted, unused compatibility parameter.
     * @param {Tile|undefined} sourceTile
     * @returns {void}
     */
    broadcastUpdate(sourceTile) {
        if (this.cardsInitializing) return;
        this._broadcastCycle = (this._broadcastCycle || 0) + 1;
        this.tiles.forEach(tile => {
            try {
                tile._lastBroadcastCycle = this._broadcastCycle;
                tile.update();
            }
            catch (err) {
                console.error('Tile update() failed for', tile.element && tile.element.id, err);
            }
        });
        this.refreshSourceAccess();
        window.CoreFlasherApp.context?.emit?.('update', { cycle: this._broadcastCycle });
        window.CoreFlasherApp.context?.identity?.observe();
        window.CoreFlasherApp.context?.entry?.refresh();
    }

    /** Refresh gates without changing content-card availability or controller coordinates. */
    refreshSourceAccess() {
        if (this.cardsInitializing) return;
        for (const tile of this.tiles) if (tile.element.dataset.requiresSource) {
            tile.updateStyles?.();
            tile.refreshActionButtons?.();
        }
    }

    /** Shared motion values keep timing, perspective and spring amplitude in one place. */
    static motion = Object.freeze({ duration: 1200, departure: 420, arrival: 1000,
        perspective: 2000, distantScale: 0.4, passageScale: 6, spring: 0.02,
        elevatorDuration: 1800, pullback: 300, elevatorDeparture: 720, dock: 1250, zoomArrival: 1600, travelScale: .78,
        labelDuration: 180, labelOffset: 4, mapSpeed: .65, mapArrivalHold: 180 });

    /** Reparent existing instances once; controllers retain their original elements. */
    createLayers() {
        this.canvas.style.perspective = `${TileManager.motion.perspective}px`;
        for (const name of TileManager.layerOrder) {
            const plane = document.createElement('div');
            const grid = document.createElement('div');
            plane.className = 'layer-plane';
            plane.dataset.layer = name;
            grid.className = 'canvas-grid active-interaction';
            plane.hidden = true;
            plane.inert = true;
            plane.appendChild(grid);
            this.canvas.appendChild(plane);
            this.layers[name] = { plane, grid };
        }
        // Layer controls live outside the grids and never duplicate a device controller.
        this.layerControls = document.createElement('nav');
        this.layerControls.className = 'layer-controls';
        this.layerControls.setAttribute('aria-label', 'Card navigation');
        for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'layer-link'; button.dataset.key = key;
            if (key === 'ArrowUp' || key === 'ArrowDown') button.dataset.direction = key === 'ArrowUp' ? '-1' : '1';
            button.addEventListener('click', event => {
                event.stopPropagation(); this.navigateDirection(key);
            });
            this.layerControls.appendChild(button);
        }
        this.canvas.appendChild(this.layerControls);
        // Builder shortcuts use the shared route: reach Image Actions in the elevator, then branch.
        this.canvas.querySelectorAll('[data-build-card]').forEach(button => button.addEventListener('click', event => {
            event.stopPropagation();
            const target = this.tiles.find(tile => tile.element.id === button.dataset.buildCard);
            if (target) this.startCardTravel(target, this.layerFor(target));
            else void CoreFlasherApp.extensions.showOverview();
        }));
        // Moving nodes preserves event listeners and all in-memory device state.
        for (const tile of this.tiles) this.layers[tile.element.dataset.layer].grid.appendChild(tile.element);
        for (const button of this.canvas.querySelectorAll('[data-layer-target]')) {
            button.addEventListener('click', event => {
                event.stopPropagation();
                if (!this.transition) this.navigateLayer(TileManager.layerOrder.indexOf(button.dataset.layerTarget));
            });
        }
    }

    static layerOrder = Object.freeze(['documentation', 'entry', 'settings', 'workspace', 'images']);
    static areas = Object.freeze({
        documentation: {name:'Documentation', icon:'M2 3h5l2 2 2-2h5v12h-5l-2 2-2-2H2z M9 5v12'},
        entry: {name:'Interfaces', icon:'M6 1v4 M12 1v4 M4 5h10v3a5 5 0 0 1-10 0z M9 13v4'},
        settings: {name:'Box Settings', icon:'M2 4h14 M2 9h14 M2 14h14 M6 2v4 M12 7v4 M7 12v4'},
        workspace: {name:'Box Tools', icon:'M12 2a5 5 0 0 0-6 6L2 12l4 4 4-4a5 5 0 0 0 6-6l-4 3-3-3z'},
        images: {name:'Image Actions', icon:'M5 2h10v11H5z M2 5v11h10 M8 5h4 M8 8h4'}
    });
    /** One temporary speed profile covers camera, lateral travel and handoff timing. */
    travelDuration(milliseconds) { return milliseconds * (this.mapTravelActive ? TileManager.motion.mapSpeed : 1); }
    areaName(layer) { return TileManager.areas[layer].name; }
    areaIcon(layer) {
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 18 18'); svg.setAttribute('aria-hidden','true');
        svg.classList.add('map-area-icon');
        const path=document.createElementNS(svg.namespaceURI,'path');
        path.setAttribute('d',TileManager.areas[layer].icon);svg.appendChild(path);return svg;
    }


    /** Each layer has one center; the three workspaces share the same dump controller. */
    layerCenter(index) { return index === 0 ? [-1, -1] : index === 1 ? [-1, 0] : [0, 0]; }
    navigateLayer(index) {
        if (index < 0 || index >= TileManager.layerOrder.length || this.transition) return;
        this.moveTo(...this.layerCenter(index), TileManager.layerOrder[index]);
    }
    layerFor(tile) {
        return tile.x === 0 && tile.y === 0
            ? (TileManager.layerOrder.indexOf(this.activeLayer) >= 2 ? this.activeLayer : 'settings')
            : tile.element.dataset.layer;
    }

    /** Move the real shared card only at the invisible handoff or immediate settlement. */
    placeTile(tile, layer) {
        if (TileManager.layerOrder.indexOf(layer) < 2) return;
        const dump = this.getTileAt(0, 0);
        dump.element.dataset.layer = layer;
        this.layers[layer].grid.appendChild(dump.element);
    }

    /** User requests never queue or click through a hidden/animating plane. */
    navigateUser(x, y, allowLayerChange = false) {
        const tile = this.getTileAt(x, y);
        if (this.transition || !this.isTileVisible(tile)) return;
        if (!allowLayerChange && tile.element.dataset.layer !== this.activeLayer) return;
        this.moveTo(x, y);
    }

    /** Center a grid independently of the outer plane's perspective transform. */
    centerTile(tile, immediate = false, layer = tile.element.dataset.layer) {
        const { grid } = this.layers[layer];
        const element = tile.element;
        immediate ||= this.motionPreference.matches;
        grid.style.transitionDuration = `${this.travelDuration(1200)}ms`;
        if (immediate) grid.style.transition = 'none';
        const left = (window.innerWidth - element.offsetWidth) / 2 - element.offsetLeft;
        const top = (window.innerHeight - element.offsetHeight) / 2 - element.offsetTop;
        grid.style.transform = `translate(${left}px, ${top}px)`;
        if (immediate) {
            void grid.offsetWidth;
            grid.style.transition = '';
        }
    }

    /** Publish the new destination immediately; only its name animates, never its click target. */
    updateNavigationLabel(button, arrow, label) {
        if (button.dataset.label === label) return;
        const hadLabel = Boolean(button.dataset.label);
        button.querySelector('.nav-destination')?.getAnimations().forEach(animation => animation.cancel());
        button.dataset.label = label;
        button.setAttribute('aria-label', label);
        const name = document.createElement('span');
        name.className = 'nav-destination'; name.textContent = label;
        button.replaceChildren(document.createTextNode(`${arrow} `), name);
        // Reduced motion and first render are immediate; rapid changes replace any old animation.
        if (hadLabel && !this.motionPreference.matches) name.animate([
            { opacity: 0, transform: `translateY(${TileManager.motion.labelOffset}px)` },
            { opacity: 1, transform: 'translateY(0)' }
        ], { duration: TileManager.motion.labelDuration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }

    /** Commit one visible, interactive layer and the existing logical focus state. */
    activateTile(tile, focusKeyboard = false) {
        if (this.currentX !== tile.x || this.currentY !== tile.y || this.activeLayer !== tile.element.dataset.layer) {
            window.CoreFlasherApp?.minotaurScene?.stop();
            this.minotaurShortcutAt = null;
        }
        this.activeLayer = tile.element.dataset.layer;
        this.currentX = tile.x;
        this.currentY = tile.y;
        this.lastTiles[this.activeLayer] = [tile.x, tile.y];
        for (const [name, { plane }] of Object.entries(this.layers)) {
            plane.hidden = name !== this.activeLayer;
            plane.inert = plane.hidden;
        }
        this.refreshDirectionButtons();
        for (const candidate of this.tiles) {
            // Extension hooks share the original activation timing; legacy fixtures still work.
            if (candidate === tile) {
                if (candidate.onEnter) candidate.onEnter();
                else candidate.focus();
            } else {
                if (candidate.onLeave) candidate.onLeave();
                else candidate.blur();
            }
        }
        if (this.navigationMap?.open) this.refreshNavigationMap?.();
        else if (focusKeyboard) tile.element.focus({ preventScroll: true });
    }

    /** Navigate by stable controller coordinates, coalescing programmatic requests. */
    moveTo(x, y, requestedLayer = null) {
        if (window.CoreFlasherApp?.minotaurScene?.canvas) return;
        const tile = this.getTileAt(x, y);
        if (!this.isTileVisible(tile)) return;
        const layer = requestedLayer || this.layerFor(tile);
        if (!TileManager.layerOrder.includes(layer)) return;
        if (this.transition) { this.queuedTarget = [x, y, layer]; return; }
        const layerChanged = this.activeLayer && layer !== this.activeLayer;
        if (layerChanged && !this.motionPreference.matches) {
            this.startTransition(tile, layer); return;
        }
        this.placeTile(tile, layer);
        this.activateTile(tile, !!layerChanged);
        this.centerTile(tile, !!layerChanged || !this.hasPosition);
        this.hasPosition = true;
        this.routeArrival();
    }

    /** Convert a desired apparent scale into depth under the scene perspective. */
    depthTransform(scale) {
        return `translateZ(${TileManager.motion.perspective * (1 - 1 / scale)}px)`;
    }

    /** Build a single arrival overshoot with zero velocity at the spring junction. */
    transitionFrames(forward, incoming) {
        const motion = TileManager.motion;
        const departure = motion.departure / motion.duration;
        const arrival = motion.arrival / motion.duration;
        const far = forward ? motion.distantScale : motion.passageScale;
        const frame = (offset, scale, opacity, easing = 'linear') =>
            ({ offset, transform: this.depthTransform(scale), opacity, easing });
        if (incoming) return [
            frame(0, far, 0), frame(departure - 0.001, far, 0),
            frame(departure, far, 1, 'cubic-bezier(0.16, 1, 0.3, 1)'),
            frame(arrival, 1 + (forward ? motion.spring : -motion.spring), 1, 'cubic-bezier(0.4, 0, 0.6, 1)'),
            frame(1, 1, 1)
        ];
        const exitScale = forward ? motion.passageScale : motion.distantScale;
        return [frame(0, 1, 1, 'cubic-bezier(0.4, 0, 0.6, 1)'),
            frame(departure, exitScale, 1), frame(departure + 0.001, exitScale, 0),
            frame(1, exitScale, 0)];
    }

    /** Pull back before travel, dock at overview scale, then approach with one small spring. */
    elevatorFrames(forward, part, continuing = false) {
        const motion = TileManager.motion;
        const easing = 'cubic-bezier(0.4, 0, 0.6, 1)';
        const frame = (time, scale, opacity = 1) => ({
            offset: time / motion.elevatorDuration,
            opacity,
            easing,
            transform: part === 'card'
                ? `translate(-50%, -50%) scale(${scale})`
                : this.depthTransform(scale)
        });
        // The shared card stays in its carrier while the surrounding planes pass.
        if (part === 'card') return [
            frame(0, continuing ? motion.travelScale : 1),
            frame(motion.pullback, motion.travelScale),
            frame(motion.dock, motion.travelScale),
            frame(motion.zoomArrival, 1 + motion.spring),
            frame(motion.elevatorDuration, 1)
        ];
        if (part === 'incoming') {
            const arrivalScale = (forward ? motion.distantScale : motion.passageScale) * motion.travelScale;
            return [
                frame(0, arrivalScale, 0),
                frame(motion.elevatorDeparture - 1, arrivalScale, 0),
                frame(motion.elevatorDeparture, arrivalScale),
                frame(motion.dock, motion.travelScale),
                frame(motion.zoomArrival, 1 + motion.spring),
                frame(motion.elevatorDuration, 1)
            ];
        }
        // Opacity changes immediately after departure, preserving the hidden handoff.
        const departureScale = (forward ? motion.passageScale : motion.distantScale) * motion.travelScale;
        return [
            frame(0, continuing ? motion.travelScale : 1),
            frame(motion.pullback, motion.travelScale),
            frame(motion.elevatorDeparture, departureScale),
            frame(motion.elevatorDeparture + 1, departureScale, 0),
            frame(motion.elevatorDuration, departureScale, 0)
        ];
    }

    /** Animate real opaque planes; device operations and controller instances keep running. */
    startTransition(finalTile, finalLayer, continuing = false) {
        const sourceIndex = TileManager.layerOrder.indexOf(this.activeLayer);
        const finalIndex = TileManager.layerOrder.indexOf(finalLayer);
        const nextIndex = sourceIndex + Math.sign(finalIndex - sourceIndex);
        const layer = TileManager.layerOrder[nextIndex];
        const tile = layer === finalLayer ? finalTile : this.getTileAt(...this.layerCenter(nextIndex));
        const source = this.layers[this.activeLayer], destination = this.layers[layer];
        const currentTile = this.getTileAt(this.currentX, this.currentY);
        const record = { tile, layer, finalTile, finalLayer, sourceLayer: this.activeLayer,
            animations: [], handedOff: false, elevator: null };
        this.transition = record;
        this.canvas.classList.add('is-travelling');
        for (const { plane } of Object.values(this.layers)) plane.inert = true;
        destination.plane.hidden = false;
        this.centerTile(this.getTileAt(this.currentX, this.currentY), true);
        this.centerTile(tile, true, layer);
        source.grid.style.transition = destination.grid.style.transition = 'none';
        // Keep the actual shared card visible in its own carrier throughout the camera move.
        if (currentTile === tile && tile === this.getTileAt(0, 0) && sourceIndex >= 2 && nextIndex >= 2) {
            record.elevator = document.createElement('div');
            record.elevator.className = 'layer-elevator';
            record.elevator.inert = true;
            this.canvas.appendChild(record.elevator);
            record.elevator.appendChild(tile.element);
        }
        // Other transitions move the shared card after the departure has disappeared.
        record.handoff = setTimeout(() => this.handoffTransition(record), this.travelDuration(TileManager.motion.departure));
        try {
            const forward=nextIndex>sourceIndex;
            const options = { duration: this.travelDuration(record.elevator ? TileManager.motion.elevatorDuration : TileManager.motion.duration), fill: 'both' };
            record.animations.push(source.plane.animate(record.elevator ? this.elevatorFrames(forward,'outgoing',continuing) : this.transitionFrames(forward,false), options));
            record.animations.push(destination.plane.animate(record.elevator ? this.elevatorFrames(forward,'incoming') : this.transitionFrames(forward,true), options));
            if(record.elevator)record.animations.push(record.elevator.animate(this.elevatorFrames(forward,'card',continuing),options));
            if (record.elevator && layer !== finalLayer &&
                TileManager.layerOrder.indexOf(layer) + Math.sign(finalIndex-nextIndex) >= 2) this.trimElevatorArrival(record);
            Promise.all(record.animations.map(animation => animation.finished)).then(
                () => this.finishTransition(record, false), () => this.finishTransition(record, true));
        } catch (error) {
            console.error('Layer animation could not start:', error);
            this.finishTransition(record, true);
        }
    }

    /** Accumulate discrete up/down presses against the requested floor, not the departed floor. */
    retargetElevator(key) {
        const transition = this.transition;
        if (!transition?.elevator || !['ArrowUp', 'ArrowDown'].includes(key)) return false;
        const currentTargetIndex = TileManager.layerOrder.indexOf(transition.finalLayer);
        const direction = key === 'ArrowDown' ? 1 : -1;
        const targetIndex = Math.max(0, Math.min(TileManager.layerOrder.length - 1, currentTargetIndex + direction));
        transition.finalLayer = TileManager.layerOrder[targetIndex];
        transition.finalTile = this.getTileAt(...this.layerCenter(targetIndex));

        // Intermediate shared-card floors keep moving instead of zooming in at every stop.
        const nextLayerIndex = TileManager.layerOrder.indexOf(transition.layer);
        if (transition.finalLayer !== transition.layer && nextLayerIndex + Math.sign(targetIndex - nextLayerIndex) >= 2) {
            this.trimElevatorArrival(transition);
        }
        return true;
    }

    /** Remove intermediate arrival zooms; a late request first eases back to travel scale. */
    trimElevatorArrival(record) {
        if(record.trimmed)return;
        record.trimmed=true;
        const m=TileManager.motion;
        const late=record.docking || Number(record.animations[0].currentTime)>this.travelDuration(m.dock);
        for(const animation of record.animations){
            if(!late){
                const frames=animation.effect.getKeyframes().filter(frame=>frame.offset<=m.dock/m.elevatorDuration);
                for(const frame of frames)frame.offset*=m.elevatorDuration/m.dock;
                animation.effect.setKeyframes(frames);animation.effect.updateTiming({duration:this.travelDuration(m.dock)});
            }else{
                const element=animation.effect.target,style=getComputedStyle(element);
                const carrier=element===record.elevator;
                const opacity=element===this.layers[record.layer].plane||carrier?1:0;
                const transform=carrier?`translate(-50%, -50%) scale(${m.travelScale})`:this.depthTransform(m.travelScale);
                const frames=[{transform:style.transform,opacity:style.opacity},{transform,opacity}];
                animation.currentTime=0;animation.effect.setKeyframes(frames);
                animation.effect.updateTiming({duration:this.travelDuration(m.pullback)});
            }
        }
    }

    /** If the requested stop changes back, perform one final docking zoom without another trip. */
    dockElevator(record) {
        record.trimmed=false;
        record.docking=true;
        for(const animation of record.animations)animation.cancel();
        this.layers[record.sourceLayer].plane.hidden=true;
        const m=TileManager.motion;
        record.animations=[this.layers[record.layer].plane,record.elevator].map(element=>{
            const transform=scale=>element===record.elevator?`translate(-50%, -50%) scale(${scale})`:this.depthTransform(scale);
            return element.animate([{transform:transform(m.travelScale),offset:0,easing:'cubic-bezier(.4,0,.6,1)'},
                {transform:transform(1+m.spring),offset:.65,easing:'cubic-bezier(.4,0,.6,1)'},
                {transform:transform(1),offset:1}],{duration:this.travelDuration(m.elevatorDuration-m.dock),fill:'both'});
        });
        Promise.all(record.animations.map(animation=>animation.finished)).then(
            ()=>this.finishTransition(record,false),()=>this.finishTransition(record,true));
    }

    /** Keep the single shared element, its listeners and focus state across depth flights. */
    handoffTransition(record) {
        if (this.transition !== record || record.handedOff || record.elevator) return;
        record.handedOff = true;
        this.placeTile(record.tile, record.layer);
        this.centerTile(record.tile, true, record.layer);
        this.layers[record.layer].grid.style.transition = 'none';
    }

    /** Cancellation settles at the final target; normal completion traverses intermediate layers. */
    finishTransition(record, settleFinal = true) {
        if (this.transition !== record) return;
        if(!settleFinal && record.trimmed && record.layer===record.finalLayer){this.dockElevator(record);return;}
        clearTimeout(record.handoff);
        this.transition = null;
        for (const animation of record.animations) animation.cancel();
        for (const { grid } of Object.values(this.layers)) grid.style.transition = '';
        const tile = settleFinal ? record.finalTile : record.tile;
        const layer = settleFinal ? record.finalLayer : record.layer;
        // Restore the live card before removing its carrier, also on interrupted multi-hop travel.
        if (record.elevator) {
            this.placeTile(record.tile, TileManager.layerOrder.indexOf(layer) >= 2 ? layer : record.sourceLayer);
            record.elevator.remove();
        }
        this.placeTile(tile, layer);
        this.activateTile(tile, layer === record.finalLayer);
        this.centerTile(tile, true);
        this.hasPosition = true;
        if (layer !== record.finalLayer) {
            this.startTransition(record.finalTile, record.finalLayer, !!record.trimmed); return;
        }
        this.canvas.classList.remove('is-travelling');
        const queued = this.queuedTarget;
        this.queuedTarget = null;
        if (queued) this.moveTo(...queued);
        else this.routeArrival();
    }

    /**
     * Run the existing completion-to-navigation transitions.
     * @param {Tile} tile
     * @returns {void}
     */
    onStepComplete(tile) {
        if (tile.element.id === 'tile-interface-options') {
            const nextY = 0;
            const next = this.getTileAt(1, nextY);
            next.enable();
            setTimeout(() => this.moveTo(1, nextY), 800);
        }
        else if (tile.element.id === 'tile-file-manager') {
            const next = this.getTileAt(1, 1);
            next.enable();
            setTimeout(() => this.moveTo(1, 1), 800);
        }
        else if (tile.element.id === 'tile-cracker-pane') {
            const next = this.getTileAt(0, 1);
            next.enable();
            setTimeout(() => this.moveTo(0, 1), 800);
        }
        else if (tile.element.id === 'tile-flash-process') {
            const next = this.getTileAt(-1, -1);
            next.enable();
            setTimeout(() => this.moveTo(-1, -1), 1500);
        }
    }

    /** Follow real adjacent cards through each workspace center, keeping the elevator route intact. */
    mapRouteTo(tile, layer) {
        const current = this.getTileAt(this.currentX, this.currentY);
        if (current === tile && layer === this.activeLayer) return [{ tile, layer }];
        const center = layerName => this.getTileAt(...this.layerCenter(TileManager.layerOrder.indexOf(layerName)));
        const pathWithin = (start, destination, layerName) => {
            const cards = this.tiles.filter(candidate => (candidate === center(layerName) || candidate.element.dataset.layer === layerName)
                && this.isTileVisible(candidate));
            const queue = [[start]];
            const visited = new Set([start]);

            // Breadth-first traversal retains the original shortest cardinal-neighbor route.
            while (queue.length) {
                const path = queue.shift();
                const lastTile = path[path.length - 1];
                if (lastTile === destination) return path.slice(1).map(next => ({ tile: next, layer: layerName }));
                const position = this.getNavigationPosition(lastTile);
                for (const next of cards) {
                    const target = this.getNavigationPosition(next);
                    if (!visited.has(next) && Math.abs(target.x - position.x) + Math.abs(target.y - position.y) === 1) {
                        visited.add(next);
                        queue.push([...path, next]);
                    }
                }
            }
            throw new Error('This destination has no available navigation route.');
        };

        // Every cross-floor journey passes through the shared center before branching out.
        const route = pathWithin(current, center(this.activeLayer), this.activeLayer);
        if (layer !== this.activeLayer) route.push({ tile: center(layer), layer });
        route.push(...pathWithin(center(layer), tile, layer));
        return route.length ? route : [{ tile, layer }];
    }

    /** Optional TC archive; the standalone website never invents a server connection. */
    openImageManager(saveWorking = false) {
        if (this.transition || this.routeTravel) return;
        this.imageManager ||= new ImageManagerDialog({
            searchReport: () => window.CoreFlasherApp.context.uuid.searchReport,
            identity: window.CoreFlasherApp.context.identity,
            boxChanged: profile => {
                const context = window.CoreFlasherApp.context;
                context.identity.invalidate(!context.uuid.scanner && this.imageManager.loadedArchiveImage()?.boxId === profile.id);
                window.CoreFlasherApp.context.hardware.refreshBoxRecognition(profile);
            },
            managedImageChanged: () => {
                const managed = this.imageManager.loadedArchiveImage();
                if (managed) managed.image.archiveBoxId = managed.boxId;
                window.CoreFlasherApp.context.identity.invalidate(!window.CoreFlasherApp.context.uuid.scanner);
            },
            metadataRestored: () => {
                window.CoreFlasherApp.context.identity.invalidate();
                window.CoreFlasherApp.context.hardware.refreshBoxRecognition(null, false);
            },
            identify: async (bytes, profiles) => {
                const image = SparseImage.fromBuffer(bytes.slice().buffer); image.completeSnapshot = true;
                let observed;
                try { observed = await window.CoreFlasherApp.context.identity.inspect(image); }
                catch { return null; } // Unknown firmware/filesystems remain archivable without a guessed box.
                return BoxIdentity.resolve(profiles, observed);
            },
            currentImage: () => window.CoreFlasherApp.context.image.current,
            busy: () => CoreFlasherDumpUi.busy() || window.CoreFlasherApp.context.uuid.searchBusy || this.tiles.some(tile => tile.operationRunning || tile.packageBusy || tile._busy || tile.loading || tile.app?.running),
            setBusy: busy => { window.AppState.imageManagerBusy = busy; this.broadcastUpdate(); },
            snapshot: () => {
                if (CoreFlasherDumpUi.busy()) throw new Error('Wait for the current operation to finish.');
                const image = window.interface;
                if (!CoreFlasherDumpUi.complete(image)) throw new Error('Load or create a complete 16 MiB working image first.');
                return { bytes: image.subarray(0, image.size).slice(), name: (window.AppState.sourceFileName || 'Working image').replace(/\.bin$/i, ''),
                    modified: !!image.writeBuffer?.some(segment => segment.data.length) };
            },
            inspect: async bytes => {
                const firmware = [], warnings = [];
                for (const [index, start] of [FirmwareImage.PRIMARY, FirmwareImage.SECONDARY].entries()) {
                    try {
                        const slot = await FirmwareImage.inspectSlot(bytes, start);
                        firmware.push(`${index === 0 ? 'Primary' : 'Secondary'}: ${slot.occupied ? slot.version : 'Empty'}`);
                    } catch { firmware.push(`${index === 0 ? 'Primary' : 'Secondary'}: Unknown`); warnings.push('Some firmware structures could not be verified. Archiving does not confirm that this image can boot.'); }
                }
                return { firmware, warning: warnings[0] || '' };
            },
            load: (bytes, name, signal, uuid, boxId) => window.CoreFlasherApp.context.image.loadArchive(bytes, name, signal, uuid, boxId),
            loadUuid: uuid => {
                window.CoreFlasherApp.context.uuid.resetSearch(true);
                window.CoreFlasherApp.context.uuid.setSerialNumberField(uuid, true);
            },
            navigate: () => this.startCardTravel(this.getTileAt(-1, 0), 'entry', true)
        });
        this.imageManager.open(saveWorking);
    }

    /** Registry metadata is the single source for card shortcuts and their badges. */
    static get cardShortcuts() {
        return Object.fromEntries(window.CoreFlasherApp.registry.definitions
            .filter(definition => definition.shortcut)
            .map(definition => [definition.shortcut, definition.id]));
    }

    /** Resolve display text through the same card definition used during mounting. */
    cardTitle(tile, short = false) {
        const definition = window.CoreFlasherApp.registry.get(tile.element.id);
        return short ? definition.shortTitle || definition.title : definition.title;
    }

    /** Shared route execution: the map observes this journey but does not own it. */
    startCardTravel(tile, layer, closeOnArrival = true) {
        if (!this.isTileVisible(tile) || this.routeTravel || this.transition || window.CoreFlasherApp?.minotaurScene?.canvas) return;
        if (tile === this.getTileAt(this.currentX, this.currentY) && layer === this.activeLayer) {
            if (this.mapTravelView) this.mapTravelView.same(closeOnArrival);
            else tile.element.focus({ preventScroll: true });
            return;
        }
        const source = this.getTileAt(this.currentX, this.currentY);
        const record = { steps: this.mapRouteTo(tile, layer), index: 0, waiting: false, closeOnArrival,
            startLayer: this.activeLayer, targetLayer: layer, targetId: tile.element.id };
        if (!record.steps.length) return;
        record.routeIds = [source.element.id, ...record.steps.map(step => step.tile.element.id)];
        this.routeTravel = record; this.mapTravelActive = true;
        this.mapTravelView?.start(record, tile, layer);
        this.moveRouteLeg(record);
    }

    /** Each leg waits for the actual camera/grid animation before advancing. */
    moveRouteLeg(record) {
        const step = record.steps[record.index];
        record.leg = { fromId: this.getTileAt(this.currentX, this.currentY).element.id,
            fromLayer: this.activeLayer, toId: step.tile.element.id, toLayer: step.layer };
        this.moveTo(step.tile.x, step.tile.y, step.layer);
    }

    async routeArrival() {
        const record = this.routeTravel, destination = record?.steps[record.index];
        if (!destination || record.waiting || this.transition || this.activeLayer !== destination.layer ||
            this.currentX !== destination.tile.x || this.currentY !== destination.tile.y) return;
        record.waiting = true;
        if (!this.motionPreference.matches)
            await Promise.allSettled(this.layers[destination.layer].grid.getAnimations().map(animation => animation.finished));
        if (this.routeTravel !== record) return;
        if (record.index + 1 < record.steps.length) {
            record.index++; record.waiting = false; this.moveRouteLeg(record); return;
        }
        // A closed map must never cancel the journey or retain its faster timing profile.
        try { await this.mapTravelView?.arrive(record, destination); }
        finally {
            if (this.routeTravel !== record) return;
            this.routeTravel = null; this.mapTravelActive = false;
            for (const { grid } of Object.values(this.layers)) grid.style.transitionDuration = '';
            if (!this.navigationMap?.open) destination.tile.element.focus({ preventScroll: true });
        }
    }

    /** Resolve buttons and keyboard arrows through the same visible neighborhood. */
    directionTarget(key) {
        const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
        const current = this.getTileAt(this.currentX, this.currentY);
        if (!step || !current) return null;
        const position = this.getNavigationPosition(current);
        const layerIndex = TileManager.layerOrder.indexOf(this.activeLayer);
        if (this.activeLayer === 'documentation' && position.x === 0 && position.y === 0 &&
            key === 'ArrowUp' && window.CoreFlasherApp.extensions?.has?.('overworld')) return { overworld: true };
        if (position.x === 0 && position.y === 0 && step[0] === 0 &&
            (step[1] < 0 || layerIndex < TileManager.layerOrder.length - 1)) {
            const layer = layerIndex + step[1];
            return layer >= 0 && layer < TileManager.layerOrder.length ? { layer } : null;
        }
        // Hidden developer cards never become button targets; disabled cards remain reachable.
        const tile = this.tiles.find(candidate => {
            if (candidate.element.dataset.layer !== this.activeLayer ||
                !this.isTileVisible(candidate)) return false;
            const next = this.getNavigationPosition(candidate);
            return next.x === position.x + step[0] && next.y === position.y + step[1];
        });
        return tile ? { tile } : null;
    }

    /** Resolve again on click so stale labels cannot navigate during a transition. */
    navigateDirection(key) {
        if (this.transition) { this.retargetElevator(key); return; }
        const target = this.directionTarget(key);
        if (target?.overworld) this.openOverworldEntrance();
        else if (target?.layer !== undefined) this.navigateLayer(target.layer);
        else if (target?.tile) this.navigateUser(target.tile.x, target.tile.y);
    }

    /** Reopen the installed guide at its entrance, regardless of the startup skip preference. */
    openOverworldEntrance() {
        const app = window.CoreFlasherApp;
        if (!app.extensions?.has?.('overworld') || !app.overworld?.open || this.routeTravel ||
            document.querySelector('dialog[open]')) return;
        // The current Overworld API treats an explicit destination as a manual visit.
        const originalUrl = location.href, explicitUrl = new URL(originalUrl);
        explicitUrl.searchParams.set('destination', 'overworld');
        const override = app.context.settings.preferences.read('skip-overworld') && explicitUrl.href !== originalUrl;
        const state = history.state;
        let overridden = false;
        try {
            if (override) { history.replaceState(state, '', explicitUrl.href); overridden = true; }
            app.overworld.open();
        } finally {
            if (overridden) history.replaceState(state, '', originalUrl);
        }
        const frame = document.querySelector('.dungeon-overworld[open] iframe');
        if (!frame) return;
        const entrance = new URL(frame.src);
        entrance.hash = 'enter-the-dungeon';
        frame.src = entrance.href;
    }

    static minotaurShortcutWindowMs = 1200;

    /** Centers connect depth layers; lateral branches retain ordinary spatial navigation. */
    initControls() {
        document.addEventListener('keydown', event => {
            const archiveKey = event.shiftKey && event.key?.toLowerCase() === 'i';
            const sequenceKey = event.key?.toLowerCase();
            const minotaurKey = event.shiftKey && (sequenceKey === 'm' ||
                (this.minotaurShortcutAt != null && ['i', 'n'].includes(sequenceKey)));
            if (!minotaurKey && event.key !== 'Shift') this.minotaurShortcutAt = null;
            if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && !archiveKey && !minotaurKey) ||
                event.target?.closest?.('input, textarea, select, audio, video, [contenteditable]:not([contenteditable="false"])')) {
                if (event.key !== 'Shift') this.minotaurShortcutAt = null;
                return;
            }
            if (archiveKey && this.cardShortcutsEnabled && this.imageManager?.dialog?.open) {
                if (!event.repeat) { event.preventDefault(); this.imageManager.close(); }
                return;
            }
            if (this.shortcutHelp) {
                if (!event.repeat && ['h', 'escape'].includes(event.key?.toLowerCase())) {
                    event.preventDefault(); this.shortcutHelp.close();
                }
                return;
            }
            if (document.querySelector('dialog[open]:not(.navigation-map), [role="dialog"][aria-modal="true"]:not(.navigation-map)')) return;
            // The hidden sequence consumes I only after M; standalone Shift+I keeps its archive action.
            if (minotaurKey) {
                if (!this.cardShortcutsEnabled || event.repeat || this.transition || this.routeTravel || this.navigationMap?.open) {
                    this.minotaurShortcutAt = null;
                    return;
                }
                event.preventDefault();
                const now = performance.now();
                const timely = this.minotaurShortcutAt != null && now - this.minotaurShortcutAt <= TileManager.minotaurShortcutWindowMs;
                const expected = timely ? 'min'[this.minotaurShortcutIndex] : 'm';
                this.minotaurShortcutIndex = sequenceKey === expected ? (timely ? this.minotaurShortcutIndex : 0) + 1 : sequenceKey === 'm' ? 1 : 0;
                this.minotaurShortcutAt = this.minotaurShortcutIndex ? now : null;
                if (this.minotaurShortcutIndex === 3) {
                    this.minotaurShortcutAt = null;
                    this.minotaurShortcutIndex = 0;
                    void CoreFlasherApp.minotaurScene.start();
                }
                return;
            }
            if (archiveKey) {
                if (!this.cardShortcutsEnabled || event.repeat || this.transition || this.routeTravel || this.navigationMap?.open) return;
                event.preventDefault(); this.openImageManager(); return;
            }
            if (event.key?.toLowerCase() === 'h') {
                if (event.repeat || this.transition || this.routeTravel) return;
                event.preventDefault(); this.toggleShortcutHelp(); return;
            }
            if (event.key?.toLowerCase() === 'm') {
                if (event.repeat) return;
                event.preventDefault();
                if (this.navigationMap?.open) this.navigationMap.close();
                else this.openNavigationMap();
                return;
            }
            const shortcut = this.cardShortcutsEnabled && this.shortcutTarget(event.key?.toLowerCase());
            if (shortcut) {
                if (event.repeat || this.routeTravel || this.transition) return;
                event.preventDefault();
                this.startCardTravel(shortcut, shortcut.element.dataset.layer, true);
                return;
            }
            if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
            if (event.key === ' ') {
                if (event.repeat || event.target?.closest?.('button, a, summary, [role="button"], [role="link"], [role="combobox"]') ||
                    document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
                event.preventDefault();
                const index = TileManager.layerOrder.indexOf(this.transition?.elevator ? this.transition.finalLayer : this.activeLayer);
                if (index === 0) this.spaceDirection = 1;
                else if (index === TileManager.layerOrder.length - 1) this.spaceDirection = -1;
                if (this.transition?.elevator) this.retargetElevator(this.spaceDirection > 0 ? 'ArrowDown' : 'ArrowUp');
                else if (!this.transition) this.navigateLayer(index + this.spaceDirection);
                return;
            }
            if (this.transition?.elevator && ['ArrowUp','ArrowDown'].includes(event.key)) {
                event.preventDefault(); if (!event.repeat) this.retargetElevator(event.key); return;
            }
            if (this.directionTarget(event.key) && !this.transition) {
                event.preventDefault(); this.navigateDirection(event.key);
            }
        });
        document.addEventListener('keyup', event => {
            if (event.key === 'Shift') this.minotaurShortcutAt = null;
        });
        // Geometry changes finish at the target rather than leaving a half-travelled layer.
        const settleGeometry = () => {
            if (this.motionPreference.matches) for (const label of this.layerControls.querySelectorAll('.nav-destination'))
                label.getAnimations().forEach(animation => animation.cancel());
            if (this.transition) this.finishTransition(this.transition);
            const tile = this.getTileAt(this.currentX, this.currentY);
            if (tile && this.activeLayer) this.centerTile(tile, true);
        };
        window.addEventListener('resize', settleGeometry);
        window.addEventListener('orientationchange', settleGeometry);
        this.motionPreference.addEventListener('change', settleGeometry);
    }

}

window.TileManager = TileManager;
