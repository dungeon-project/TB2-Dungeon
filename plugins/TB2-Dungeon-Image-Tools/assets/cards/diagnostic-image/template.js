/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-boot-image"] = `<section class="tile tile-disabled" data-x="2" data-y="-1"
                data-tile-class="BootImageTile" data-start-enabled="true" id="tile-boot-image" data-layer="images" data-nav-x="0" data-nav-y="1">
                <div class="cf-firmware-layout flex flex-col terminal-scroll">
                    <header>
                        <h2 class="text-4xl font-display font-black text-white tracking-tighter">Diagnostic Image (Production)</h2>
                        <p class="cf-firmware-muted mt-3">Prepares the working image for SD Content Backup, TeddyBench 2 Web or the alternative UUID query.</p>
                    </header>
                    <div class="cf-firmware-panel">
                        <p class="text-sm text-zinc-200">This is not a factory reset, even if the box appears unconfigured afterwards. Data on the SD card remains untouched. This is a temporary service image. After the USB tasks, load a regular image or prepare one with Build Update Image and ENDUSER (04), then flash it for normal operation. If the box already runs a suitable diagnostic image, continue directly with the USB tools.</p>
                    </div>
                    <div class="flex flex-wrap gap-3">
                        <button class="js-fw-load cf-dump-button" type="button">Load dump</button>
                        <input class="js-fw-file" type="file" accept=".bin,.gz" hidden>
                        <button class="js-fw-prepare cf-dump-button cf-dump-button-primary" disabled type="button">Prepare image</button>
                        <button class="js-fw-dump cf-dump-button" type="button">Jump to Flash</button>
                    </div>
                    <p class="cf-firmware-muted">After flashing, continue with one of the following steps, depending on what you want to do:</p>
                    <div class="flex flex-wrap gap-3">
                        <button class="js-boot-content cf-dump-button" type="button">SD Content Backup</button>
                        <button class="js-boot-teddybench cf-dump-button" type="button">TeddyBench 2 Web (beta)</button>
                        <button class="js-boot-uuid cf-dump-button" type="button">Detect UUID (Alternative)</button>
                    </div>
                    <p class="js-fw-status cf-firmware-muted" role="status" aria-live="polite">Load a 0.40.8 dump or resource file, then prepare a complete working image.</p>
                    <p class="js-fw-error text-error text-sm" role="alert" hidden></p>
                </div>

            </section>`;
