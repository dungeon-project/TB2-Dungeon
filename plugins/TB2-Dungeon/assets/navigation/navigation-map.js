/** Adds presentation methods to the existing manager; no second navigation state. */
(() => {
class NavigationMapMethods {
    /** Show the elevator once, at its actual layer, before that layer's other cards. */
    mapDestinations() {
        return TileManager.layerOrder.map((layer, index) => ({ layer, index,
            cards: this.tiles.filter(tile => tile.element.dataset.layer === layer
                && this.isTileVisible(tile))
                .map(tile => ({ tile, position: this.getNavigationPosition(tile),
                    title: this.cardTitle(tile),
                    current: layer === this.activeLayer && tile.x === this.currentX && tile.y === this.currentY }))
                .sort((first, second) => Number(second.tile === this.getTileAt(0, 0)) - Number(first.tile === this.getTileAt(0, 0))
                    || first.title.localeCompare(second.title, 'en', { sensitivity: 'base' }))
        }));
    }

    /** Build a modal on demand; closing without travel restores the invoking focus. */
    openNavigationMap() {
        if (this.transition || this.mapTravelActive || this.navigationMap || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
        const previousFocus = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'navigation-map';
        dialog.setAttribute('aria-labelledby', 'navigation-map-title');
        dialog.innerHTML = '<header><h2 id="navigation-map-title">Navigation Map</h2><button type="button" class="layer-link" aria-label="Close navigation map">Close</button></header><div class="navigation-map-body"><nav class="navigation-map-list" aria-label="Map destinations"></nav></div>';
        const list = dialog.querySelector('nav');
        let destinations = this.mapDestinations();
        let travel = null, mapNavigated = false, expanded = this.activeLayer, frameRequest = 0;
        const startTravel = (tile, layer, closeOnArrival) => this.startCardTravel(tile, layer, closeOnArrival);
        const travelView = {
            same: close => { if (close) { mapNavigated = true; dialog.close(); } },
            start: record => {
                travel = record; mapNavigated = true;
                this.refreshNavigationMap();
                frameRequest = requestAnimationFrame(followFlight);
            }
        };
        this.mapTravelView = travelView;
        // Text nodes keep card titles out of HTML; each entry carries an explicit layer.
        const renderList = () => {
            const retainedElements = new Set();
            let previousElement = null;
            const placeElement = element => {
                retainedElements.add(element);
                const nextElement = previousElement ? previousElement.nextElementSibling : list.firstElementChild;
                if (nextElement !== element) list.insertBefore(element, nextElement);
                previousElement = element;
            };
            // Reuse existing headings and buttons so focused destinations retain identity.
            for (const group of destinations) {
                let heading = list.querySelector(`h3[data-area="${group.layer}"]`);
                if (!heading) {
                    heading = document.createElement('h3');
                    heading.dataset.area = group.layer;
                    heading.append(this.areaIcon(group.layer), document.createTextNode(this.areaName(group.layer)));
                }
                heading.dataset.active = String(group.layer === expanded);
                placeElement(heading);
                for (const card of group.cards) {
                    let button = list.querySelector(`[data-card="${card.tile.element.id}"]`);
                    if (!button) {
                        button = document.createElement('button');
                        button.type = 'button';
                        button.dataset.card = card.tile.element.id;
                        button.addEventListener('click', () => startTravel(card.tile, button.dataset.layer, true));
                    }
                    // Layer metadata can change when the shared elevator reaches another floor.
                    button.textContent = card.title;
                    button.dataset.layer = group.layer;
                    this.addShortcutBadge(button, card.tile.element.id);
                    button.setAttribute('aria-disabled', String(!!travel));
                    if (card.current) button.setAttribute('aria-current', 'location');
                    else button.removeAttribute('aria-current');
                    placeElement(button);
                }
            }
            for (const child of [...list.children]) {
                if (!retainedElements.has(child)) child.remove();
            }
        };
        renderList();
        // Redraw only the diagram; resizing never replaces the focused list or its scroll state.
        const host = document.createElement('div'); host.className = 'navigation-map-host';
        dialog.querySelector('.navigation-map-body').appendChild(host);
        let hovered = null, focused = null;
        const cardId = element => element?.closest?.('[data-card], [data-map-card], [data-map-hit]')?.dataset;
        const cardIdentity = element => {
            const data = cardId(element);
            return data?.card || data?.mapCard || data?.mapHit || null;
        };
        const highlight = () => {
            const highlighted = travel ? null : hovered || focused;
            for (const shape of host.querySelectorAll('[data-map-card]'))
                shape.dataset.highlight = String(shape.dataset.mapCard === highlighted);
            host.querySelector('svg')?.showMapHint?.(highlighted);
        };
        // Pointer selection takes precedence; leaving it restores the keyboard focus indication.
        dialog.addEventListener('pointerover', event => {
            hovered = cardIdentity(event.target);
            highlight();
        });
        dialog.addEventListener('pointerleave', () => { hovered = null; highlight(); });
        dialog.addEventListener('focusin', event => {
            focused = cardIdentity(event.target);
            highlight();
        });
        dialog.addEventListener('focusout', event => {
            focused = cardIdentity(event.relatedTarget);
            highlight();
        });
        let lastSize = '';
        const redraw = () => {
            if (!dialog.open || !host.clientWidth || !host.clientHeight) return;
            const size = `${host.clientWidth}:${host.clientHeight}`;
            if (size === lastSize) return;
            lastSize = size;
            let existing = host.querySelector('svg');
            if (!existing) { existing = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); host.appendChild(existing); }
            const svg=this.drawNavigationMap(destinations,host.clientWidth,host.clientHeight,existing,{expanded,...travel, travelling: !!travel});
            svg.layoutMapLabels();
            const flight = navigationMapFlight(this, travel);
            if (flight) svg.followTravel(flight);
            highlight();
        };
        // Map selection travels without closing the dialog; lists and marker follow the live state.
        this.refreshNavigationMap = () => {
            if(!travel)expanded=this.activeLayer;
            const scroll=list.scrollTop, focus=document.activeElement;
            const data=cardId(focus),focusId=data?.card||data?.mapCard||null;
            destinations=this.mapDestinations();renderList();lastSize='';redraw();
            if(focusId && document.activeElement!==focus){
                const selector=data?.card?`[data-card="${focusId}"]`:`[data-map-card="${focusId}"]`;
                dialog.querySelector(selector)?.focus({preventScroll:true});
            }
            list.scrollTop=scroll;
        };
        // Animation progress comes from the real camera/grid animation, never a parallel timer.
        const followFlight = () => {
            if(!travel || !dialog.open)return;
            const flight = navigationMapFlight(this, travel);
            if (flight) host.querySelector('svg')?.followTravel(flight);
            frameRequest=requestAnimationFrame(followFlight);
        };
        const selectMapCard = event => {
            const shape = event.target.closest('[data-map-card], [data-map-hit]');
            if (!shape || this.transition || travel) return;
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault(); event.stopPropagation();
            const tile = this.tiles.find(candidate => candidate.element.id === (shape.dataset.mapCard || shape.dataset.mapHit));
            if (!tile) return;
            startTravel(tile, shape.dataset.mapLayer, false);
        };
        host.addEventListener('click', selectMapCard);
        host.addEventListener('keydown', selectMapCard);
        // Advance only after actual arrival; a layer leg may traverse several elevator floors.
        travelView.cancel = () => {
            cancelAnimationFrame(frameRequest); travel = null; expanded = this.activeLayer;
        };
        travelView.arrive = async (record, destination) => {
            cancelAnimationFrame(frameRequest);
            expanded=this.activeLayer;
            // The last flight frame already has the resting geometry; no arrival reflow animation.
            if(travel!==record)return;
            travel=null;
            if(dialog.open){
                this.refreshNavigationMap();
                if(!record.closeOnArrival)host.querySelector(`[data-map-card="${destination.tile.element.id}"]`)?.focus({preventScroll:true});
            }
            if(record.closeOnArrival){
                if(!this.motionPreference.matches)await new Promise(resolve=>setTimeout(resolve,TileManager.motion.mapArrivalHold));
                if(dialog.open && !travel)dialog.close();
            }

        };
        const observer = new ResizeObserver(()=>{
            redraw();
        });
        observer.observe(host);
        dialog.querySelector('header button').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            cancelAnimationFrame(frameRequest);
            observer.disconnect(); this.shortcutHelp?.close(); dialog.remove(); this.navigationMap = null; this.refreshNavigationMap = null; this.mapTravelView = null;
            if (mapNavigated) this.getTileAt(this.currentX, this.currentY).element.focus({ preventScroll: true });
            else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        }, { once: true });
        document.body.appendChild(dialog); this.navigationMap = dialog;
        dialog.showModal(); redraw();
        (list.querySelector('[aria-current]') || list.querySelector('button')).focus();
    }

    /** Build keyed platforms once; the live flight only changes transforms and geometry. */
    drawNavigationMap(groups, width, height, previous = null, options = {}) {
        const namespace = 'http://www.w3.org/2000/svg';
        const svg = previous || document.createElementNS(namespace, 'svg');
        const existing = new Map([...svg.querySelectorAll('[data-map-key]')].map(element => [element.dataset.mapKey, element]));
        const retained = new Set();
        const node = (key, tag, attributes, parent, text) => {
            const element = existing.get(key) || document.createElementNS(namespace, tag);
            element.dataset.mapKey = key; retained.add(element);
            if (tag === 'polygon') element.setAttribute('vector-effect', 'non-scaling-stroke');
            for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
            if (text !== undefined && element.textContent !== text) element.textContent = text;
            if (element.parentNode !== parent) parent.appendChild(element);
            return element;
        };
        svg.setAttribute('class', 'navigation-map-art'); svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', 'Map destinations'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const geometry = {slope: Math.tan(Math.PI / 6), radius: .43, margin: .68, side: 4};
        const compact = width < 500, elevatorId = this.getTileAt(0, 0).element.id;
        const startFocus = groups.findIndex(group => group.layer === (options.expanded || this.activeLayer));
        const fullFloors = groups.map((group, index) => calculateNavigationMapLayout(groups, width, height, index, geometry)[index]);
        const project = (x, y, scale) => [(x - y) * scale, (x + y) * geometry.slope * scale];
        const points = corners => corners.map(corner => corner.join(',')).join(' ');
        const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

        // Measurements are cached across station handoffs. Only size/content changes invalidate them.
        const signature = `${width}:${height}:${groups.flatMap(group => group.cards.map(card => card.title)).sort().join('|')}`;
        if (svg.measurementSignature !== signature) { svg.measurementSignature = signature; svg.textMeasurements = new Map(); }
        const measure = (text, maxWidth) => {
            const key = `${text}:${maxWidth}`;
            if (svg.textMeasurements.has(key)) return svg.textMeasurements.get(key);
            const probe = document.createElementNS(namespace, 'text');
            probe.setAttribute('font-size', 12); probe.setAttribute('visibility', 'hidden'); svg.appendChild(probe);
            const length = value => { probe.textContent = value; return probe.getComputedTextLength(); };
            let lines = [text], measuredWidth = length(text);
            const words = text.split(' ');
            if (measuredWidth > maxWidth) for (let split = 1; split < words.length; split++) {
                const candidate = [words.slice(0, split).join(' '), words.slice(split).join(' ')];
                const candidateWidth = Math.max(...candidate.map(length));
                if (candidateWidth < measuredWidth) { lines = candidate; measuredWidth = candidateWidth; }
            }
            probe.textContent = 'Mg'; const box = probe.getBBox(); probe.remove();
            const result = {lines, width: measuredWidth, height: box.height + (lines.length - 1) * 15};
            svg.textMeasurements.set(key, result); return result;
        };
        const textLines = (key, parent, metrics, attributes = {}) => {
            const text = node(key, 'text', {'font-size': 12, 'text-anchor': 'middle', ...attributes}, parent);
            metrics.lines.forEach((line, index) => node(`${key}:${index}`, 'tspan', {x: 0, y: 4 + (index - (metrics.lines.length - 1) / 2) * 15}, text, line));
            return text;
        };
        const defs = node('defs', 'defs', {}, svg);
        const gradient = node('glow-gradient', 'radialGradient', {id: 'map-active-glow'}, defs);
        node('glow-start', 'stop', {offset: '0%', 'stop-color': '#61738b', 'stop-opacity': .12}, gradient);
        node('glow-end', 'stop', {offset: '100%', 'stop-color': '#61738b', 'stop-opacity': 0}, gradient);
        const backdrop = node('backdrop', 'g', {'pointer-events': 'none'}, svg);
        const foreground = node('cards', 'g', {}, svg);
        const floors = [], cards = new Map(), connections = [];
        const routeIds = new Set(options.routeIds || []);

        // Area captions never scale. Their networks and room platforms use the same floor transform.
        for (const [index, full] of fullFloors.entries()) {
            const group = full.group, key = `area:${group.layer}`;
            const area = node(key, 'g', {}, backdrop);
            const glow = node(`${key}:glow`, 'rect', {x: 0, width, fill: 'url(#map-active-glow)'}, area);
            const icon = node(`${key}:icon`, 'path', {d: TileManager.areas[group.layer].icon, fill: 'none', stroke: '#8b9bae', 'stroke-width': 1.4}, area);
            const title = node(`${key}:title`, 'text', {x: 32, 'font-size': compact ? 10 : 11, fill: '#8291a4'}, area, this.areaName(group.layer));
            const station = node(`${key}:station`, 'circle', {r: 3, fill: '#0c0e11', stroke: '#64778d', 'data-map-station': group.layer}, area);
            const network = node(`${key}:network`, 'g', {}, area);
            const neighbors = [...group.cards];
            if (!neighbors.some(card => card.position.x === 0 && card.position.y === 0)) neighbors.push({position: {x: 0, y: 0}, tile: this.getTileAt(0, 0)});
            for (let first = 0; first < neighbors.length; first++) for (let second = first + 1; second < neighbors.length; second++) {
                const a = neighbors[first], b = neighbors[second];
                if (Math.abs(a.position.x - b.position.x) + Math.abs(a.position.y - b.position.y) !== 1) continue;
                const source = project(a.position.x, a.position.y, full.scale), target = project(b.position.x, b.position.y, full.scale);
                const routed = routeIds.has(a.tile.element.id) && routeIds.has(b.tile.element.id);
                node(`${key}:edge:${first}:${second}`, 'path', {d: `M${source.join(' ')} L${target.join(' ')}`, fill: 'none', stroke: routed ? '#afbdd1' : '#354252', 'stroke-width': routed ? 1.5 : 1}, network);
            }
            floors.push({full, glow, icon, title, station, network});
            if (index) {
                const routeStart = groups.findIndex(entry => entry.layer === options.startLayer);
                const routeEnd = groups.findIndex(entry => entry.layer === options.targetLayer);
                const routed = index > Math.min(routeStart, routeEnd) && index <= Math.max(routeStart, routeEnd);
                connections.push(node(`axis:${index}`, 'path', {fill: 'none', stroke: routed ? '#afbdd1' : '#506175',
                    'stroke-width': routed ? 1.5 : 1, 'stroke-dasharray': '2 6', opacity: .6}, backdrop));
            }

            for (const card of group.cards) {
                const id = card.tile.element.id, scale = full.scale, radius = geometry.radius;
                const platform = node(`card:${id}`, 'g', {class: 'map-card-group'}, foreground);
                const corners = [[-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius]].map(([x, y]) => project(x, y, scale));
                const color = `rgb(${getComputedStyle(card.tile.element).getPropertyValue('--tile-accent').trim()})`;
                for (const [edge, endpoints] of [[1, [1, 2]], [2, [2, 3]]]) {
                    const a = corners[endpoints[0]], b = corners[endpoints[1]];
                    node(`side:${id}:${edge}`, 'polygon', {points: points([a, b, [b[0], b[1] + geometry.side], [a[0], a[1] + geometry.side]]), fill: '#111720', stroke: color, 'stroke-opacity': .35, 'stroke-width': .6}, platform);
                }
                const hit = [[-.49, -.49], [.49, -.49], [.49, .49], [-.49, .49]].map(([x, y]) => project(x, y, scale));
                node(`hit:${id}`, 'polygon', {points: points(hit), fill: 'transparent', 'pointer-events': 'all', 'data-map-hit': id, 'data-map-layer': group.layer}, platform);
                const face = node(`face:${id}`, 'polygon', {points: points(corners), fill: card.current ? '#30242e' : '#18202a', stroke: color,
                    'stroke-width': card.current ? 2 : 1, 'data-current': card.current, 'data-map-card': id, 'data-map-layer': group.layer,
                    role: 'button', tabindex: 0, 'aria-label': `${card.title} · ${this.areaName(group.layer)}`}, platform);
                const outline = [[-.47, -.47], [.47, -.47], [.47, .47], [-.47, .47]].map(([x, y]) => project(x, y, scale));
                node(`outline:${id}`, 'polygon', {points: points(outline), class: 'map-card-outline'}, platform);
                if (options.targetId === id) node(`target:${id}`, 'polygon', {points: points(outline), class: 'map-card-target', 'data-map-target': id}, platform);

                // Labels remain inside their platform group and inherit its exact scale throughout travel.
                const metrics = measure(this.cardTitle(card.tile, true), Math.min(140, scale * 1.3));
                const labelGroup = node(`label:${id}`, 'g', {class: 'map-card-labels', 'pointer-events': 'none'}, platform);
                const label = textLines(`label-text:${id}`, labelGroup, metrics, {'paint-order': 'stroke', stroke: '#0c0e11', 'stroke-width': 3});
                const resident = card.tile.definition?.mapResident;
                if (resident) {
                    const size = Math.min(36, scale * .4);
                    const portrait = node(`resident:${id}`, 'svg', {'data-map-resident': id, 'pointer-events': 'none', x: -size / 2, y: scale * .03,
                        width: size, height: size, viewBox: `0 0 ${resident.width} ${resident.height}`, overflow: 'hidden'}, platform);
                    node(`resident-title:${id}`, 'title', {}, portrait, resident.label);
                    node(`resident-image:${id}`, 'image', {href: resident.sprite, width: resident.width * resident.columns, height: resident.height}, portrait);
                }
                const hintMetrics = measure(card.title, Math.min(260, width - (resident ? 88 : 32)));
                cards.set(id, {card, platform, face, labelGroup, label, metrics, hintMetrics, resident, fullScale: scale, index});
            }
        }
        const marker = node('marker', 'g', {'pointer-events': 'none'}, svg);
        node('marker-ring', 'circle', {cx: 0, cy: 0, r: 5, class: 'navigation-map-pulse'}, marker);
        node('marker-point', 'circle', {cx: 0, cy: 0, r: 3.5, class: 'navigation-map-point'}, marker);
        const locationMetrics = measure('You are here', width - 24);
        const location = node('marker-label', 'text', {'font-size': 12, 'data-map-location': 'true', fill: '#ff8993', 'paint-order': 'stroke', stroke: '#0c0e11', 'stroke-width': 3}, marker, 'You are here');
        location.style.fill = '#ff8993';
        const hintLayer = node('hints', 'g', {'pointer-events': 'none'}, svg);
        for (const element of existing.values()) if (!retained.has(element)) element.remove();
        svg.append(marker, hintLayer);
        let currentLayout, anchors = new Map(), occupied = [], travelling = !!options.travelling;
        let markerPosition = null;
        const visibleLabels = () => [...cards.values()].filter(record => Number(record.labelGroup.getAttribute('opacity')) > .01);
        const interpolate = (a, b, progress) => a + (b - a) * progress;

        // Every frame shares one logical focus position; no screen-coordinate feedback loop is involved.
        const renderFrame = flight => {
            const fromIndex = flight ? groups.findIndex(group => group.layer === flight.fromLayer) : startFocus;
            const toIndex = flight ? groups.findIndex(group => group.layer === flight.toLayer) : startFocus;
            const progress = flight?.progress || 0;
            const focus = interpolate(fromIndex, toIndex, progress);
            currentLayout = calculateNavigationMapLayout(groups, width, height, focus, geometry);
            anchors = new Map(); occupied = [];
            for (const [index, floor] of currentLayout.entries()) {
                const view = floors[index], ratio = floor.scale / view.full.scale;
                view.glow.setAttribute('y', floor.top); view.glow.setAttribute('height', floor.bandHeight); view.glow.setAttribute('opacity', floor.weight);
                view.icon.setAttribute('transform', `translate(12 ${floor.top + 4}) scale(.75)`);
                view.title.setAttribute('y', floor.top + 15); view.title.setAttribute('fill', floor.weight >= .5 ? '#e2edff' : '#8291a4');
                view.station.setAttribute('cx', floor.origin.x); view.station.setAttribute('cy', floor.origin.y);
                view.network.setAttribute('transform', `translate(${floor.origin.x} ${floor.origin.y}) scale(${ratio})`);
                occupied.push({x: 10, y: floor.top, width: 140, height: 22});
                if (index) connections[index - 1].setAttribute('d', `M${currentLayout[index - 1].origin.x} ${currentLayout[index - 1].origin.y} L${floor.origin.x} ${floor.origin.y}`);
                for (const card of floor.group.cards) {
                    const [x, y] = project(card.position.x, card.position.y, floor.scale);
                    anchors.set(card.tile.element.id, {cx: floor.origin.x + x, cy: floor.origin.y + y, scale: floor.scale, layer: floor.group.layer, weight: floor.weight});
                }
            }
            const crossFloor = flight && fromIndex !== toIndex;
            if (crossFloor && flight.fromId === elevatorId && flight.toId === elevatorId) {
                const source = currentLayout[fromIndex], destination = currentLayout[toIndex];
                anchors.set(elevatorId, {cx: source.origin.x, cy: interpolate(source.origin.y, destination.origin.y, progress),
                    scale: interpolate(source.scale, destination.scale, progress), layer: flight.toLayer,
                    weight: interpolate(source.weight, destination.weight, progress)});
            }
            for (const [id, view] of cards) {
                const anchor = anchors.get(id), ratio = anchor.scale / view.fullScale;
                view.platform.setAttribute('transform', `translate(${anchor.cx} ${anchor.cy}) scale(${ratio})`);
                const readable = !compact || view.card.current || id === flight?.fromId || id === flight?.toId;
                const opacity = readable ? smooth((anchor.weight - .1) / .5) : 0;
                view.labelGroup.setAttribute('opacity', opacity);
                if (opacity > .01) view.label.setAttribute('data-map-label', id);
                else view.label.removeAttribute('data-map-label');
                if (opacity > .01) occupied.push({x: anchor.cx - view.metrics.width * ratio / 2, y: anchor.cy - view.metrics.height * ratio / 2,
                    width: view.metrics.width * ratio, height: view.metrics.height * ratio});
            }
            const markerAnchor = anchor => ({cx: anchor.cx, cy: anchor.cy - geometry.radius * 1.3 * geometry.slope * anchor.scale});
            const current = [...cards.values()].find(view => view.card.current);
            let point = current ? markerAnchor(anchors.get(current.card.tile.element.id)) : null;
            if (flight) {
                // A shared elevator has one moving anchor. Other legs interpolate their real endpoints.
                if (crossFloor && flight.fromId === elevatorId && flight.toId === elevatorId) point = markerAnchor(anchors.get(elevatorId));
                else {
                    const source = crossFloor ? currentLayout[fromIndex].origin : anchors.get(flight.fromId);
                    const target = crossFloor ? currentLayout[toIndex].origin : anchors.get(flight.toId);
                    if (source && target) {
                        const a = markerAnchor(crossFloor ? {cx: source.x, cy: source.y, scale: currentLayout[fromIndex].scale} : source);
                        const b = markerAnchor(crossFloor ? {cx: target.x, cy: target.y, scale: currentLayout[toIndex].scale} : target);
                        point = {cx: interpolate(a.cx, b.cx, progress), cy: interpolate(a.cy, b.cy, progress)};
                    }
                }
            }
            if (point) {
                marker.setAttribute('transform', `translate(${point.cx} ${point.cy})`);
                markerPosition = placeNavigationMapMarkerLabel(point,width,height,locationMetrics,occupied);
                location.setAttribute('x', markerPosition.x - point.cx);
                location.setAttribute('y', markerPosition.y + 12 - point.cy);
                occupied.push(markerPosition);
            }
            svg.mapGeometry = {anchors, layout: currentLayout, cardGroups: new Map([...cards].map(([id, view]) => [id, view.platform])), focus};
            if (travelling) hintLayer.replaceChildren();
        };
        svg.layoutMapLabels = () => renderFrame(null);
        svg.followTravel = flight => { travelling = true; renderFrame(flight); };
        svg.showMapHint = id => {
            hintLayer.replaceChildren();
            const view = cards.get(id), anchor = anchors.get(id);
            if (travelling || !view || !anchor || (anchor.weight === 1 && !view.resident && visibleLabels().includes(view))) return;
            // A single bounded callout reserves space for the real sprite as well as its full title.
            const portraitWidth = view.resident ? 60 : 0;
            const boxWidth = Math.min(width - 16, view.hintMetrics.width + portraitWidth + 24);
            const boxHeight = Math.max(view.resident ? 68 : 0, view.hintMetrics.height + 20);
            const overlaps = box => occupied.some(other => box.x < other.x + other.width + 4 && box.x + box.width + 4 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y);
            const candidates = [[anchor.cx - boxWidth / 2, anchor.cy - boxHeight - 18], [anchor.cx - boxWidth / 2, anchor.cy + 18],
                [anchor.cx + 18, anchor.cy - boxHeight / 2], [anchor.cx - boxWidth - 18, anchor.cy - boxHeight / 2]];
            for (let y = 8; y + boxHeight <= height - 8; y += 20) {
                for (const x of [anchor.cx - boxWidth / 2, width - boxWidth - 8, 8]) candidates.push([x, y]);
            }
            const boxes = candidates.map(([x, y]) => ({x: Math.max(8, Math.min(width - boxWidth - 8, x)), y: Math.max(8, Math.min(height - boxHeight - 8, y)), width: boxWidth, height: boxHeight}));
            const box = boxes.find(candidate => !overlaps(candidate));
            if (!box) return;
            const create = (tag, attributes, parent, text) => {
                const element = document.createElementNS(namespace, tag);
                for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
                if (text !== undefined) element.textContent = text;
                parent.appendChild(element); return element;
            };
            create('path', {d: `M${anchor.cx} ${anchor.cy} L${box.x + boxWidth / 2} ${box.y + boxHeight / 2}`, stroke: '#66778b', 'stroke-width': .7, fill: 'none'}, hintLayer);
            create('rect', {x: box.x, y: box.y, width: boxWidth, height: boxHeight, rx: 5, fill: '#0c0e11', stroke: '#66778b'}, hintLayer);
            if (view.resident) {
                const resident = view.resident;
                const portrait = create('svg', {x: box.x + 8, y: box.y + (boxHeight - 52) / 2, width: 48, height: 52,
                    viewBox: `0 0 ${resident.width} ${resident.height}`, overflow: 'hidden', 'data-map-hint-resident': id}, hintLayer);
                create('image', {href: resident.sprite, width: resident.width * resident.columns, height: resident.height}, portrait);
            }
            const text = create('text', {'data-map-hint': id, 'font-size': 12, fill: '#e2edff'}, hintLayer);
            view.hintMetrics.lines.forEach((line, index) => create('tspan', {x: box.x + 12 + portraitWidth, y: box.y + boxHeight / 2 + 4 + (index - (view.hintMetrics.lines.length - 1) / 2) * 15}, text, line));
        };
        return svg;
    }

}

// Copy method descriptors without introducing an extra controller or constructor.
const descriptors = Object.getOwnPropertyDescriptors(NavigationMapMethods.prototype);
delete descriptors.constructor;
Object.defineProperties(TileManager.prototype, descriptors);
})();
