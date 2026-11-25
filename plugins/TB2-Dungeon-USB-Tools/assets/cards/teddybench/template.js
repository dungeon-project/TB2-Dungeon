/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-content-browser"] = `<section class="tile tile-disabled" data-x="-1" data-y="1" data-layer="workspace" data-nav-x="-2" data-nav-y="0"
                data-tile-class="ContentBrowserTile" data-start-enabled="true" id="tile-content-browser">
                <div class="tb2-browser">
                    <h2>TeddyBench 2 Web (beta)</h2>
                    <div class="tb2-browser-toolbar">
                        <button type="button" data-browser="select">Select content folder</button>
                        <button type="button" class="dev-only" data-browser="image">Load SD image</button>
                        <input type="file" data-browser="image-file" accept=".img,.ima,.bin" hidden />
                        <button type="button" data-browser="refresh" disabled>Refresh</button>
                        <button type="button" data-browser="cancel" disabled>Cancel scan</button>
                        <button type="button" data-browser="catalog">Load catalog</button>
                    </div>
                    <div class="tb2-browser-toolbar" role="group" aria-label="Edit selected content folder"><span class="tb2-browser-status">Writes directly to the selected folder:</span>
                        <button type="button" data-browser="add" disabled>Add figure</button>
                        <button type="button" data-browser="delete" disabled>Delete figure and content</button>
                    </div>
                    <div class="tb2-browser-toolbar">
                        <input type="search" data-browser="search" placeholder="Search collections or tracks" aria-label="Search collections or tracks" />
                        <select data-browser="filter" aria-label="Collection filter"><option value="content">Content</option><option value="system">System sounds</option><option value="all">All</option></select>
                    </div>
                    <p class="tb2-browser-status" data-browser="status" role="status">Select a local folder to browse its collections.</p>
                    <p class="tb2-browser-status" data-browser="catalog-status" role="status">Catalog not loaded.</p>
                    <div class="tb2-browser-columns">
                        <div class="tb2-browser-pane">
                            <h3>Collections</h3>
                            <div class="tb2-browser-list terminal-scroll" data-browser="collections" aria-label="Collections"></div>
                            <div class="tb2-browser-pages"><button type="button" data-browser="collections-prev" aria-label="Previous collections">Previous</button><span data-browser="collections-page"></span><button type="button" data-browser="collections-next" aria-label="Next collections">Next</button></div>
                        </div>
                        <div class="tb2-browser-pane">
                            <h3 class="tb2-browser-title" data-browser="collection-title">Select a collection</h3>
                            <div class="tb2-browser-list terminal-scroll" data-browser="tracks" aria-label="Tracks"></div>
                            <div class="tb2-browser-pages"><button type="button" data-browser="tracks-prev" aria-label="Previous tracks">Previous</button><span data-browser="tracks-page"></span><button type="button" data-browser="tracks-next" aria-label="Next tracks">Next</button></div>
                        </div>
                    </div>
                    <div class="tb2-browser-toolbar">
                        <label for="tb2-playback-behavior">Playback behavior</label>
                        <select id="tb2-playback-behavior" data-browser="behavior" disabled><option value="" disabled>Not specified / unavailable</option><option value="resume">Resume playback</option><option value="alwaysReset">Always start from beginning</option></select>
                        <button type="button" data-browser="save" disabled>Save</button>
                    </div>
                    <p class="tb2-browser-status" data-browser="behavior-status" role="status">Select a collection.</p>
                    <p class="tb2-browser-title" data-browser="track-title">Select a track</p>
                    <div class="tb2-browser-player">
                        <button type="button" data-browser="play" disabled>Play track</button>
                        <audio data-browser="audio" controls preload="none" aria-label="Track player"></audio>
                        <button type="button" data-browser="export" disabled>Export track</button>
                    </div>
                    <input class="tb2-browser-seek" data-browser="seek" type="range" min="0" max="0" step="0.01" value="0" aria-label="Seek within track" disabled />
                    <details><summary>Details &amp; help</summary>
                        <p>Select the folder containing collections and content. For a TB2 Dungeon backup, select its inner content folder. Save changes only the selected collection's playback behavior and matching companion hash; audio files stay unchanged. This writes directly to the selected folder. Device behavior has not been verified.</p>
                        <p>Add figure creates a new regular audio collection from a display-order UID (E004…) and ordered MP3 or Ogg/Opus tracks. MP3 conversion runs locally, up to 128 MiB and two hours per MP3; existing Ogg/Opus stays unchanged. Existing UIDs cannot be replaced. Delete figure and content previews exact removals and preserves shared or ambiguous files. Both actions write directly to the selected folder; images remain read-only. Keep a separate backup, close other editors, and leave this page open. Cancellation can leave files requiring review. No NFC tag is programmed, and device acceptance is unverified.</p>
                        <p>Load catalog downloads a public name catalog. Matching stays local; no SD data is uploaded. Cached names work offline, and Clear cache &amp; reset TB2 Dungeon removes them. Track titles are not taken from the catalog.</p>
                        <p class="dev-only">Load SD image opens a raw FAT32 volume or an image with one primary FAT32 partition, read-only. The volume must contain collections and content. Large images are read in parts; only selected tracks are opened for playback or export. Other filesystems and partition layouts are not supported.</p>
                        <p>System sounds have a separate filter. Tonieplay audio can be played, but game logic is not executed. Size differences and partial playback do not prove completeness. Leaving this card stops playback.</p>
                        <pre data-browser="details">No selection.</pre>
                    </details>
                </div>

            </section>`;
