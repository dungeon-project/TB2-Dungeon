/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-firmware-0408"] = `<section class="tile tile-disabled pos-1-2" data-x="1" data-y="2"
                data-tile-class="AlternativeUuidTile" data-requires-source="alternative" id="tile-firmware-0408" data-layer="workspace" data-nav-x="2" data-nav-y="0">
                <div class="cf-firmware-layout flex flex-col terminal-scroll">
                    <header><h2 class="text-4xl font-display font-black text-white tracking-tighter">Detect UUID (Alternative)</h2><p class="cf-firmware-muted mt-2">Requires the box to be running Diagnostic Image (Production).</p></header>
                    <div class="cf-firmware-panel">
                        <h3 class="text-white font-bold">Read UUID via USB-C</h3>
                        <p class="js-fw-part2 cf-firmware-muted mt-2">Disconnect SPI, connect the UX board, then connect USB-C to the PC. Boot the prepared Diagnostic Image (Production), then read the MCU UUID from its detected USB-C interface. The box cannot boot without the UX board.</p>
                        <label class="js-usb-device-label mt-2" hidden>USB device<select class="js-usb-device" aria-label="USB device"></select></label>
                        <p class="js-usb-device-status cf-firmware-muted mt-2" role="status"></p>
                        <button class="js-fw-serial cf-dump-button mt-3" type="button" disabled>Read MCU UUID via USB-C</button>
                        <button class="js-fw-serial-cancel cf-dump-button mt-2" type="button" hidden>Cancel</button>
                        <div class="js-usb-query-panel mt-3 rounded border border-zinc-700 p-3" hidden>
                            <p class="js-usb-query-status text-sm" role="status" aria-live="polite" aria-atomic="true"></p>
                            <progress class="js-usb-query-progress w-full mt-2" aria-label="USB UUID query in progress" hidden></progress>
                        </div>
                        <div class="js-usb-uuid-result found-card mt-3">
                            <label class="found-title" for="usb-found-uuid">Microcontroller UUID</label>
                            <div class="flex flex-wrap items-center gap-3">
                                <input id="usb-found-uuid" class="found-uuid flex-1 min-w-0" type="text" maxlength="16" spellcheck="false" autocomplete="off" aria-label="Microcontroller UUID">
                                <button class="js-usb-uuid-save cf-dump-button" type="button" disabled>Save UUID</button>
                                <button class="js-usb-uuid-load cf-dump-button" type="button">Load UUID</button>
                            </div>
                            <p class="js-usb-uuid-save-status cf-firmware-muted mt-2" role="status"></p>
                        </div>
                    </div>
                    <div class="cf-firmware-panel">
                        <p class="cf-firmware-muted">After the query, disconnect USB before reconnecting SPI. Save UUID stores the value for a box in Image Manager without changing the image. Continue to MITM opens its preparation tools.</p>
                        <button class="js-fw-mitm cf-dump-button mt-3" type="button" disabled>Continue to MITM</button>
                    </div>
                </div>

            </section>`;
