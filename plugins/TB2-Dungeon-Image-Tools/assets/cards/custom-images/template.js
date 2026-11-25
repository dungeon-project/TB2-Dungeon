/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-custom-image"] = `<section class="tile tile-disabled" data-x="3" data-y="0" data-tile-class="CustomImageTile"
                data-start-enabled="true" id="tile-custom-image" data-layer="images" data-nav-x="1" data-nav-y="0">
                <div class="cf-firmware-layout cf-custom-layout flex flex-col terminal-scroll">
                    <header><h2 class="text-4xl font-display font-black text-white tracking-tighter">Build Update Image</h2>
                        <p class="cf-firmware-muted mt-2">Prepare an update image while retaining the source settings and certificates.</p></header>
                    <div class="cf-custom-inputs">
                        <div><span class="cf-firmware-muted">Source image</span><p data-custom="source" class="cf-custom-name" tabindex="0">No working image loaded</p></div>
                        <div><span class="cf-firmware-muted">Target firmware source</span><p data-custom="target" class="cf-custom-name" tabindex="0">Not selected</p>
                            <button data-custom="select" class="cf-dump-button mt-1" type="button">Select full dump</button>
                            <button data-custom="select-ota" class="cf-dump-button mt-1" type="button">Select OTA file</button>
                            <input data-custom="ota-file" type="file" accept=".bin" aria-label="Select OTA file" hidden />
                            <input data-custom="file" type="file" accept=".bin" aria-label="Select full dump" hidden /></div>
                    </div>
                    <p class="cf-firmware-muted">Choose one target: a full dump or an OTA file. A new selection replaces the previous one.</p>
                    <div data-custom="firmware-choice" hidden>
                        <label class="cf-firmware-muted">Firmware from full dump
                            <select data-custom="firmware-option" class="cf-dump-button mt-1" aria-label="Firmware version and slot from full dump" disabled></select>
                        </label>
                    </div>
                    <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm text-white">
                        <span>Target firmware: <strong data-custom="version">Not selected</strong></span>
                        <span>Firmware slot: <strong data-custom="slot">—</strong></span>
                        <span>Other slot: <strong data-custom="other-slot">—</strong></span>
                    </div>
                    <ul data-custom="checks" class="cf-custom-checks" aria-label="Image checks"></ul>
                    <div class="cf-custom-lifecycle" role="group" aria-label="Lifecycle mode">
                        <div class="flex flex-wrap gap-2 items-center">
                            <strong>Lifecycle mode</strong>
                            <select data-custom="lifecycle-mode" class="cf-dump-button" aria-label="Lifecycle mode" disabled>
                                <option value="keep">Keep source value</option>
                                <option value="4">Normal operation — ENDUSER (04)</option>
                                <option value="2">Delivery state — LOGISTIC (02)</option>
                                <option value="1">Service / manufacturing — PRODUCTION (01)</option>
                            </select>
                        </div>
                        <div class="cf-custom-lifecycle-values" aria-live="polite">
                            <p>Source: <span data-custom="lifecycle-original">Unknown</span></p>
                            <p>Selected: <span data-custom="lifecycle-selected">Keep original: Unknown</span></p>
                            <p>Verified output: <span data-custom="lifecycle-result">Not built</span></p>
                        </div>
                        <p class="cf-firmware-muted">Only the generated full image changes. ENDUSER (04) selects normal mode; other startup requirements still apply.</p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <button data-custom="check" class="cf-dump-button" type="button">Check again</button>
                        <button data-custom="build" class="cf-dump-button cf-dump-button-primary" type="button" disabled>Build update image</button>
                        <button data-custom="wifi" class="cf-dump-button" type="button" hidden>Open WiFi Manager</button>
                    </div>
                    <p data-custom="status" class="cf-firmware-muted" role="status" aria-live="polite">Load a complete source image and select a full dump or an OTA file.</p>
                    <div class="flex flex-wrap gap-2">
                        <button data-custom="download" class="cf-dump-button" type="button" disabled>Download image</button>
                        <button data-custom="flash" class="cf-dump-button" type="button" disabled>Go to Full Flash</button>
                        <button data-custom="back" class="cf-dump-button" type="button">Back to Dump / Flash</button>
                    </div>
                </div>

            </section>`;
