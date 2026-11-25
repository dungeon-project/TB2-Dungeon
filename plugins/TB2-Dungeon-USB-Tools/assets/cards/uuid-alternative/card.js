/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-firmware-0408",
    title: "Detect UUID (Alternative)",
    shortTitle: "UUID Alternative",
    category: "safe",
    shortcut: "a",
    placement: {"layer": "workspace", "x": 2, "y": 0},
    legacyCoordinates: {"x": 1, "y": 2},
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
