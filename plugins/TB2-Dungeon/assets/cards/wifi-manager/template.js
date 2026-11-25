/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-wifi-manager"] = `<section class="tile tile-disabled" data-x="2" data-y="2"
                data-tile-class="WifiManagerTile" id="tile-wifi-manager" data-layer="settings" data-nav-x="-1" data-nav-y="0">
                <div class="cf-wifi-layout">
                    <header>
                        <p class="cf-firmware-muted">WiFi · Working image</p>
                        <h2 class="text-4xl font-display font-black text-white tracking-tighter">WiFi Manager</h2><button class="js-enable-edit cf-dump-button" type="button">Enable Read / Write</button>
                    </header>
                    <p class="js-wifi-note cf-firmware-muted">Up to ten WiFi profiles. Credentials stay local.</p>
                    <div class="js-wifi-rows cf-wifi-rows terminal-scroll" aria-label="WiFi profiles"></div>
                    <div class="flex gap-3 flex-wrap">
                        <button class="js-wifi-save cf-dump-button cf-dump-button-primary" type="button" disabled>Apply to working image</button>
                        <button class="js-wifi-reload cf-dump-button" type="button" disabled>Discard / reload</button>
                    </div>
                    <p class="js-wifi-status cf-firmware-muted" role="status" aria-live="polite">Load a complete working image or create a backup.</p>
                </div>

            </section>`;
