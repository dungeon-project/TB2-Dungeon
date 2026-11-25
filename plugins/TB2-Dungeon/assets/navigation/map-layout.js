/** Pure isometric floor layout; does not read or modify navigation or DOM state. */
function calculateNavigationMapLayout(groups, width, height, focusPosition, geometry) {
    const layout = [];
    const centerAxis = width * 0.5;
    const spacing = { horizontalInset: 24, topInset: 25, verticalInset: 31,
        minimumWidth: 0.1, minimumHeight: 8, bandPadding: 40 };
    let top = 0;
    // Integer stations reproduce the resting layout; neighboring weights share its budget.
    const focus = typeof focusPosition === 'string'
        ? groups.findIndex(group => group.layer === focusPosition) : focusPosition;
    const position = Math.max(0, Math.min(groups.length - 1, Number(focus) || 0));
    const lower = Math.floor(position), progress = position - lower;
    const blend = progress * progress * (3 - 2 * progress);

    // Measure each footprint once, then share the tightest room scale across all floors.
    // Sparse floors retain breathing room instead of stretching a single room to fill it.
    const footprints = groups.map(group => {
        const corners = [{position: {x: 0, y: 0}}, ...group.cards].flatMap(card => {
            const {x, y} = card.position, margin = geometry.margin;
            return [[x - margin, y - margin], [x + margin, y - margin],
                [x + margin, y + margin], [x - margin, y + margin]]
                .map(([cornerX, cornerY]) => [cornerX - cornerY, (cornerX + cornerY) * geometry.slope]);
        });
        return {minX: Math.min(...corners.map(point => point[0])), maxX: Math.max(...corners.map(point => point[0])),
            minY: Math.min(...corners.map(point => point[1])), maxY: Math.max(...corners.map(point => point[1]))};
    });
    const sharedLeft = Math.max(spacing.minimumWidth, ...footprints.map(bounds => -bounds.minX));
    const sharedRight = Math.max(spacing.minimumWidth, ...footprints.map(bounds => bounds.maxX));
    const sharedHeight = Math.max(...footprints.map(bounds => bounds.maxY - bounds.minY));

    // Equal focus weights now mean equal room sizes, including stations passed in flight.
    for (const [index, group] of groups.entries()) {
        const weight = index === lower ? 1 - blend : index === lower + 1 ? blend : 0;
        const active = weight === 1;
        const inactiveShare = groups.length > 1 ? 0.5 / (groups.length - 1) : 1;
        const bandHeight = height * (inactiveShare + (groups.length > 1 ? 0.5 - inactiveShare : 0) * weight);
        const {minY, maxY} = footprints[index];
        const scale = Math.max(1, Math.min(
            (centerAxis - spacing.horizontalInset) / sharedLeft,
            (width - centerAxis - spacing.horizontalInset) / sharedRight,
            Math.max(spacing.minimumHeight, bandHeight - spacing.bandPadding) / sharedHeight));
        const origin = { x: centerAxis,
            y: top + spacing.topInset + (bandHeight - spacing.verticalInset) / 2 - (minY + maxY) * scale / 2 };
        layout.push({ group, active, weight, top, bandHeight, scale, origin });
        top += bandHeight;
    }
    return layout;
}

/** Keep the fixed-size location caption clear of titles when optional rooms change the layout. */
function placeNavigationMapMarkerLabel(point, width, height, metrics, occupied) {
    const gap = 12, inset = 8, labelHeight = 16;
    const candidates = [
        [point.cx + gap, point.cy - 20], [point.cx - gap - metrics.width, point.cy - 20],
        [point.cx - metrics.width / 2, point.cy - 38],
        [point.cx + gap, point.cy + gap], [point.cx - gap - metrics.width, point.cy + gap]
    ].map(([x,y]) => ({x: Math.max(inset, Math.min(width - metrics.width - inset, x)),
        y: Math.max(inset, Math.min(height - labelHeight - inset, y)), width: metrics.width, height: labelHeight}));
    const overlaps = box => occupied.some(other => box.x < other.x + other.width + 4 &&
        box.x + box.width + 4 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y);
    return candidates.find(box => !overlaps(box)) || candidates[0];
}

/** Frame-independent map state derived from the live navigation animation, including docking. */
function navigationMapFlight(manager, travel) {
    const leg = travel?.leg;
    if (!leg || manager.motionPreference.matches) return null;
    const transition = manager.transition;
    const animation = transition?.animations[0] || manager.layers[leg.toLayer].grid.getAnimations()[0];
    // Between chained legs, activation runs before the next animation exists. Stay at the
    // real station instead of treating the later route destination as already reached.
    if (!animation) {
        const currentId = manager.getTileAt(manager.currentX, manager.currentY).element.id;
        return {fromId: currentId, toId: currentId, fromLayer: manager.activeLayer,
            toLayer: manager.activeLayer, progress: 1};
    }
    const progress = Math.max(0, Math.min(1, animation?.effect.getComputedTiming().progress ?? 1));
    const fromLayer = transition?.sourceLayer || leg.fromLayer;
    const toLayer = transition?.layer || leg.toLayer;
    // Docking is already at the station. A trimmed leg reaches it at its real shortened end.
    let position = transition?.docking ? 1 : progress;
    if (transition?.elevator && !transition.docking) {
        const pullback = manager.travelDuration(TileManager.motion.pullback);
        const dock = manager.travelDuration(TileManager.motion.dock);
        const duration = Number(animation?.effect.getTiming().duration) || dock;
        // Late retargeting only adjusts the camera at an already reached station.
        position = transition.trimmed && duration <= pullback ? 1
            : Math.max(0, Math.min(1, (Number(animation?.currentTime || 0) - pullback) / (dock - pullback)));
    }
    const center = layer => manager.getTileAt(...manager.layerCenter(TileManager.layerOrder.indexOf(layer))).element.id;
    return { fromId: transition ? center(fromLayer) : leg.fromId, fromLayer,
        toId: transition ? transition.tile.element.id : leg.toId, toLayer, progress: position };
}
