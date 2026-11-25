/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-mitm-setup",
    title: "MITM Setup",
    shortTitle: "MITM",
    // Reuse the front-facing sprite as the room's resident, not an unrelated symbol.
    mapResident: {
        label: 'Minotaur · End boss',
        sprite: CoreFlasherApp.extensions.asset('image-tools', 'assets/cards/mitm/minotaur/snort.webp'),
        width: 168, height: 182, columns: 8
    },
    category: "edit",
    shortcut: "x",
    placement: {"layer": "images", "x": -1, "y": 0},
    legacyCoordinates: {"x": 0, "y": 1},
    visibility: "all",
    dependencies: ["image", "filesystem", "hardware", "operations", "uuid", "navigation", "settings", "dialogs"],
    createView() {
        const template = document.createElement("template");
        template.innerHTML = CoreFlasherApp.cardTemplates[this.id];
        return template.content.firstElementChild;
    },
    createController(context, element) {
        return new CoreFlasherApp.cardControllers[this.id](element, context);
    }
});
