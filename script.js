class TVApp {
    constructor() {
        this.DEFAULT_PLAYLIST = 'https://iptv-org.github.io/iptv/index.m3u';
        this.db = window.tvDB;

        this.state = {
            channels: [],
            filteredChannels: [],
            categories: {},
            favorites: new Set(),
            favoriteLists: {},
            favListsCollapsed: {},
            currentChannel: null,
            lastChannel: null,
            hls: null,
            renderIndex: 0,
            selectedIndex: -1,
            activeTab: 'favorites',
            recents: [],
            volume: 0.5,
            sidebarCollapsed: false,
            retryConfig: { maxRetries: 2, baseDelay: 1000, currentRetry: 0 },
            deadChannels: new Map(),
            isAutoSkipping: false,
            runTimer: null,
            stallCheckTimer: null,
            runCheckInterval: 30000,
            runPaused: true,
            currentFavList: null
        };

        this.ui = {
            sourceInput: document.getElementById('sourceInput'),
            loadBtn: document.getElementById('loadBtn'),
            searchInput: document.getElementById('searchInput'),
            categorySelect: document.getElementById('categorySelect'),
            channelList: document.getElementById('channelList'),
            statusText: document.getElementById('statusText'),
            statusDot: document.getElementById('statusDot'),
            channelCount: document.getElementById('channelCount'),
            overlay: document.getElementById('overlay'),
            bootText: document.getElementById('bootText'),
            displayTitle: document.getElementById('displayTitle'),
            displayInfo: document.getElementById('displayInfo'),
            video: document.getElementById('video'),
            sidebar: document.getElementById('sidebar'),
            playlistSelect: document.getElementById('playlistSelect'),
            liveIndicator: document.getElementById('liveIndicator'),
            liveTime: document.getElementById('liveTime'),
            hwPlay: document.getElementById('hw-play-btn'),
            hwMute: document.getElementById('hw-mute-btn'),
            hwFS: document.getElementById('hw-fs-btn'),
            hwPIP: document.getElementById('hw-pip-btn'),
            hwVolSlider: document.getElementById('hw-vol-slider'),
            hwVolFill: document.getElementById('hw-vol-fill'),
            seekBar: document.getElementById('seek-bar'),
            seekFill: document.getElementById('seek-fill'),
            collapseBtn: document.getElementById('collapseBtn'),
            updateNotification: document.getElementById('updateNotification'),
            toast: document.getElementById('toast'),
            sortSelect: document.getElementById('sortSelect'),
            mobileMenuBtn: document.getElementById('mobileMenuBtn'),
            sidebarBackdrop: document.getElementById('sidebarBackdrop'),

            // Loop Controls
            runModeOverlay: document.getElementById('runModeOverlay'),
            runNextBtn: document.getElementById('runNextBtn'),
            runPrevBtn: document.getElementById('runPrevBtn'),
            runTimeBtn: document.getElementById('runTimeBtn'),
            runTimerContainer: document.getElementById('runTimerContainer'),
            runFavBtn: document.getElementById('runFavBtn'),
            add1mBtn: document.getElementById('add1mBtn'),
            add5mBtn: document.getElementById('add5mBtn'),
            reset30sBtn: document.getElementById('reset30sBtn'),
            stopLoopBtn: document.getElementById('stopLoopBtn'),
            runTimerFill: document.getElementById('runTimerFill'),
            tvCase: document.querySelector('.tv-case'),

            channelIcon: document.getElementById('channelIcon'),
            channelIconWrapper: document.getElementById('channelIconWrapper'),
            // New Elements
            volSegmentedTrack: document.querySelector('.vol-segmented-track'),
            volLevelFill: document.getElementById('volLevelFill'),
            volSliderContainer: document.getElementById('volSegmentedSlider'),
            runTimeLabel: document.getElementById('runTimeLabel')
        };

        this.plyr = null;
    }

    async init() {
        await this.db.ensureReady();
        await this.loadStateFromDB();

        const saved = await this.db.getPref('playlist_url', this.DEFAULT_PLAYLIST);
        this.ui.sourceInput.value = saved;

        // Load saved lists from fav/ folder
        await this.loadSavedListsDropdown();

        // Sync playlist dropdown
        Array.from(this.ui.playlistSelect.options).forEach(opt => {
            if (opt.value === saved) this.ui.playlistSelect.value = saved;
        });

        if (this.state.sidebarCollapsed) {
            this.ui.sidebar.classList.add('collapsed');
        }

        this.setupListeners();
        this.setupPlayer();
        this.setupHardwareControls();
        this.setupDraggableDock();

        // Volume Toggle Logic
        if (this.ui.hwMute && this.ui.volSliderContainer) {
            this.ui.hwMute.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger other clicks
                this.ui.volSliderContainer.classList.toggle('expanded');

                // If expanding, reset hide timer if any?
                // Ideally, auto-collapse after interaction? 
                // For now, toggle is explicit.
            });
        }

        this.setupKeyboard();
        this.setupExportImport();

        // Load playlist then switch to favorites
        await this.loadPlaylist(saved);
        this.setListTab('favorites', document.getElementById('tab-fav'));

        // Auto-play last channel if available
        if (this.state.lastChannel) {
            const ch = this.state.channels.find(c => c.url === this.state.lastChannel);
            if (ch) {
                setTimeout(() => this.playChannel(ch), 500);
            }
        }

        this.registerServiceWorker();
        this.startLiveTimeUpdater();
        this.updateTimerUI();
        this.initializeInfinitySphere();
        // Global functions
        window.setListTab = (tab, el) => this.setListTab(tab, el);
        window.toggleFavoriteManual = (url, btn) => this.toggleFavoriteManual(url, btn);
        window.toggleConfig = () => this.toggleConfig();
        window.createNewFavList = () => this.promptCreateList();
        window.deleteFavList = (id) => this.promptDeleteList(id);
        window.toggleFavSection = (id) => { this.toggleFavListCollapse(id); this.renderFavoritesView(); };
        window.showAddToListMenu = (url, btn) => this.showAddToListMenu(url, btn);
        window.applyUpdate = () => this.applyUpdate();
        window.removeFromFavList = (id, url) => { this.removeChannelFromList(id, url); this.renderFavoritesView(); };
    }

    async loadSavedListsDropdown() {
        const group = document.getElementById('savedListsGroup');
        if (!group) return;

        // Use hardcoded saved lists from saved-lists.js
        const savedLists = window.SAVED_LISTS || [];

        if (savedLists.length === 0) {
            group.style.display = 'none';
            return;
        }

        for (const list of savedLists) {
            const option = document.createElement('option');
            option.value = `saved:${list.name}`;
            option.textContent = `📁 ${list.name}`;
            group.appendChild(option);
        }
    }

    async loadSavedList(name) {
        try {
            const savedLists = window.SAVED_LISTS || [];
            const list = savedLists.find(l => l.name === name);

            if (!list || !list.data) {
                throw new Error('Saved list not found');
            }

            const data = list.data;
            if (!data || data.version !== 1) {
                throw new Error('Invalid saved list format');
            }

            // Import the data
            await this.db.importAllData(data);

            // Reload state from DB
            await this.loadStateFromDB();

            // Switch to favorites tab and refresh view
            this.setListTab('favorites', document.getElementById('tab-fav'));
            this.showToast(`Loaded: ${name}`);

        } catch (err) {
            this.showToast('Failed to load saved list: ' + err.message);
            console.error('[App] loadSavedList error:', err);
        }
    }

    startLiveTimeUpdater() {
        const updateTime = () => {
            const now = new Date();
            let hours = now.getHours();
            const minutes = now.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12;

            // Extract timezone roughly
            const tz = now.toLocaleTimeString('en-us', { timeZoneName: 'short' }).split(' ')[2] || 'EST';

            if (this.ui.liveTime) {
                this.ui.liveTime.innerHTML = `
                    <div style="font-size:9px; line-height:1; font-weight:700;">${hours}:${minutes}</div>
                    <div style="display:flex; flex-direction:column; font-size:5px; line-height:0.9; margin-top:1px; color:rgba(255,255,255,0.7);">
                        <div>${ampm}</div>
                        <div>${tz}</div>
                    </div>
                `;
            }
        };

        updateTime(); // Initial update
        setInterval(updateTime, 1000); // Update every second
    }

    async loadStateFromDB() {
        try {
            this.state.favorites = await this.db.getFavorites();
            this.state.favoriteLists = await this.db.getLists();

            for (const id of Object.keys(this.state.favoriteLists)) {
                this.state.favListsCollapsed[id] = this.state.favoriteLists[id].collapsed || false;
            }

            const recents = await this.db.getRecents();
            this.state.recents = recents.map(r => ({ name: r.name, url: r.url }));
            this.state.volume = await this.db.getPref('tv_volume', 0.5);
            this.state.sidebarCollapsed = await this.db.getPref('sidebar_collapsed', false);
            this.state.lastChannel = await this.db.getPref('last_channel', null);

            const deadList = await this.db.getDeadChannels();
            this.state.deadChannels = new Map(deadList.map(d => [d.url, d.failCount]));
        } catch (err) {
            console.error('> Failed to load state:', err);
        }
    }

    setupExportImport() {
        window.exportData = () => this.exportData();
        window.importData = () => this.importData();

        const fileInput = document.getElementById('importFileInput');
        if (fileInput) {
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const data = JSON.parse(await file.text());
                    await this.db.importAllData(data);
                    this.showToast('Data imported! Reloading...');
                    setTimeout(() => window.location.reload(), 1000);
                } catch (err) {
                    this.showToast('Import failed: ' + err.message);
                }
                fileInput.value = '';
            };
        }
    }

    async exportData() {
        try {
            const data = await this.db.exportAllData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `hometv-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            this.showToast('Data exported!');
        } catch (err) {
            this.showToast('Export failed');
        }
    }

    importData() {
        document.getElementById('importFileInput')?.click();
    }

    showToast(message, duration = 3000) {
        const toast = this.ui.toast;
        if (!toast) return;
        toast.textContent = message;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), duration);
    }

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').then(reg => {
                reg.onupdatefound = () => {
                    const worker = reg.installing;
                    worker.onstatechange = () => {
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            // Auto-apply update
                            console.log('[App] New update installed, refreshing...');
                            worker.postMessage('skipWaiting');
                        }
                    };
                };
            }).catch(() => { });

            // Ensure we only reload once
            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (refreshing) return;
                refreshing = true;
                window.location.reload();
            });
        }
    }

    applyUpdate() {
        if (this.pendingUpdateWorker) {
            this.pendingUpdateWorker.postMessage('skipWaiting');
        }
    }

    toggleConfig() {
        const panel = document.getElementById('configPanel');
        const icon = document.getElementById('configToggle');
        panel.classList.toggle('collapsed');
        icon.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    }

    toggleSidebarCollapse() {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        this.ui.sidebar.classList.toggle('collapsed', this.state.sidebarCollapsed);
        this.db.setPref('sidebar_collapsed', this.state.sidebarCollapsed);
    }

    setupListeners() {
        this.ui.sourceInput.oninput = () => { this.ui.playlistSelect.value = 'manual'; };

        let searchTimeout;
        this.ui.searchInput.oninput = () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.applyFilters(), 200);
        };

        this.ui.playlistSelect.onchange = () => {
            const val = this.ui.playlistSelect.value;
            if (val === 'manual') return;

            // Handle hardcoded saved lists
            if (val.startsWith('saved:')) {
                const name = val.replace('saved:', '');
                this.loadSavedList(name);
                return;
            }

            // Regular playlist URL
            this.ui.sourceInput.value = val;
            this.loadPlaylist(val);
        };

        this.ui.loadBtn.onclick = () => this.loadPlaylist(this.ui.sourceInput.value);
        this.ui.sourceInput.onkeydown = (e) => {
            if (e.key === 'Enter') this.loadPlaylist(this.ui.sourceInput.value);
        };

        this.ui.categorySelect.onchange = () => this.applyFilters();
        this.ui.sortSelect.onchange = () => this.applyFilters(); // New listener

        this.ui.channelList.onscroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = this.ui.channelList;
            if (scrollTop + clientHeight >= scrollHeight - 100) {
                this.renderMoreChannels();
            }
        };

        if (this.ui.collapseBtn) {
            this.ui.collapseBtn.onclick = () => this.toggleSidebarCollapse();
        }

        // Mobile menu toggle
        if (this.ui.mobileMenuBtn) {
            this.ui.mobileMenuBtn.onclick = () => this.toggleMobileSidebar();
        }
        if (this.ui.sidebarBackdrop) {
            this.ui.sidebarBackdrop.onclick = () => this.closeMobileSidebar();
        }

        if (this.ui.runNextBtn) {
            this.ui.runNextBtn.onclick = (e) => {
                e.stopPropagation();
                this.showOSD();
                this.playNextSequentialChannel();
            };
        }

        if (this.ui.runPrevBtn) {
            this.ui.runPrevBtn.onclick = (e) => {
                e.stopPropagation();
                this.showOSD();
                this.playPreviousSequentialChannel();
            };
        }

        if (this.ui.runTimeBtn) {
            this.ui.runTimeBtn.onclick = (e) => {
                e.stopPropagation();
                if (this.state.timerLoop) {
                    clearInterval(this.state.timerLoop);
                    this.state.timerLoop = null;
                    this.state.runPaused = true;
                    if (this.ui.runTimeLabel) this.ui.runTimeLabel.innerHTML = '<span class="material-icons-round">all_inclusive</span>';
                    this.ui.runTimerFill.style.width = '0%';
                    if (this.ui.runModeOverlay) this.ui.runModeOverlay.classList.remove('timer-active');
                    this.showOSD(3000);
                } else {
                    if (this.ui.runModeOverlay) {
                        this.ui.runModeOverlay.classList.toggle('timer-active');
                        // Keep visible if active
                        if (this.ui.runModeOverlay.classList.contains('timer-active')) {
                            this.showOSD(30000);
                        }
                    }
                }
                this.updateTimerUI();
            };
        }

        if (this.ui.add1mBtn) {
            this.ui.add1mBtn.onclick = (e) => {
                e.stopPropagation();
                this.adjustRunTimer(60000);
            };
        }

        if (this.ui.add5mBtn) {
            this.ui.add5mBtn.onclick = (e) => {
                e.stopPropagation();
                this.adjustRunTimer(300000);
            };
        }

        if (this.ui.reset30sBtn) {
            this.ui.reset30sBtn.onclick = (e) => {
                e.stopPropagation();
                this.state.runCheckInterval = 30000;
                this.resetRunTimer();
            };
        }

        if (this.ui.stopLoopBtn) {
            this.ui.stopLoopBtn.onclick = (e) => {
                e.stopPropagation();
                this.state.runPaused = true;
                this.ui.runModeOverlay.classList.remove('timer-active');
                this.stopTimerOnly();
                this.updateTimerUI();
            };
        }

        if (this.ui.runFavBtn) {
            this.ui.runFavBtn.onclick = (e) => {
                e.stopPropagation();
                this.showOSD();
                if (this.state.currentChannel?.url) {
                    this.toggleFavoriteManual(this.state.currentChannel.url, null);
                }
            };
        }
    }

    stopTimerOnly() {
        if (this.state.runTimer) clearTimeout(this.state.runTimer);
        if (this.state.countdownInterval) clearInterval(this.state.countdownInterval);
        this.state.runTimer = null;
        this.state.countdownInterval = null;
        this.state.runTimerEnd = null;
        this.ui.runTimerFill.style.transition = 'none';
        this.ui.runTimerFill.style.width = '0%';
        if (this.ui.runTimeLabel) {
            this.ui.runTimeLabel.innerHTML = '<span class="material-icons-round">all_inclusive</span>';
        }
    }

    toggleMobileSidebar() {
        this.ui.sidebar.classList.toggle('open');
        this.ui.sidebarBackdrop.classList.toggle('visible', this.ui.sidebar.classList.contains('open'));
    }

    closeMobileSidebar() {
        this.ui.sidebar.classList.remove('open');
        this.ui.sidebarBackdrop.classList.remove('visible');
    }


    getScopedChannels() {
        if (this.state.activeTab === 'favorites' && this.state.currentFavList && this.state.currentFavList !== 'all') {
            const list = this.state.favoriteLists[this.state.currentFavList];
            if (list) {
                // Return only channels in this specific list, but respect current filter (search/category)
                return this.state.filteredChannels.filter(ch => list.channels.includes(ch.url));
            }
        }
        return this.state.filteredChannels;
    }

    playRandomChannel() {
        // Dynamic Scope: Use current scoped channels
        const workingChannels = this.getScopedChannels().filter(ch => {
            const failCount = this.state.deadChannels.get(ch.url) || 0;
            return failCount < 3;
        });

        if (workingChannels.length === 0) {
            this.showToast('No working channels in this view');
            return;
        }

        const r = Math.floor(Math.random() * workingChannels.length);
        const nextCh = workingChannels[r];
        this.state.currentChannel = nextCh;
        this.playChannel(nextCh);

        this.state.runTimerEnd = Date.now() + this.state.runCheckInterval;
        this.resetRunTimer();
    }


    toggleTimerExpansion() {
        const container = this.ui.runTimerContainer;
        container.classList.toggle('expanded');
    }

    adjustRunTimer(ms) {
        if (this.state.runPaused) {
            this.state.runPaused = false;
            // Activate timer UI when starting from pause
            if (this.ui.runModeOverlay) this.ui.runModeOverlay.classList.add('timer-active');

            // Start fresh
            this.state.runTimerEnd = Date.now();
        }

        const now = Date.now();
        if (!this.state.runTimerEnd || this.state.runTimerEnd <= now) {
            this.state.runTimerEnd = now;
        }

        // Add to current end time
        this.state.runTimerEnd += ms;

        // Update the reference interval to reflect the new total duration
        const newRemaining = this.state.runTimerEnd - now;
        this.state.runCheckInterval = newRemaining;

        this.resetRunTimer();
    }

    resetRunTimer() {
        if (this.state.runTimer) clearTimeout(this.state.runTimer);
        if (this.state.countdownInterval) clearInterval(this.state.countdownInterval);

        if (this.state.runPaused) {
            this.stopTimerOnly();
            return;
        }

        const now = Date.now();
        if (!this.state.runTimerEnd || this.state.runTimerEnd <= now) {
            this.state.runTimerEnd = now + this.state.runCheckInterval;
        }

        const currentTotal = Math.max(this.state.runCheckInterval, 1000);
        const remaining = Math.max(0, this.state.runTimerEnd - now);

        this.state.runTimer = setTimeout(() => {
            if (!this.state.runPaused) {
                this.playNextSequentialChannel();
            }
        }, remaining);

        this.updateCountdownDisplay();
        this.state.countdownInterval = setInterval(() => this.updateCountdownDisplay(), 1000);

        // UI state check
        this.updateTimerUI();

        // Progress bar: Current % -> 0%
        const percent = Math.min(100, (remaining / currentTotal) * 100);

        this.ui.runTimerFill.style.transition = 'none';
        this.ui.runTimerFill.style.width = `${percent}%`;
        // Force reflow
        void this.ui.runTimerFill.offsetWidth;
        this.ui.runTimerFill.style.transition = `width ${remaining / 1000}s linear`;
        this.ui.runTimerFill.style.width = '0%';
    }

    playNextSequentialChannel() {
        const scopedChannels = this.getScopedChannels();
        if (scopedChannels.length === 0) return;

        const currentIndex = scopedChannels.findIndex(ch => ch.url === this.state.currentChannel?.url);
        const nextIndex = (currentIndex + 1) % scopedChannels.length;
        const nextCh = scopedChannels[nextIndex];

        this.playChannel(nextCh);
    }

    playPreviousSequentialChannel() {
        const scopedChannels = this.getScopedChannels();
        if (scopedChannels.length === 0) return;

        const currentIndex = scopedChannels.findIndex(ch => ch.url === this.state.currentChannel?.url);
        const prevIndex = currentIndex <= 0 ? scopedChannels.length - 1 : currentIndex - 1;
        const prevCh = scopedChannels[prevIndex];

        this.playChannel(prevCh);
    }

    updateCountdownDisplay() {
        if (this.state.runPaused || !this.state.runTimerEnd) return;

        const now = Date.now();
        const diff = Math.max(0, this.state.runTimerEnd - now);

        const seconds = Math.ceil(diff / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;

        let display = '';
        if (mins > 0) {
            display = `${mins}:${secs.toString().padStart(2, '0')}`;
        } else {
            display = `${secs}s`;
        }

        if (this.ui.runTimeLabel) {
            this.ui.runTimeLabel.innerHTML = `<span style="font-size:10px; font-weight:700; letter-spacing:-0.5px;">${display}</span>`;
            this.ui.runTimeBtn.classList.add('accent'); // Ensure accent color
        }

        if (diff <= 0) {
            clearInterval(this.state.countdownInterval);
            this.ui.runTimerFill.style.width = '0%';
        }
    }

    updateRunUI() {
        const ch = this.state.currentChannel;
        if (!ch) return;

        const isFav = this.state.favorites.has(ch.url);
        const favIcon = isFav ? 'star' : 'star_border';

        if (this.ui.runFavBtn) {
            this.ui.runFavBtn.innerHTML = `<span class="material-icons-round">${favIcon}</span>`;
            this.ui.runFavBtn.classList.toggle('active', isFav);
        }

        if (this.ui.runTimeLabel) {
            if (this.state.runPaused) {
                this.ui.runTimeLabel.innerHTML = '<span class="material-icons-round">all_inclusive</span>';
            }
        }

        if (this.ui.runPrevBtn) {
            this.ui.runPrevBtn.style.opacity = '1';
        }

        if (this.ui.tvCase) {
            this.ui.tvCase.classList.toggle('timer-active', !this.state.runPaused);
        }

        if (this.ui.runTimerFill) {
            this.ui.runTimerFill.style.opacity = '1';
        }
    }

    updateTimerUI() {
        if (this.ui.tvCase) {
            this.ui.tvCase.classList.toggle('timer-active', !this.state.runPaused);
        }

        if (this.ui.runTimerFill) {
            this.ui.runTimerFill.style.opacity = '1';
        }
    }

    setupPlayer() {
        // Direct control and perfect object-fit
        this.ui.video.controls = false;
    }

    setupDraggableDock() {
        const dock = this.ui.runModeOverlay;
        const dockBody = dock?.querySelector('.remote-body');

        if (!dock || !dockBody) return;

        let isDragging = false;
        let hasMoved = false;
        let offsetLeft, offsetTop; // Click offset from dock's top-left

        // Load saved position logic REMOVED to reset on reload
        /*
        const loadPosition = async () => {
            const savedLeft = await this.db.getPref('dock_left', null);
            const savedTop = await this.db.getPref('dock_top', null);

            if (savedLeft !== null && savedTop !== null) {
                dock.style.left = savedLeft + 'px';
                dock.style.top = savedTop + 'px';
            }
        };
        loadPosition();
        */

        const getRelativePosition = (clientX, clientY, rect) => {
            const parentRect = dock.parentElement.getBoundingClientRect();
            return {
                left: clientX - parentRect.left,
                top: clientY - parentRect.top
            };
        };

        const constrainPosition = (left, top) => {
            const containerRect = dock.parentElement.getBoundingClientRect();
            const dockRect = dock.getBoundingClientRect();

            const maxLeft = containerRect.width - dockRect.width;
            const maxTop = containerRect.height - dockRect.height;

            return {
                left: Math.max(0, Math.min(left, maxLeft)),
                top: Math.max(0, Math.min(top, maxTop))
            };
        };

        let startX, startY;

        const onStart = (e) => {
            // Check handled by movement threshold later
            // if (e.target.closest('button, .remote-vol-track, .vol-popover')) return;

            // Don't preventDefault here to allow click events to start
            isDragging = true;
            hasMoved = false;
            // dock.classList.add('dragging'); // Defer until move

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            startX = clientX;
            startY = clientY;

            const rect = dock.getBoundingClientRect();

            // Calculate where we clicked inside the dock
            offsetLeft = clientX - rect.left;
            offsetTop = clientY - rect.top;

            this.showOSD(60000); // Keep visible while dragging
        };

        const onMove = (e) => {
            if (!isDragging) return;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            if (!hasMoved) {
                const dx = Math.abs(clientX - startX);
                const dy = Math.abs(clientY - startY);
                if (dx < 4 && dy < 4) return; // Threshold

                hasMoved = true;
                dock.classList.add('dragging');
            }

            e.preventDefault();

            // Calculate metrics
            const dockRect = dock.getBoundingClientRect();
            const parentRect = dock.parentElement.getBoundingClientRect();

            // Visual Top target (where we want the top edge)
            const desiredVisualTop = (clientY - parentRect.top) - offsetTop;
            /* Note: offsetTop was calculated as (clientY - rect.top). 
               So (clientY - offsetTop) is rect.top (screen coords).
               Subtract parentRect.top to get relative visual top. */

            // We use transform: translateY(-50%), so style.top sets the CENTER.
            // Center = VisualTop + Height/2
            let centerTop = desiredVisualTop + (dockRect.height / 2);

            // Constrain Center
            // Min Center = 0 + h/2
            // Max Center = ParentH - h + h/2 = ParentH - h/2
            const minCenter = dockRect.height / 2;
            const maxCenter = parentRect.height - (dockRect.height / 2);

            centerTop = Math.max(minCenter, Math.min(centerTop, maxCenter));

            // Left Calculation (No transform on X)
            let newLeft = (clientX - parentRect.left) - offsetLeft;
            const maxLeft = parentRect.width - dockRect.width;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));

            dock.style.left = newLeft + 'px';
            dock.style.top = centerTop + 'px';
        };

        const onEnd = async () => {
            if (!isDragging) return;

            isDragging = false;
            dock.classList.remove('dragging');

            // Save position if we actually moved
            if (hasMoved) {
                const parentRect = dock.parentElement.getBoundingClientRect();
                const rect = dock.getBoundingClientRect();

                await this.db.setPref('dock_left', rect.left - parentRect.left);
                await this.db.setPref('dock_top', rect.top - parentRect.top);
            }

            // Fix: Re-assert OSD visibility after drag ends so it doesn't fade
            this.showOSD(60000);
        };

        // Mouse events on dock body
        dockBody.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);

        // Touch events on dock body
        dockBody.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    setupHardwareControls() {
        this.ui.video.volume = this.state.volume;
        this.updateVolumeUI(this.state.volume);

        if (this.ui.hwPlay) {
            this.ui.hwPlay.onclick = (e) => {
                e.stopPropagation();
                this.showOSD();
                if (this.ui.video.paused) this.ui.video.play();
                else this.ui.video.pause();
            };
        }

        if (this.ui.hwMute) {
            this.ui.hwMute.onclick = (e) => {
                e.stopPropagation();
                if (this.ui.volPopup) {
                    this.ui.volPopup.classList.toggle('active');
                }
            };
        }

        // Close volPopup on outside click
        document.addEventListener('click', () => {
            if (this.ui.volPopup) this.ui.volPopup.classList.remove('active');
        });

        if (this.ui.volPopup) {
            this.ui.volPopup.onclick = (e) => e.stopPropagation();
        }

        if (this.ui.hwFS) {
            this.ui.hwFS.onclick = (e) => {
                e.stopPropagation();
                this.showOSD();
                const el = document.querySelector('.tv-container');
                const video = this.ui.video;

                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    if (el.requestFullscreen) {
                        el.requestFullscreen().catch(err => {
                            console.error(`Fullscreen error: ${err.message}`);
                        });
                    } else if (video.webkitEnterFullscreen) {
                        video.webkitEnterFullscreen();
                    } else if (el.webkitRequestFullscreen) {
                        el.webkitRequestFullscreen();
                    }
                } else {
                    if (document.exitFullscreen) {
                        document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        document.webkitExitFullscreen();
                    }
                }
            };
        }

        // Fullscreen OSD auto-hide
        this.setupFullscreenOSD();

        if (this.ui.hwPIP) {
            this.ui.hwPIP.onclick = async (e) => {
                e.stopPropagation();
                this.showOSD();
                try {
                    if (document.pictureInPictureElement) {
                        await document.exitPictureInPicture();
                    } else if (document.pictureInPictureEnabled) {
                        await this.ui.video.requestPictureInPicture();
                    }
                } catch (err) {
                    console.error('PIP error:', err);
                }
            };
        }

        // Update PIP icon on enter/exit
        this.ui.video.addEventListener('enterpictureinpicture', () => {
            this.ui.hwPIP.innerHTML = '<span class="material-icons-round">picture_in_picture</span>';
        });
        this.ui.video.addEventListener('leavepictureinpicture', () => {
            this.ui.hwPIP.innerHTML = '<span class="material-icons-round">picture_in_picture_alt</span>';
        });

        // Volume Logic
        const updateVolumeUI = (vol) => {
            // Update volume on video
            this.ui.video.volume = vol;
            this.ui.video.muted = false;

            this.state.volume = vol;

            // Update vertical bar
            if (this.ui.volLevelFill) {
                this.ui.volLevelFill.style.height = (vol * 100) + '%';
            }

            // Update mute icon
            this.ui.hwMute.innerHTML = vol === 0
                ? '<span class="material-icons-round">volume_off</span>'
                : '<span class="material-icons-round">volume_up</span>';

            this.db.setPref('tv_volume', vol);
        };

        const updateVolFromTracking = (e) => {
            const track = this.ui.volSegmentedTrack;
            if (!track) return;
            const rect = track.getBoundingClientRect();
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            // Vertical from bottom
            let vol = (rect.bottom - clientY) / rect.height;
            vol = Math.max(0, Math.min(1, vol));
            updateVolumeUI(vol);
        };

        if (this.ui.volSegmentedTrack) {
            const track = this.ui.volSegmentedTrack;

            const startVolDrag = (e) => {
                e.preventDefault();
                e.stopPropagation(); // Prevent dock dragging
                updateVolFromTracking(e);

                const move = (ev) => {
                    ev.preventDefault(); // Prevent scroll
                    updateVolFromTracking(ev);
                };

                const end = () => {
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', end);
                    document.removeEventListener('touchmove', move);
                    document.removeEventListener('touchend', end);
                };

                document.addEventListener('mousemove', move, { passive: false });
                document.addEventListener('mouseup', end);
                document.addEventListener('touchmove', move, { passive: false });
                document.addEventListener('touchend', end);
            };

            track.addEventListener('mousedown', startVolDrag);
            track.addEventListener('touchstart', startVolDrag, { passive: false });
        }

        // Initial UI update
        if (this.ui.volLevelFill) {
            this.ui.volLevelFill.style.height = (this.state.volume * 100) + '%';
        }

        // Draggable seek bar
        const updateSeek = (e) => {
            if (!this.ui.seekBar) return;
            const rect = this.ui.seekBar.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const video = this.ui.video;

            if (video.seekable && video.seekable.length > 0) {
                const start = video.seekable.start(0);
                const end = video.seekable.end(video.seekable.length - 1);
                video.currentTime = start + (end - start) * pct;
            } else if (video.duration && isFinite(video.duration)) {
                video.currentTime = video.duration * pct;
            }

            if (this.ui.seekFill) {
                this.ui.seekFill.style.width = (pct * 100) + '%';
            }
        };

        if (this.ui.seekBar) {
            this.ui.seekBar.addEventListener('mousedown', (e) => {
                e.preventDefault();
                updateSeek(e);
                const onMove = (e) => updateSeek(e);
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        // Update seek bar as video plays
        this.ui.video.addEventListener('timeupdate', () => {
            const video = this.ui.video;
            let pct = 0;

            if (video.seekable && video.seekable.length > 0) {
                const start = video.seekable.start(0);
                const end = video.seekable.end(video.seekable.length - 1);
                if (end > start) {
                    pct = (video.currentTime - start) / (end - start);
                }
            } else if (video.duration && isFinite(video.duration)) {
                pct = video.currentTime / video.duration;
            }

            if (this.ui.seekFill) {
                this.ui.seekFill.style.width = Math.max(0, Math.min(100, pct * 100)) + '%';
            }
        });

        this.ui.video.addEventListener('dblclick', () => {
            const el = document.querySelector('.tv-container');
            if (!document.fullscreenElement) el.requestFullscreen().catch(e => { });
            else document.exitFullscreen();
        });

        this.ui.video.addEventListener('play', () => {
            this.ui.hwPlay.innerHTML = '<span class="material-icons-round">pause</span>';
            this.ui.hwPlay.classList.add('playing');
            this.ui.hwPlay.classList.remove('paused');
        });

        this.ui.video.addEventListener('pause', () => {
            this.ui.hwPlay.innerHTML = '<span class="material-icons-round">play_arrow</span>';
            this.ui.hwPlay.classList.add('paused');
            this.ui.hwPlay.classList.remove('playing');
        });
    }

    updateVolumeUI(v) {
        this.ui.video.volume = v;
        if (this.ui.hwVolFill) this.ui.hwVolFill.style.height = (v * 100) + '%';
    }

    showOSD(duration = 10000) {
        const tvContainer = document.querySelector('.tv-container');
        tvContainer.classList.add('show-controls');
        if (this.osdTimeout) clearTimeout(this.osdTimeout);

        this.osdTimeout = setTimeout(() => {
            // Check if timer is active - if so, don't hide the dock
            const isTimerActive = this.ui.runModeOverlay?.classList.contains('timer-active');

            if (isTimerActive) {
                // Keep calling showOSD to stay visible while timer is adjusting
                this.showOSD(duration);
                return;
            }

            tvContainer.classList.remove('show-controls');
        }, duration);
    }

    toggleOSD(e) {
        if (e) {
            // If clicking a button, slider, or mini-btn, DON'T toggle (just show)
            const isInteractive = e.target.closest('button, .remote-vol-track, .mini-btn');

            if (isInteractive) {
                this.showOSD(); // Keep it visible during interaction
                return;
            }
        }

        const tvContainer = document.querySelector('.tv-container');
        if (tvContainer.classList.contains('show-controls')) {
            tvContainer.classList.remove('show-controls');
            if (this.osdTimeout) clearTimeout(this.osdTimeout);
        } else {
            this.showOSD();
        }
    }

    setupFullscreenOSD() {
        const tvContainer = document.querySelector('.tv-container');

        // Capture all clicks on the container area
        tvContainer.addEventListener('click', (e) => this.toggleOSD(e));

        tvContainer.addEventListener('mousemove', () => {
            this.showOSD();
        });

        tvContainer.addEventListener('touchstart', (e) => {
            if (e.target.tagName === 'VIDEO' || e.target.classList.contains('main-display') || e.target.classList.contains('tv-container')) {
                this.toggleOSD(e);
            }
        });

        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                tvContainer.classList.remove('show-controls');
                if (this.osdTimeout) clearTimeout(this.osdTimeout);
            } else {
                this.showOSD();
            }
        });

        document.addEventListener('webkitfullscreenchange', () => {
            if (!document.webkitFullscreenElement) {
                tvContainer.classList.remove('show-controls');
                if (this.osdTimeout) clearTimeout(this.osdTimeout);
            } else {
                this.showOSD();
            }
        });
    }

    setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            const isInput = document.activeElement.tagName === 'INPUT';

            if (e.key === 'Tab' || e.key === 'Escape') {
                if (e.key === 'Tab') e.preventDefault();
                this.toggleMobileSidebar();
                return;
            }

            if (!isInput) {
                if (this.state.runMode) {
                    if (e.key === 'ArrowRight') this.playRandomChannel();
                    else if (e.key === 'ArrowLeft') this.playPreviousRunChannel();
                    else if (e.key === 'Enter') this.toggleFavoriteManual(this.state.currentChannel?.url, null);
                }

                if (e.key === '1') this.setListTab('all', document.getElementById('tab-all'));
                else if (e.key === '2') this.setListTab('favorites', document.getElementById('tab-fav'));
                else if (e.key === '3') this.setListTab('recents', document.getElementById('tab-recent'));
                else if (e.key === 'm' || e.key === 'M') this.ui.hwMute.click();
                else if (e.key === ' ') { e.preventDefault(); this.ui.hwPlay.click(); }
                else if (e.key === 'f' || e.key === 'F') this.ui.hwFS.click();
                else if (e.key === 'p' || e.key === 'P') this.ui.hwPIP.click();
            }
        });
    }

    setListTab(tab, el) {
        this.state.activeTab = tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        if (el) el.classList.add('active');
        this.applyFilters();
    }

    async loadPlaylist(url) {
        this.db.setPref('playlist_url', url);
        url = url.trim() || this.DEFAULT_PLAYLIST;

        this.ui.statusText.textContent = 'LOADING';
        this.ui.statusDot.classList.remove('error');
        this.ui.channelList.innerHTML = '<div style="padding:20px; color:var(--terminal-muted)">Loading...</div>';

        try {
            let text;
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP_' + res.status);
                text = await res.text();
            } catch {
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
                const proxyRes = await fetch(proxyUrl);
                if (!proxyRes.ok) throw new Error('PROXY_FAIL');
                text = await proxyRes.text();
            }

            if (!text || !text.includes('#EXTM3U')) throw new Error('INVALID_FORMAT');

            this.parsePlaylist(text);
            this.populateCategoryDropdown();
            this.applyFilters();
            this.ui.statusText.textContent = 'READY';
            this.ui.channelCount.textContent = this.state.channels.length;

        } catch (err) {
            this.ui.channelList.innerHTML = `<div style="padding:20px; color:var(--terminal-red)">Error: ${err.message}</div>`;
            this.ui.statusText.textContent = 'ERROR';
            this.ui.statusDot.classList.add('error');
        }
    }

    parsePlaylist(content) {
        this.state.channels = [];
        this.state.categories = {};

        const lines = content.split('\n');
        let current = {};

        for (const rawLine of lines) {
            const line = rawLine.trim();

            if (line.startsWith('#EXTINF:')) {
                const info = line.slice(8);
                const lastComma = info.lastIndexOf(',');
                const meta = info.slice(0, lastComma);
                const name = info.slice(lastComma + 1).trim();

                const getAttr = key => {
                    const m = meta.match(new RegExp(`${key}="([^"]*)"`, 'i'));
                    return m ? m[1] : '';
                };

                const category = getAttr('group-title').split(';')[0].trim() || 'Other';
                current = {
                    name,
                    category,
                    logo: getAttr('tvg-logo'),
                    url: ''
                };
            } else if (line.startsWith('http')) {
                current.url = line;
                this.state.channels.push(current);
                if (!this.state.categories[current.category]) this.state.categories[current.category] = 0;
                this.state.categories[current.category]++;
                current = {};
            }
        }
    }

    populateCategoryDropdown() {
        const cats = Object.keys(this.state.categories).sort();
        this.ui.categorySelect.innerHTML = '<option value="">ALL</option>' +
            cats.map(c => `<option value="${c}">${c} (${this.state.categories[c]})</option>`).join('');
    }

    applyFilters() {
        const search = this.ui.searchInput.value.toLowerCase();
        const category = this.ui.categorySelect.value;
        const tab = this.state.activeTab;

        // Reset sub-scope when tab/filter changes, unless we are in favorites 
        // and manually picked a list (handled in selectChannel)
        if (tab !== 'favorites') this.state.currentFavList = null;

        this.state.filteredChannels = this.state.channels.filter(ch => {
            // Tab filtering
            if (tab === 'favorites') {
                if (!this.state.favorites.has(ch.url)) return false;
            } else if (tab === 'recents') {
                if (!this.state.recents.some(r => r.url === ch.url)) return false;
            }

            // Category & Search
            if (category && ch.category !== category) return false;
            if (search && !ch.name.toLowerCase().includes(search)) return false;
            return true;
        });

        if (tab === 'favorites') {
            this.renderFavoritesView();
            return;
        }

        if (this.state.activeTab === 'recents') {
            this.state.filteredChannels.sort((a, b) => {
                return this.state.recents.findIndex(r => r.url === a.url) -
                    this.state.recents.findIndex(r => r.url === b.url);
            });
        }

        // Sorting Logic
        if (this.state.activeTab === 'all') {
            const sort = this.ui.sortSelect.value;
            if (sort === 'alpha') {
                this.state.filteredChannels.sort((a, b) => a.name.localeCompare(b.name));
            } else if (sort === 'fav') {
                this.state.filteredChannels.sort((a, b) => {
                    const aFav = this.state.favorites.has(a.url) ? 1 : 0;
                    const bFav = this.state.favorites.has(b.url) ? 1 : 0;
                    if (aFav !== bFav) return bFav - aFav; // Favorites first
                    return a.name.localeCompare(b.name); // Then alphabetical
                });
            }
        }

        this.state.renderIndex = 0;
        this.ui.channelList.innerHTML = '';
        this.renderMoreChannels();
        this.ui.channelCount.textContent = this.state.filteredChannels.length;

        if (this.state.filteredChannels.length === 0) {
            this.ui.channelList.innerHTML = '<div style="padding:20px; color:var(--terminal-muted)">No channels found</div>';
        }
    }

    renderMoreChannels() {
        if (this.state.activeTab === 'favorites') return;

        const start = this.state.renderIndex;
        const end = Math.min(start + 50, this.state.filteredChannels.length);
        if (start >= this.state.filteredChannels.length) return;

        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const ch = this.state.filteredChannels[i];
            fragment.appendChild(this.createChannelItem(ch, i));
        }

        this.ui.channelList.appendChild(fragment);
        this.state.renderIndex = end;
    }

    renderFavoritesView() {
        const container = this.ui.channelList;
        container.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'fav-lists-header';
        header.innerHTML = `<button class="fav-new-list-btn" onclick="window.createNewFavList()">+ NEW LIST</button>`;
        container.appendChild(header);

        const favChannels = this.state.filteredChannels;

        this.renderFavSection(container, 'all', 'ALL STARRED', favChannels, false);

        Object.entries(this.state.favoriteLists).forEach(([id, list]) => {
            const listChannels = favChannels.filter(ch => list.channels.includes(ch.url));
            this.renderFavSection(container, id, list.name, listChannels, true);
        });

        if (favChannels.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 20px; color: var(--terminal-muted);';
            empty.textContent = '> No favorites found';
            container.appendChild(empty);
        }

        this.ui.channelCount.textContent = favChannels.length;
    }

    renderFavSection(container, listId, name, channels, isDeletable) {
        const isCollapsed = this.state.favListsCollapsed[listId] || false;

        const header = document.createElement('div');
        header.className = 'fav-section-header';
        header.innerHTML = `
            <span class="fav-section-toggle" onclick="window.toggleFavSection('${listId}')">${isCollapsed ? '▶' : '▼'}</span>
            <span class="fav-section-name" onclick="window.toggleFavSection('${listId}')">${name.toUpperCase()}</span>
            <span class="fav-section-count">(${channels.length})</span>
            ${isDeletable ? `<button class="fav-section-delete" onclick="event.stopPropagation(); window.deleteFavList('${listId}')">✕</button>` : ''}
        `;
        container.appendChild(header);

        if (!isCollapsed) {
            const section = document.createElement('div');
            section.className = 'fav-section-content';

            if (channels.length === 0) {
                section.innerHTML = '<div class="fav-section-empty">> Empty</div>';
            } else {
                channels.forEach((ch, idx) => section.appendChild(this.createChannelItem(ch, idx, listId)));
            }
            container.appendChild(section);
        }
    }

    createChannelItem(ch, index, listId = null) {
        const isFav = this.state.favorites.has(ch.url);
        const isDead = (this.state.deadChannels.get(ch.url) || 0) >= 3;
        const isActive = this.state.currentChannel?.url === ch.url;

        const item = document.createElement('div');
        item.className = `channel-item${isDead ? ' dead' : ''}${isActive ? ' active' : ''}`;
        item.dataset.url = ch.url;
        item.tabIndex = 0;

        const firstWord = ch.name ? ch.name.trim().split(/\s+/)[0] : '?';
        let fontSize = '14px';
        if (firstWord.length > 2) fontSize = '11px';
        if (firstWord.length > 4) fontSize = '9px';
        if (firstWord.length > 6) fontSize = '7px';
        if (firstWord.length > 8) fontSize = '6px';

        const logo = ch.logo
            ? `<img class="ch-logo" src="${ch.logo}" loading="lazy" onerror="this.onerror=null; this.outerHTML='<div class=&quot;ch-logo ch-logo-placeholder&quot; style=&quot;font-size: ${fontSize}&quot;>${firstWord}</div>';">`
            : `<div class="ch-logo ch-logo-placeholder" style="font-size: ${fontSize}">${firstWord}</div>`;

        const listBtn = this.state.activeTab !== 'recents'
            ? `<button class="add-to-list-btn" onclick="event.stopPropagation(); event.preventDefault(); window.showAddToListMenu('${ch.url}', this); return false;">☰</button>`
            : '';

        const removeBtn = listId && listId !== 'all'
            ? `<button class="list-remove-btn" onclick="event.stopPropagation(); event.preventDefault(); window.removeFromFavList('${listId}', '${ch.url}'); return false;"><span class="material-icons-round" style="font-size:14px">close</span></button>`
            : '';

        item.innerHTML = `
            ${logo}
            <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); event.preventDefault(); window.toggleFavoriteManual('${ch.url}', this); return false;">${isFav ? '★' : '☆'}</button>
            ${listBtn}
            ${removeBtn}
            <div class="channel-main">
                <span class="ch-name">${ch.name}</span>
                <span class="ch-group">${ch.category}</span>
            </div>
        `;

        item.onclick = () => this.selectChannel(ch, item, index, listId);
        return item;
    }

    selectChannel(ch, item, index, listId = null) {
        this.state.selectedIndex = index;
        this.state.currentFavList = listId;
        this.ui.channelList.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
        item.classList.add('active');

        // Update recents
        this.state.recents = [{ name: ch.name, url: ch.url }, ...this.state.recents.filter(r => r.url !== ch.url)].slice(0, 10);
        this.db.addRecent(ch);

        // Save last channel
        this.db.setPref('last_channel', ch.url);

        this.playChannel(ch);
        if (window.innerWidth <= 900) this.closeMobileSidebar();
    }

    toggleFavoriteManual(url, btn) {
        this.toggleFavorite(url);
        const isFav = this.state.favorites.has(url);
        if (btn) {
            btn.className = `fav-btn ${isFav ? 'active' : ''}`;
            btn.textContent = isFav ? '★' : '☆';
        }

        // Force refresh all OSD/UI elements that might be showing this channel
        this.updateRunUI();

        if (this.state.activeTab === 'favorites') this.renderFavoritesView();

        // Update list buttons if visible
        document.querySelectorAll(`.channel-item[data-url="${url}"] .fav-btn`).forEach(b => {
            b.className = `fav-btn ${isFav ? 'active' : ''}`;
            b.textContent = isFav ? '★' : '☆';
        });
    }

    toggleFavorite(url) {
        if (this.state.favorites.has(url)) {
            this.state.favorites.delete(url);
            this.db.removeFavorite(url);
            Object.keys(this.state.favoriteLists).forEach(id => {
                const idx = this.state.favoriteLists[id].channels.indexOf(url);
                if (idx > -1) this.state.favoriteLists[id].channels.splice(idx, 1);
            });
            this.saveFavoriteLists();
        } else {
            this.state.favorites.add(url);
            this.db.addFavorite(url);
        }
    }

    saveFavoriteLists() {
        for (const [id, list] of Object.entries(this.state.favoriteLists)) {
            this.db.saveList(id, {
                name: list.name,
                channels: list.channels,
                collapsed: this.state.favListsCollapsed[id] || false
            });
        }
    }

    createFavoriteList(name) {
        const id = 'list_' + Date.now();
        this.state.favoriteLists[id] = { name, channels: [] };
        this.state.favListsCollapsed[id] = false;
        this.saveFavoriteLists();
        return id;
    }

    deleteFavoriteList(id) {
        if (this.state.favoriteLists[id]) {
            delete this.state.favoriteLists[id];
            delete this.state.favListsCollapsed[id];
            this.db.deleteList(id);
            this.renderFavoritesView();
        }
    }

    addChannelToList(id, url) {
        if (this.state.favoriteLists[id] && !this.state.favoriteLists[id].channels.includes(url)) {
            this.state.favoriteLists[id].channels.push(url);
            this.saveFavoriteLists();
        }
    }

    removeChannelFromList(id, url) {
        if (this.state.favoriteLists[id]) {
            const idx = this.state.favoriteLists[id].channels.indexOf(url);
            if (idx > -1) {
                this.state.favoriteLists[id].channels.splice(idx, 1);
                this.saveFavoriteLists();
            }
        }
    }

    toggleFavListCollapse(id) {
        this.state.favListsCollapsed[id] = !this.state.favListsCollapsed[id];
        this.saveFavoriteLists();
    }

    showAddToListMenu(url, btn) {
        document.querySelector('.add-to-list-menu')?.remove();

        const lists = Object.entries(this.state.favoriteLists);
        const menu = document.createElement('div');
        menu.className = 'add-to-list-menu';
        menu.innerHTML = `
            <div class="menu-header">ADD TO LIST</div>
            ${lists.map(([id, list]) => {
            const isIn = list.channels.includes(url);
            return `<div class="menu-item ${isIn ? 'in-list' : ''}" data-list-id="${id}">
                    <span class="menu-check">${isIn ? '✓' : ''}</span>
                    <span class="menu-name">${list.name}</span>
                </div>`;
        }).join('')}
            <div class="menu-divider"></div>
            <div class="menu-item menu-new" data-action="new">+ NEW LIST</div>
        `;

        const rect = btn.getBoundingClientRect();
        menu.style.cssText = `position:fixed; left:${rect.right + 5}px; top:${rect.top}px; z-index:10000;`;
        document.body.appendChild(menu);

        menu.onclick = (e) => {
            const item = e.target.closest('.menu-item');
            if (!item) return;

            if (item.dataset.action === 'new') {
                menu.remove();
                this.promptCreateList(url);
            } else if (item.dataset.listId) {
                const id = item.dataset.listId;
                const isIn = this.state.favoriteLists[id].channels.includes(url);
                if (isIn) this.removeChannelFromList(id, url);
                else this.addChannelToList(id, url);
                menu.remove();
                if (this.state.activeTab === 'favorites') this.renderFavoritesView();
            }
        };

        setTimeout(() => {
            const close = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', close);
                }
            };
            document.addEventListener('click', close);
        }, 10);
    }

    promptCreateList(preAddUrl = null) {
        this.showPopupModal({
            title: 'NEW LIST',
            placeholder: 'Enter list name...',
            onConfirm: (name) => {
                if (name?.trim()) {
                    const id = this.createFavoriteList(name.trim());
                    if (preAddUrl) this.addChannelToList(id, preAddUrl);
                    if (this.state.activeTab === 'favorites') this.renderFavoritesView();
                }
            }
        });
    }

    showPopupModal({ title, placeholder, defaultValue = '', onConfirm }) {
        // Remove any existing popup
        document.querySelector('.popup-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'popup-overlay';
        overlay.innerHTML = `
            <div class="popup-modal">
                <div class="popup-header">${title}</div>
                <div class="popup-body">
                    <input type="text" class="popup-input" placeholder="${placeholder}" value="${defaultValue}" autofocus>
                </div>
                <div class="popup-actions">
                    <button class="popup-btn" data-action="cancel">CANCEL</button>
                    <button class="popup-btn primary" data-action="confirm">CREATE</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const input = overlay.querySelector('.popup-input');
        const modal = overlay.querySelector('.popup-modal');

        // Focus input after animation
        setTimeout(() => input.focus(), 100);

        const close = (confirmed = false) => {
            if (confirmed && onConfirm) {
                onConfirm(input.value);
            }
            overlay.remove();
        };

        // Handle button clicks
        overlay.addEventListener('click', (e) => {
            const action = e.target.dataset?.action;
            if (action === 'cancel') close(false);
            else if (action === 'confirm') close(true);
            else if (e.target === overlay) close(false); // Click on backdrop
        });

        // Handle keyboard
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                close(true);
            } else if (e.key === 'Escape') {
                close(false);
            }
        });
    }

    promptDeleteList(id) {
        const list = this.state.favoriteLists[id];
        if (list && confirm(`Delete "${list.name}"?`)) {
            this.deleteFavoriteList(id);
        }
    }

    playChannel(channel) {
        this.state.currentChannel = channel;

        // Show OSD briefly when changing channels
        this.showOSD();

        // Update Overlay UI state
        this.updateTimerUI();

        // Highlight and Scroll to channel in sidebar
        const items = this.ui.channelList.querySelectorAll('.channel-item');
        items.forEach(item => {
            if (item.dataset.url === channel.url) {
                item.classList.add('active');
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                item.classList.remove('active');
            }
        });

        // If timer is unpaused, reset it for the new channel
        if (!this.state.runPaused) {
            this.state.runTimerEnd = Date.now() + this.state.runCheckInterval;
            this.resetRunTimer();
        }

        this.state.retryConfig.currentRetry = 0;

        const titleHtml = channel.name.toUpperCase().split(/\s+/).join('<br>');
        this.ui.displayTitle.innerHTML = titleHtml;
        this.ui.displayInfo.textContent = channel.category;

        if (this.ui.channelIcon) {
            if (channel.logo) {
                this.ui.channelIcon.src = channel.logo;
                this.ui.channelIcon.style.display = 'block';
                if (this.ui.channelIconWrapper) this.ui.channelIconWrapper.style.display = 'flex';
            } else {
                this.ui.channelIcon.style.display = 'none';
                if (this.ui.channelIconWrapper) this.ui.channelIconWrapper.style.display = 'none';
            }
        }

        // Update Remote UI (Favorites etc)
        this.updateRunUI();

        // Show live indicator
        this.ui.liveIndicator.classList.add('active');

        this.ui.overlay.classList.remove('hidden');
        this.ui.bootText.innerHTML = `<div class="line">> Connecting...</div>`;

        if (this.state.runMode) {
            this.ui.bootText.innerHTML = `<div class="line" style="animation:none; font-size:16px; font-weight:bold;">> ${channel.name}</div>`;

            // Stall detection - check both paused state and currentTime progress
            if (this.state.stallCheckTimer) clearTimeout(this.state.stallCheckTimer);

            this.state.stallCheckTimer = setTimeout(() => {
                if (!this.state.runMode || this.state.currentChannel?.url !== channel.url) return;
                // If paused or time hasn't advanced past 0.1s
                const stalled = this.ui.video.paused || (this.ui.video.currentTime < 0.1);

                if (stalled) {
                    console.log('Stall detected (no progress), skipping...');
                    this.handleChannelError();
                }
            }, 2000);
        }

        if (this.state.hls) {
            this.state.hls.destroy();
            this.state.hls = null;
        }

        if (Hls.isSupported()) {
            const hlsConfig = { enableWorker: true, lowLatencyMode: true };

            // Run Mode optimization: fast fail
            if (this.state.runMode) {
                hlsConfig.manifestLoadingTimeOut = 2500;
                hlsConfig.manifestLoadingMaxRetry = 0;
                hlsConfig.levelLoadingTimeOut = 2500;
                hlsConfig.fragLoadingTimeOut = 2500;
            }

            const hls = new Hls(hlsConfig);
            this.state.hls = hls;

            hls.attachMedia(this.ui.video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(channel.url));

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.ui.overlay.classList.add('hidden');
                this.db.resetChannelFails(channel.url);
                this.state.deadChannels.delete(channel.url);
                if (this.state.stallCheckTimer) clearTimeout(this.state.stallCheckTimer);
                this.ui.video.play().catch(() => {
                    // In run mode, if autoplay fails, just skip
                    if (this.state.runMode) this.handleChannelError();
                    else this.showAutoplayPrompt();
                });
            });

            hls.on(Hls.Events.ERROR, (_, data) => this.handleHlsError(data, hls));

        } else if (this.ui.video.canPlayType('application/vnd.apple.mpegurl')) {
            this.ui.video.src = channel.url;
            this.ui.video.onloadedmetadata = () => {
                this.ui.overlay.classList.add('hidden');
                if (this.state.stallCheckTimer) clearTimeout(this.state.stallCheckTimer);
                this.ui.video.play().catch(() => this.showAutoplayPrompt());
            };
            this.ui.video.onerror = () => this.handleChannelError();
        }
    }

    async handleHlsError(data, hls) {
        if (!data.fatal) return;

        // Run Mode fast skip
        if (this.state.runMode) {
            hls.destroy();
            this.handleChannelError();
            return;
        }

        const config = this.state.retryConfig;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && config.currentRetry < config.maxRetries) {
            config.currentRetry++;
            const delay = config.baseDelay * Math.pow(2, config.currentRetry - 1);

            this.ui.bootText.innerHTML = `<div class="line">> Retry ${config.currentRetry}/${config.maxRetries}...</div>`;

            setTimeout(() => hls.startLoad(), delay);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
        } else {
            hls.destroy();
            this.handleChannelError();
        }
    }

    async handleChannelError() {
        const channel = this.state.currentChannel;
        if (!channel) return;

        // Track failure
        const failCount = await this.db.markChannelFailed(channel.url);
        this.state.deadChannels.set(channel.url, failCount);

        if (this.state.runMode) {
            // Fast skip in functionality
            this.playRandomChannel();
            return;
        }

        // Auto-skip to next working channel
        this.showToast(`${channel.name} failed. Trying next...`);

        const next = this.getNextWorkingChannel(channel);
        if (next) {
            setTimeout(() => this.playChannel(next), 500);
        } else {
            this.ui.bootText.innerHTML = `<div class="line" style="color:var(--terminal-red)">> No working channels found</div>`;
        }
    }

    getNextWorkingChannel(current) {
        // Find next channel in same category that isn't dead
        const sameCategory = this.state.channels.filter(ch =>
            ch.category === current.category &&
            ch.url !== current.url &&
            (this.state.deadChannels.get(ch.url) || 0) < 3
        );

        if (sameCategory.length > 0) return sameCategory[0];

        // Fallback: any non-dead channel
        return this.state.channels.find(ch =>
            ch.url !== current.url &&
            (this.state.deadChannels.get(ch.url) || 0) < 3
        );
    }

    showAutoplayPrompt() {
        this.ui.bootText.innerHTML = `<div class="line">> Click to play</div>`;
        this.ui.overlay.onclick = () => {
            this.ui.video.play().then(() => {
                this.ui.overlay.classList.add('hidden');
                this.ui.overlay.onclick = null;
            }).catch(() => { });
        };
    }

    initializeInfinitySphere() {
        const container = document.getElementById('infinitySphere');
        if (!container) return;

        const init = () => {
            if (typeof THREE === 'undefined') {
                setTimeout(init, 100);
                return;
            }

            const width = 36;
            const height = 36;

            try {
                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
                camera.position.z = 2.0; // Same perspective relative to size

                const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
                renderer.setSize(width, height);
                renderer.setPixelRatio(window.devicePixelRatio);
                renderer.setClearColor(0x000000, 0);
                renderer.domElement.style.display = 'block';
                container.appendChild(renderer.domElement);

                // Stronger Lights for small scale visibility
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
                scene.add(ambientLight);

                const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
                sunLight.position.set(2, 2, 5);
                scene.add(sunLight);

                // Procedural Textures (Enhanced)
                const createEarthTextures = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 256; // High res for better continents
                    canvas.height = 128;
                    const ctx = canvas.getContext('2d');

                    ctx.fillStyle = '#0a1d4a';
                    ctx.fillRect(0, 0, 256, 128);

                    ctx.fillStyle = '#00ff7f';
                    for (let i = 0; i < 40; i++) {
                        const x = Math.random() * 256;
                        const y = Math.random() * 128;
                        const r = Math.random() * 25 + 10; // Larger land masses
                        ctx.beginPath();
                        ctx.arc(x, y, r, 0, Math.PI * 2);
                        ctx.fill();
                        if (x + r > 256) { ctx.beginPath(); ctx.arc(x - 256, y, r, 0, Math.PI * 2); ctx.fill(); }
                        if (x - r < 0) { ctx.beginPath(); ctx.arc(x + 256, y, r, 0, Math.PI * 2); ctx.fill(); }
                    }
                    const diffuse = new THREE.CanvasTexture(canvas);
                    const specular = new THREE.CanvasTexture(canvas); // Land is not spec, but we handle in material

                    return { diffuse, specular };
                };

                const textures = createEarthTextures();

                const axisGroup = new THREE.Group();
                axisGroup.rotation.z = THREE.MathUtils.degToRad(23.4);
                scene.add(axisGroup);

                // Planet
                const planetGeo = new THREE.SphereGeometry(1, 32, 32);
                const planetMat = new THREE.MeshPhongMaterial({
                    map: textures.diffuse,
                    specularMap: textures.specular,
                    specular: new THREE.Color(0x333333),
                    shininess: 25,
                    opacity: 1,
                    transparent: true
                });
                const earth = new THREE.Mesh(planetGeo, planetMat);
                axisGroup.add(earth);

                // Clouds Layer (MasterMaps signature)
                const createCloudTexture = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 128;
                    canvas.height = 64;
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, 128, 64);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
                    for (let i = 0; i < 40; i++) {
                        const x = Math.random() * 128;
                        const y = Math.random() * 64;
                        const r = Math.random() * 4 + 2;
                        ctx.beginPath();
                        ctx.arc(x, y, r, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    return new THREE.CanvasTexture(canvas);
                };

                const clouds = new THREE.Mesh(
                    new THREE.SphereGeometry(1.03, 32, 32),
                    new THREE.MeshPhongMaterial({
                        map: createCloudTexture(),
                        transparent: true,
                        opacity: 0.4
                    })
                );
                axisGroup.add(clouds);

                let isHovered = false;
                const animate = () => {
                    requestAnimationFrame(animate);
                    const rotation = 0.008 * (isHovered ? 5 : 1);
                    earth.rotation.y += rotation;
                    clouds.rotation.y += rotation * 1.25; // Clouds move faster
                    renderer.render(scene, camera);
                };
                animate();

                const parent = container.parentElement;
                parent.addEventListener('mouseenter', () => { isHovered = true; });
                parent.addEventListener('mouseleave', () => { isHovered = false; });
                parent.addEventListener('mousedown', () => { axisGroup.scale.set(0.85, 0.85, 0.85); });
                window.addEventListener('mouseup', () => { axisGroup.scale.set(1, 1, 1); });

            } catch (e) {
                console.error("MasterMaps Earth Failed:", e);
            }
        };

        init();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const app = new TVApp();
    app.init();
});
