/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-content-backup"] = `<section class="tile tile-disabled" data-x="0" data-y="2"
                data-tile-class="ContentBackupTile" data-start-enabled="true" id="tile-content-backup" data-layer="workspace" data-nav-x="-1" data-nav-y="-1">
                <div class="cf-firmware-layout flex flex-col terminal-scroll">
                    <header>
                        <p class="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-2">USB · Content files</p>
                        <h2 class="text-4xl font-display font-black text-white tracking-tighter">SD Content Backup</h2>
                        <p class="cf-firmware-muted mt-2">Boot the prepared Diagnostic Image (Production), connect the box via USB-C and select its content folder visible in Windows.</p>
                    </header>
                    <div class="cf-firmware-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
                        <div class="cf-firmware-panel">
                            <button class="js-content-box cf-dump-button" type="button">Select box folder</button>
                            <p class="js-content-box-name cf-firmware-muted mt-2">Not selected</p>
                        </div>
                        <div class="cf-firmware-panel">
                            <button class="js-content-backup cf-dump-button" type="button">Select backup folder</button>
                            <p class="js-content-backup-name cf-firmware-muted mt-2">Not selected</p>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-3 items-center">
                        <label class="cf-firmware-muted" for="content-action">Action</label>
                        <select id="content-action" class="js-content-action bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-white">
                            <option value="backup">Back up content</option>
                            <option value="restore">Restore to box</option>
                        </select>
                        <button class="js-content-start cf-dump-button cf-dump-button-primary" type="button" disabled>Create backup</button>
                        <button class="js-content-cancel cf-dump-button" type="button" disabled>Cancel</button>
                    </div>
                    <details><summary class="cf-firmware-muted">Advanced</summary>
                    <label class="js-content-cleanup-label cf-firmware-muted flex items-start gap-2">
                        <input class="js-content-cleanup mt-1" type="checkbox">
                        <span><span class="js-content-cleanup-title">Delete backup files that no longer exist in the source</span><br>
                        <span class="js-content-cleanup-hint">Applies only to backup content; review deletions before starting.</span></span>
                    </label>
                    </details>
                    <progress class="js-content-progress w-full" max="1" value="0" aria-label="Content progress"></progress>
                    <p class="js-content-status cf-firmware-muted" role="status" aria-live="polite">Select both folders.</p>
                    <details class="cf-firmware-panel">
                        <summary>How do backup and restore work?</summary>
                        <div class="cf-firmware-muted mt-2 space-y-2">
                            <p>The box must be running Diagnostic Image (Production). Select its content folder mounted in Windows and a separate backup folder on your PC or another drive. The website does not automatically detect the drive or firmware and sends no serial commands.</p>
                            <p>All files and subfolders in the selected folder are backed up, including empty folders. This is a file backup, not an SD card image containing partitions or unused sectors. All data stays local.</p>
                            <p><strong>Full Backup</strong> creates the first backup in an empty backup folder. <strong>Incremental Backup</strong> updates the same backup: new and changed files are copied, unchanged files are skipped. There is no version history. By default, files deleted from the box remain in the backup and may return during restore.</p>
                            <p><strong>Full Restore</strong> verifies the entire backup first. After you confirm the summary, backup files are restored, overwriting destination files with the same names. Additional files on the box are kept by default.</p>
                            <p><strong>Optional cleanup:</strong> For backups, this option removes backup content missing from the source. For restores, it removes additional entries from the selected box folder. Files and empty folders are listed for confirmation first and deleted only after successful copying and verification. This option resets after each operation or change of folder or action.</p>
                            <p>Checksums verify file contents block by block. Incremental backups also read all source files, which may take time. Written files are read back and verified. Do not change content files during the operation.</p>
                            <p>If cancelled or interrupted by an error, a backup remains incomplete and cannot be restored. Run again with the same folders to verify and complete it. Completed copies remain; there is no full rollback. Keep this page open during transfer and safely eject the drive in Windows afterwards.</p>
                        </div>
                    </details>
                    <dialog class="js-content-review bg-zinc-950 text-zinc-200 border border-zinc-700 rounded-lg p-6" style="width:min(640px,90vw);max-height:80vh">
                        <form method="dialog">
                            <h3 class="text-xl font-bold">Confirm action</h3>
                            <p class="js-content-review-summary cf-firmware-muted mt-3 whitespace-pre-line"></p>
                            <pre class="js-content-review-files text-xs mt-3 whitespace-pre-wrap overflow-y-auto" style="max-height:35vh"></pre>
                            <div class="flex gap-3 mt-4">
                                <button class="cf-dump-button" value="cancel" type="submit" autofocus>Cancel</button>
                                <button class="js-content-confirm cf-dump-button cf-dump-button-primary" value="confirm" type="submit">Confirm and start</button>
                            </div>
                        </form>
                    </dialog>
                </div>

            </section>`;
