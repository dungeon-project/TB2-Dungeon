/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-content-backup",
    title: "SD Content Backup",
    shortTitle: "SD Content Backup",
    category: "edit",
    shortcut: "b",
    placement: {"layer": "workspace", "x": -1, "y": -1},
    legacyCoordinates: {"x": 0, "y": 2},
    visibility: "all",
    requiresTb2Usb: true,
    dependencies: ["image", "filesystem", "hardware", "operations", "uuid", "navigation", "settings", "dialogs", "usbPresence"],
    createView() {
        const template = document.createElement("template");
        template.innerHTML = CoreFlasherApp.cardTemplates[this.id];
        return template.content.firstElementChild;
    },
    createController(context, element) {
        return new CoreFlasherApp.cardControllers[this.id](element, context);
    }
});
