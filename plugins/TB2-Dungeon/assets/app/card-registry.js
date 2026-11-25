/** Built-in extensions register definitions; the application owns their lifecycle. */
window.CoreFlasherApp = window.CoreFlasherApp || {};
CoreFlasherApp.cardTemplates = Object.create(null);
CoreFlasherApp.cardControllers = Object.create(null);

class CardRegistry {
    constructor() { this.definitions = []; this.instances = new Map(); }

    /** Reject ambiguous identities before any card can bind events or start work. */
    register(definition) {
        if (!definition.id || typeof definition.createView !== 'function' ||
            typeof definition.createController !== 'function') throw new Error('Invalid card definition.');
        if (this.get(definition.id)) throw new Error(`Duplicate card ID: ${definition.id}`);
        if (definition.shortcut && this.definitions.some(card => card.shortcut === definition.shortcut))
            throw new Error(`Duplicate card shortcut: ${definition.shortcut}`);
        if (definition.shortcut && ['m', 'h'].includes(definition.shortcut))
            throw new Error(`Reserved card shortcut: ${definition.shortcut}`);
        this.definitions.push(Object.freeze(definition));
    }

    /** Visibility differs from action enablement; Dev keeps local folder tools accessible. */
    isVisible(card, context = window.CoreFlasherApp.context) {
        const definition = typeof card === 'string' ? this.get(card) : this.definitionFor(card);
        return !!definition && (window.DEV_MODE === true || (definition.visibility !== 'dev' &&
            (!definition.requiresTb2Usb || context?.usbPresence.state.present === true)));
    }
    get(id) { return this.definitions.find(definition => definition.id === id); }
    definitionFor(card) { return this.get(typeof card === 'string' ? card : card.element.id); }

    /** Validate the complete set, including the elevator's reserved center positions. */
    validate(context) {
        const positions = new Set();
        const addresses = new Set();
        for (const card of this.definitions) {
            for (const dependency of card.dependencies || []) {
                if (!(dependency in context)) throw new Error(`Card ${card.id} requires ${dependency}.`);
            }
            const address = `${card.legacyCoordinates.x},${card.legacyCoordinates.y}`;
            if (addresses.has(address)) throw new Error(`Duplicate card address: ${address}`);
            addresses.add(address);
            for (const layer of card.placement.allowedLayers || [card.placement.layer]) {
                const position = `${layer}:${card.placement.x},${card.placement.y}`;
                if (positions.has(position)) throw new Error(`Duplicate card position: ${position}`);
                positions.add(position);
            }
        }
    }

    /** Templates keep control IDs; metadata is authoritative for navigation and category. */
    mount(canvas) {
        const failed = new Set();
        for (const card of this.definitions) {
            if (failed.has(card.packageId)) continue;
            try {
            const element = card.createView();
            if (!element || element.id !== card.id) throw new Error(`Invalid view for ${card.id}.`);
            Object.assign(element.dataset, {
                x: card.legacyCoordinates.x, y: card.legacyCoordinates.y,
                navX: card.placement.x, navY: card.placement.y, layer: card.placement.layer,
                category: card.category, devView: String(card.visibility === 'dev')
            });
            element.querySelector('h1, h2').textContent = card.title;
            if (card.visibility === 'dev') element.classList.add('dev-only');
            if (card.requiresTb2Usb) {
                element.hidden = !this.isVisible(card.id);
                element.dataset.usbTool = 'true';
            }
            canvas.appendChild(element);
            } catch (error) {
                if (!card.packageId) throw error;
                failed.add(card.packageId);
                CoreFlasherApp.extensions.disable(card.packageId,error);
                console.error(`Extension ${card.packageId} view failed:`,error);
            }
        }
        for (const card of this.definitions) if (failed.has(card.packageId)) canvas.querySelector(`#${card.id}`)?.remove();
        this.definitions = this.definitions.filter(card=>!failed.has(card.packageId));
    }

    /** All controllers exist before initialization; providers can safely find peers. */
    instantiate(manager, canvas, context) {
        let cards = [];
        const failed = new Set();
        const discard = (definition, error) => {
            if (!definition.packageId) throw error;
            failed.add(definition.packageId);
            CoreFlasherApp.extensions.disable(definition.packageId,error);
            console.error(`Extension ${definition.packageId} initialization failed:`,error);
        };
        for (const definition of this.definitions) {
            if (failed.has(definition.packageId)) continue;
            const element = canvas.querySelector(`#${definition.id}`);
            try {
                const controller = definition.createController(context, element);
                controller.definition = definition;
                controller.setManager(manager);
                this.instances.set(definition.id, controller);
                cards.push(controller);
            } catch (error) { discard(definition,error); }
        }
        manager.tiles = cards;
        context.attach(manager);
        // Constructors previously ran before the manager published its card array.
        // Defer peer refreshes until the complete set has initialized its controls.
        manager.cardsInitializing = true;
        try {
            for (const controller of cards) {
                if (failed.has(controller.definition.packageId)) continue;
                try { controller.initialize(); }
                catch (error) { discard(controller.definition,error); }
            }
        } finally {
            manager.cardsInitializing = false;
        }
        // Startup never starts device work; dispose listeners/timers of rejected packages.
        for (const controller of cards) if (failed.has(controller.definition.packageId)) {
            Promise.resolve(controller.dispose()).catch(error=>console.error('Extension cleanup failed:',error));
            this.instances.delete(controller.definition.id);
        }
        for (const definition of this.definitions) if (failed.has(definition.packageId))
            canvas.querySelector(`#${definition.id}`)?.remove();
        this.definitions = this.definitions.filter(definition=>!failed.has(definition.packageId));
        cards = cards.filter(controller=>!failed.has(controller.definition.packageId));
        manager.tiles = cards;
        return cards;
    }

    /** Dispose in reverse registration order after the existing operation gates admit it. */
    async dispose() {
        for (const controller of [...this.instances.values()].reverse()) await controller.dispose();
        this.instances.clear();
    }
}
CoreFlasherApp.CardRegistry = CardRegistry;
CoreFlasherApp.registry = new CardRegistry();
