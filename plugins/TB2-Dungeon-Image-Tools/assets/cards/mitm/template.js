/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-mitm-setup"] = `<section class="tile tile-disabled pos-0-1" data-x="0" data-y="1"
                data-tile-class="MitmSetupTile" id="tile-mitm-setup" data-layer="images" data-nav-x="-1" data-nav-y="0">
                <div class="cf-mitm-layout overflow-y-auto terminal-scroll">
                    <header class="cf-mitm-header">
                        <div>
                            <h2 class="text-4xl font-display font-black text-white tracking-tighter">MITM Setup</h2>
                            <p>Replace the trusted server CA. Box identity stays unchanged; nothing is flashed here.</p>
                        </div>
                        <span class="dev-only text-[10px] font-mono bg-zinc-800 px-3 py-1 text-zinc-400">MODULE_0x07</span>
                    </header>

                    <div class="cf-mitm-requirements">
                        <div class="cf-mitm-requirement-list">
                            <div><span>Image</span><strong class="js-mitm-req-image">Missing</strong></div>
                            <div><span>MCU UUID</span><strong class="js-mitm-req-uuid">Missing</strong></div>
                            <div><span>Access</span><strong class="js-mitm-req-write">Read Only</strong></div>
                            <div hidden><span>Identity export</span><strong class="js-mitm-req-backup">Optional</strong></div>
                            <div><span>Server CA</span><strong class="js-mitm-req-ca">Not selected</strong></div>
                        </div>
                        <button class="js-mitm-go-options cf-mitm-button" type="button">Enable Read / Write</button><button class="js-mitm-find-uuid cf-mitm-button" type="button">Detect UUID</button><button class="js-mitm-load-uuid cf-mitm-button" type="button">Load UUID</button>
                        <p class="js-mitm-write-help cf-mitm-write-help">Enable <strong>Read / Write</strong> before preparing the image. Changes remain buffered.</p>
                    </div>

                    <details class="cf-mitm-setup-details" open>
                        <summary>Server CA <span class="cf-mitm-setup-state">Select a CA</span></summary>
                        <div class="cf-mitm-columns">
                            <div class="cf-mitm-card cf-mitm-certificates">
                                <div class="cf-mitm-card-heading">
                                    <h3>Select the server CA</h3>
                                    <span class="js-mitm-cert-mode cf-mitm-tag">No CA selected</span>
                                </div>
                                <label>Certificate source <select class="js-mitm-ca-source cf-mitm-button"><option value="file">CA file</option><option value="folder">Server certificate folder</option></select></label>
                                <label class="cf-mitm-server-set-label" hidden>
                                    <span class="cf-mitm-field-label">TeddyCloud server set</span>
                                    <input class="js-mitm-server-set" aria-label="TeddyCloud server certificate folder" type="file" webkitdirectory multiple />
                                    <span class="js-mitm-server-set-name cf-mitm-file-name">No server set selected</span>
                                </label>
                                <div class="cf-mitm-detail cf-mitm-ca-fallback">
                                    <label>
                                        <span class="cf-mitm-field-label">Existing DER CA</span>
                                        <input class="js-mitm-ca" aria-label="Existing DER CA file" accept=".der,.cer,.crt,application/pkix-cert" type="file" />
                                        <span class="js-mitm-ca-name cf-mitm-file-name">No CA selected</span>
                                    </label>
                                    <p>Only this CA is placed in the image. Matching server certificates and private keys must already exist on TeddyCloud. CA-only mode cannot produce a complete certificate package.</p>
                                </div>
                                <details class="cf-mitm-detail">
                                    <summary>Required files &amp; certificate behavior</summary>
                                    <p>Select the existing <strong>server_tb2</strong> folder: ca.der, ca-root.pem, ca-key.pem, teddy-cert.pem and teddy-key.pem. An existing ici.pem + ici.key pair is optional; this build does not generate a missing pair.</p>
                                    <p>A server set or CA file is required. TB2 Dungeon never invents a CA or key pair. Without a selection the original box CA remains unchanged.</p>
                                </details>
                            </div>
                        </div>
                    </details>

                    <details class="cf-mitm-detail"><summary>Exports</summary>
                            <div class="cf-mitm-card cf-mitm-backup">
                                <div class="cf-mitm-card-heading">
                                    <h3>Export box identity</h3>
                                    <span class="js-mitm-backup-state cf-mitm-tag">Optional</span>
                                </div>
                                <p>Optional identity export. <strong>Keep this backup private: it contains the box's private key.</strong></p>
                                <button class="js-mitm-backup cf-mitm-button cf-mitm-button-backup" disabled type="button">Download source identity</button>
                                <details class="cf-mitm-detail">
                                    <summary>Backup contents &amp; confirmation</summary>
                                    <p>Includes the original encrypted identity files, settings, and decrypted ca.der, client.der and private.der. This export is not a full flash backup.</p>
                                </details>
                            </div>
                    <div class="cf-mitm-package-row">
                        <p class="js-mitm-package-note">Select a complete server set to export a certificate package.</p>
                        <button class="js-mitm-package-download cf-mitm-button" disabled type="button">Download certificate package</button>
                    </div>

</details>
                    <details class="cf-mitm-detail cf-mitm-endpoints">
                        <summary>Optional server endpoints <span class="cf-mitm-endpoint-state">Unchanged</span></summary>
                        <label class="cf-mitm-checkbox">
                            <input class="js-mitm-settings-toggle" type="checkbox" />
                            <span>Change OTA and MQTT/ICI hostnames and ports</span>
                        </label>
                        <p>Leave this disabled to preserve current values. Closing this section does not discard enabled changes.</p>
                        <div class="js-mitm-settings-grid cf-mitm-endpoint-grid opacity-40">
                            <label><span class="cf-mitm-field-label">OTA hostname</span><input class="js-mitm-ota-host" disabled type="text" /></label>
                            <label><span class="cf-mitm-field-label">OTA port</span><input class="js-mitm-ota-port" disabled inputmode="numeric" type="text" /></label>
                            <label><span class="cf-mitm-field-label">MQTT/ICI hostname</span><input class="js-mitm-ici-host" disabled type="text" /></label>
                            <label><span class="cf-mitm-field-label">MQTT/ICI port</span><input class="js-mitm-ici-port" disabled inputmode="numeric" type="text" /></label>
                        </div>
                    </details>

                    <details class="cf-mitm-detail cf-mitm-explanation">
                        <summary>What changes? · review the selected configuration</summary>
                        <p class="js-mitm-summary">No server CA selected. The original box CA remains unchanged and preparation is unavailable.</p>
                        <p><strong>Changed:</strong> /cert/ca.der.crypt, plus /settings only when endpoint changes are enabled.</p>
                        <p><strong>Unchanged:</strong> client.der, private.der, AP-mode credential and ICI credential. These identity files are checked after preparation.</p>
                        <p><strong>Not flashed:</strong> preparation only modifies the buffered image. Download or archive the image, or use the applicable write action in Dump / Flash.</p>
                    </details>

                    <div class="cf-mitm-result">
                        <div class="cf-mitm-actions">
                            <button class="js-mitm-apply cf-mitm-button cf-mitm-button-primary" disabled type="button">Prepare MITM image</button>
                            <button class="js-mitm-reset cf-mitm-button" type="button">Reset selection</button><span class="settings-help">Resets inputs; applied image changes remain.</span>
                            <span class="cf-mitm-prepared-hint">Ready for the next step</span>
                        </div>
                        <div class="cf-mitm-progress" hidden aria-live="polite">
                            <div class="js-mitm-progress-encrypt border border-zinc-800 text-zinc-500">1 · Prepare server CA</div>
                            <div class="js-mitm-progress-write border border-zinc-800 text-zinc-500">2 · Update buffered LittleFS</div>
                            <div class="js-mitm-progress-verify border border-zinc-800 text-zinc-500">3 · Verify identity and settings</div>
                        </div>
                        <div class="js-mitm-success hidden cf-mitm-success" role="status" aria-live="polite">
                            <div class="cf-mitm-success-heading">
                                <p>MITM image prepared and verified</p>
                                <svg class="cf-mitm-success-icon" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6"/></svg>
                            </div>
                            <p>CA and optional endpoints are prepared. Box identity was verified unchanged. <strong>The physical flash has not been written yet.</strong></p>
                            <div class="cf-mitm-actions">
                                <button class="js-mitm-success-interface cf-mitm-button cf-mitm-button-primary" type="button">Go to Dump / Flash</button>
                                <button class="js-mitm-download-image cf-mitm-button" type="button">Download image</button><button class="js-mitm-save-image cf-mitm-button" type="button">Save to Image Manager</button>
                                <button class="js-mitm-success-package cf-mitm-button" disabled type="button">Download certificate package</button>
                            </div>
                            <p class="cf-mitm-next-help">Next: click <strong>Write Changes</strong> in Dump / Flash. For a disk image, use <strong>Dump / Flash → Save Image to Disk</strong>.</p>
                        </div>
                        <div class="error-box js-mitm-error hidden"></div>
                        <p class="js-mitm-status cf-mitm-status" role="status"><span class="prod-only">Load or connect an image to continue</span><span class="dev-only">AWAITING_INTERFACE_IMAGE</span></p>
                    </div>
                </div>

            </section>`;
