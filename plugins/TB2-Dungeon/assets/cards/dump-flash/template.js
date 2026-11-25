/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-interface-options"] = `<section class="tile tile-disabled pos-0-0" data-x="0" data-y="0" data-tile-class="InterfaceOptionsTile" id="tile-interface-options" data-layer="settings" data-nav-x="0" data-nav-y="0">
                <div class="p-12 flex-1 cf-dump-layout terminal-scroll">
                    <header class="cf-dump-header">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <h1 class="text-6xl font-display font-black tracking-tighter text-white">Dump / Flash</h1>
                            <div class="flex flex-wrap items-center gap-2">
                                <button type="button" class="layer-link js-open-custom" data-build-card="tile-custom-image">Build Update Image</button>
                                <button type="button" class="layer-link" data-build-card="tile-boot-image">Build Diagnostic Image</button>
                                <button type="button" class="layer-link" data-build-card="tile-mitm-setup">Build MITM Image</button>
                            </div>
                        </div>
                        <p class="cf-dump-subtitle">Backup, export and write your flash image.</p>
                    </header>
                    <div class="cf-dump-context">
                        <div class="cf-dump-context-info">
                            <div><span class="cf-dump-label">Source</span><span class="js-df-source">No source selected</span><span class="cf-dump-dot">·</span><span class="js-df-connection">Not connected</span></div>
                            <div><span class="cf-dump-label">Image</span><span class="js-df-context-image">No image</span><span class="cf-dump-dot">·</span><span class="js-df-context-size">—</span></div>
                        </div>
                        <div><div class="cf-dump-modes"><label class="js-iface-mode-row flex items-center gap-3 cursor-pointer hover:text-white" data-mode="readonly">
<input checked="" class="js-iface-mode bg-zinc-900 border-zinc-700 text-primary w-4 h-4 rounded-none" name="iface-mode" type="radio" value="readonly"/>
<span>Read Only</span>
</label>
<label class="js-iface-mode-row flex items-center gap-3 cursor-pointer hover:text-white" data-mode="rw-buffered">
<input class="js-iface-mode bg-zinc-900 border-zinc-700 text-primary w-4 h-4 rounded-none" name="iface-mode" type="radio" value="rw-buffered"/>
<span><span class="prod-only">Read / Write</span><span class="dev-only">Read / Write Buffered</span></span>
</label>
<label class="js-iface-mode-row js-immediate-mode-row dev-only flex items-center gap-3 cursor-pointer hover:text-white" data-mode="rw-immediate">
<input class="js-iface-mode bg-zinc-900 border-zinc-700 text-primary w-4 h-4 rounded-none" name="iface-mode" type="radio" value="rw-immediate"/>
<span>Read / Write Immediately</span>
</label></div><p class="js-df-mode-reason cf-dump-reason"></p></div>
                    </div>
                    <div class="js-df-physical-warning cf-dump-physical-warning" role="alert" hidden>
                        <strong>Physical flash is not verified.</strong> A previous write was interrupted or failed.
                        Loading a backup does not repair the device. Run Verify Flash to compare it, or restore a full image and complete its verification.
                    </div>
                    <div class="cf-dump-cards">
                        <div class="cf-dump-card" role="group" aria-label="Dump and backup">
                            <div class="cf-dump-card-head"><h2>Dump &amp; Backup</h2><span class="js-webusb-dump-verified cf-dump-tag">NOT AVAILABLE</span></div>
                            <div><p class="js-df-backup-name cf-dump-file">No backup selected</p><p class="js-df-backup-size cf-dump-small">—</p></div>
                            <p class="js-df-backup-origin cf-dump-muted"></p>
                            <p class="js-df-backup-note cf-dump-note"></p>
                            <div class="cf-dump-card-bottom">
                                <button class="js-webusb-full-verify cf-dump-button cf-dump-button-backup" type="button" disabled>Create Backup</button>
                                <p class="js-df-reason-create cf-dump-reason"></p>
                                <div class="cf-dump-actions" style="margin-top:10px">
                                    <button class="js-webusb-load-verified cf-dump-button" type="button">Load Backup</button>
                                    <button class="js-webusb-download-verified cf-dump-button" type="button" disabled>Download Backup</button>
                                </div>
                                <p class="js-df-reason-load cf-dump-reason"></p><p class="js-df-reason-download cf-dump-reason"></p>
                            </div>
                        </div>
                        <div class="cf-dump-card" role="group" aria-label="Current image and changes">
                            <div class="cf-dump-card-head"><h2>Current Image &amp; Changes</h2></div>
                            <div><p class="js-df-image-name cf-dump-file">No image loaded</p><p class="cf-dump-small"><span class="js-df-image-size">—</span><span class="cf-dump-dot">·</span><span class="js-df-image-complete"></span></p></div>
                            <p class="js-df-changes-title cf-dump-muted">No pending changes</p>
                            <p class="js-buffered-write-status cf-dump-file">0 sectors</p>
                            <p class="js-df-changes-note cf-dump-note"></p>
                            <div class="cf-dump-card-bottom">
                                <button class="js-write-now-btn cf-dump-button cf-dump-button-primary" type="button" disabled>Write Changes</button>
                                <span class="js-primary-full-slot"></span>
                                <p class="js-df-reason-write cf-dump-reason"></p>
                                <div class="cf-dump-actions" style="margin-top:10px">
                                    <button class="js-discard-changes cf-dump-button" type="button" disabled>Discard Changes</button>
                                    <button class="js-df-save-image cf-dump-button" type="button" disabled>Save Image to Disk</button>
                                    <button class="cf-dump-button" type="button" data-image-manager="save">Save to Image Manager</button>
                                </div>
                                <p class="js-df-reason-discard cf-dump-reason"></p><p class="js-df-reason-export cf-dump-reason"></p>
                            </div>
                        </div>
                    </div>
                    <p class="js-df-hardware-note cf-dump-hardware-note">Connect a supported reader to read, write or verify physical flash. Image export and buffered editing do not need a hardware connection.</p>
                    <div class="cf-dump-secondary">
                        <div><button class="js-verify-current cf-dump-button" type="button" disabled>Verify Flash</button>
                            <p class="cf-dump-note">Compare the device with the current image, including pending changes. Nothing is written.</p>
                            <p class="js-df-reason-verify cf-dump-reason"></p><p class="js-df-verification-summary cf-dump-muted"></p></div>
                        <details class="js-more-writes"><summary>More write options</summary><div class="js-secondary-full-slot"><button class="js-write-fulldump cf-dump-button" type="button" disabled>Write full image</button></div><button class="js-full-image-flash cf-dump-button" type="button" disabled>Flash Full Image…</button>
                            <p class="cf-dump-note">Select a separate 16 MiB BIN to write and verify. This is not Write Changes.</p>
                            <p class="js-df-reason-full cf-dump-reason"></p></details>
                    </div>
                    <div class="js-df-operation cf-dump-operation" hidden aria-live="polite" aria-atomic="true">
                        <div class="cf-dump-operation-head"><span class="js-df-operation-title cf-dump-operation-title"></span><span class="js-df-operation-badge cf-dump-operation-badge"></span></div>
                        <p class="js-df-operation-message cf-dump-operation-message"></p>
                        <div class="js-df-progress-wrap cf-dump-progress-track" role="progressbar" aria-label="Operation progress" aria-valuemin="0" aria-valuemax="100" hidden><div class="js-df-progress cf-dump-progress"></div></div>
                        <pre class="js-df-operation-detail dev-only cf-dump-small" style="white-space:pre-wrap" hidden></pre>
                        <button class="js-webusb-dump-stop cf-dump-button hidden" type="button" disabled style="margin-top:10px">Stop</button>
                    </div>
                    <input class="js-webusb-load-verified-input hidden" type="file" accept=".bin,application/octet-stream" />
                    <input class="js-full-image-input hidden" type="file" accept=".bin,application/octet-stream" />
                    <div class="js-webusb-readonly-panel dev-only cf-dump-dev">
                        <div>Chip <span class="js-webusb-options-chip">not detected</span> · <span class="js-webusb-mode-badge">Read Only</span></div>
                        <div>Original backup SHA-256: <span class="js-webusb-dump-hash1">—</span><span class="js-webusb-dump-hash2 hidden"></span></div>
                        <div class="dev-only mt-4 border-t border-zinc-800 pt-4 space-y-3">
<div class="flex items-center justify-between gap-4">
<span class="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">Raw Read Diagnostics</span>
<span class="js-webusb-read-tools-state font-mono text-[9px] text-zinc-500">IDLE</span>
</div>
<div class="grid grid-cols-2 gap-2">
<input aria-label="Read address" class="js-webusb-read-address bg-zinc-900 border border-zinc-800 p-2 font-mono text-[10px] text-zinc-200" value="0x000000"/>
<input aria-label="Read length" class="js-webusb-read-length bg-zinc-900 border border-zinc-800 p-2 font-mono text-[10px] text-zinc-200" value="256"/>
</div>
<div class="grid grid-cols-3 gap-2">
<button class="js-webusb-read-256 px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Read 256</button>
<button class="js-webusb-read-4k px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Read 4 KiB</button>
<button class="js-webusb-read-range px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Read Range</button>
</div>
<div class="h-2 border border-zinc-800 bg-black overflow-hidden">
<div class="js-webusb-read-progress h-full bg-zinc-500" style="width:0%"></div>
</div>
<div class="js-webusb-read-result-state font-mono text-[9px] text-zinc-500">IDLE</div>
<pre class="js-webusb-read-hexdump max-h-28 overflow-auto border border-zinc-800 bg-black/60 p-2 font-mono text-[9px] text-zinc-500 whitespace-pre"></pre>
</div>
                    </div>
                    <div class="js-offline-mode" hidden style="margin-top:auto;border-top:1px solid #27272a;padding-top:12px">
                        <div><div class="flex items-center justify-between gap-3"><span class="cf-dump-label">Offline mode</span>
                            <button type="button" class="cf-dump-button" style="width:auto;min-width:64px" role="switch" aria-label="Offline mode" aria-checked="false" disabled>Off</button></div>
                            <p class="cf-dump-reason" role="status" aria-live="polite"></p>
                            <p class="cf-dump-note">Changes apply to the working image. Save or flash the image to use them on the box.</p>
                        </div>
                    </div>
                    <!-- Compatibility status sinks for existing controller diagnostics. The visible operation UI is shared. -->
                    <div hidden aria-hidden="true"><div class="js-write-progress-wrap"><div class="js-write-progress"></div><span class="js-write-status"></span></div>
                        <div class="js-webusb-dump-progress"></div><span class="js-webusb-dump-status"></span>
                        <div class="js-verify-current-progress"></div><span class="js-verify-current-status"></span></div>
                </div>

            </section>`;
