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
            isAutoSkipping: false
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
            mobileMenuBtn: document.getElementById('mobileMenuBtn'),
            sidebarBackdrop: document.getElementById('sidebarBackdrop')
        };

        this.plyr = null;
    }

    async init() {
        await this.db.ensureReady();
        await this.loadStateFromDB();

        const saved = await this.db.getPref('playlist_url', this.DEFAULT_PLAYLIST);
        this.ui.sourceInput.value = saved;

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
                            this.ui.updateNotification?.classList.remove('hidden');
                            this.pendingUpdateWorker = worker;
                        }
                    };
                };
            }).catch(() => { });

            navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
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
            if (val !== 'manual') {
                this.ui.sourceInput.value = val;
                this.loadPlaylist(val);
            }
        };

        this.ui.loadBtn.onclick = () => this.loadPlaylist(this.ui.sourceInput.value);
        this.ui.sourceInput.onkeydown = (e) => {
            if (e.key === 'Enter') this.loadPlaylist(this.ui.sourceInput.value);
        };

        this.ui.categorySelect.onchange = () => this.applyFilters();

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
    }

    toggleMobileSidebar() {
        this.ui.sidebar.classList.toggle('open');
        this.ui.sidebarBackdrop.classList.toggle('visible', this.ui.sidebar.classList.contains('open'));
    }

    closeMobileSidebar() {
        this.ui.sidebar.classList.remove('open');
        this.ui.sidebarBackdrop.classList.remove('visible');
    }

    setupPlayer() {
        this.plyr = new Plyr(this.ui.video, { controls: [], clickToPlay: true });
    }

    setupHardwareControls() {
        this.ui.video.volume = this.state.volume;
        this.updateVolumeUI(this.state.volume);

        this.ui.hwPlay.onclick = () => {
            if (this.ui.video.paused) this.ui.video.play();
            else this.ui.video.pause();
        };

        this.ui.hwMute.onclick = () => {
            this.ui.video.muted = !this.ui.video.muted;
            this.ui.hwMute.innerHTML = this.ui.video.muted
                ? '<span class="material-icons-round">volume_off</span>'
                : '<span class="material-icons-round">volume_up</span>';
        };

        this.ui.hwFS.onclick = () => this.plyr.fullscreen.toggle();

        // Picture-in-Picture toggle
        this.ui.hwPIP.onclick = async () => {
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

        // Update PIP icon on enter/exit
        this.ui.video.addEventListener('enterpictureinpicture', () => {
            this.ui.hwPIP.innerHTML = '<span class="material-icons-round">picture_in_picture</span>';
        });
        this.ui.video.addEventListener('leavepictureinpicture', () => {
            this.ui.hwPIP.innerHTML = '<span class="material-icons-round">picture_in_picture_alt</span>';
        });

        // Draggable volume slider
        const updateVolume = (e) => {
            const rect = this.ui.hwVolSlider.getBoundingClientRect();
            const vol = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

            // Update volume immediately on both video and plyr
            this.ui.video.volume = vol;
            this.ui.video.muted = false;
            if (this.plyr) {
                this.plyr.volume = vol;
                this.plyr.muted = false;
            }

            this.state.volume = vol;
            this.ui.hwVolFill.style.width = (vol * 100) + '%';

            // Update mute icon
            this.ui.hwMute.innerHTML = vol === 0
                ? '<span class="material-icons-round">volume_off</span>'
                : '<span class="material-icons-round">volume_up</span>';
        };

        this.ui.hwVolSlider.addEventListener('mousedown', (e) => {
            e.preventDefault();
            updateVolume(e);
            const onMove = (e) => updateVolume(e);
            const onUp = () => {
                this.db.setPref('tv_volume', this.state.volume);
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Draggable seek bar
        const updateSeek = (e) => {
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

            this.ui.seekFill.style.width = (pct * 100) + '%';
        };

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

            this.ui.seekFill.style.width = Math.max(0, Math.min(100, pct * 100)) + '%';
        });

        this.ui.video.addEventListener('dblclick', () => this.plyr.fullscreen.toggle());

        this.ui.video.addEventListener('play', () => {
            this.ui.hwPlay.innerHTML = '<span class="material-icons-round">pause</span>';
        });

        this.ui.video.addEventListener('pause', () => {
            this.ui.hwPlay.innerHTML = '<span class="material-icons-round">play_arrow</span>';
        });
    }

    updateVolumeUI(v) {
        this.ui.video.volume = v;
        if (this.plyr) this.plyr.volume = v;
        if (this.ui.hwVolFill) this.ui.hwVolFill.style.width = (v * 100) + '%';
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
        if (this.state.activeTab === 'favorites') {
            this.renderFavoritesView();
            return;
        }

        const search = this.ui.searchInput.value.toLowerCase();
        const category = this.ui.categorySelect.value;

        this.state.filteredChannels = this.state.channels.filter(ch => {
            if (this.state.activeTab === 'recents') {
                return this.state.recents.some(r => r.url === ch.url);
            }
            if (category && ch.category !== category) return false;
            if (search && !ch.name.toLowerCase().includes(search)) return false;
            return true;
        });

        if (this.state.activeTab === 'recents') {
            this.state.filteredChannels.sort((a, b) => {
                return this.state.recents.findIndex(r => r.url === a.url) -
                    this.state.recents.findIndex(r => r.url === b.url);
            });
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

        const favChannels = this.state.channels.filter(ch => this.state.favorites.has(ch.url));

        this.renderFavSection(container, 'all', 'ALL STARRED', favChannels, false);

        Object.entries(this.state.favoriteLists).forEach(([id, list]) => {
            const listChannels = favChannels.filter(ch => list.channels.includes(ch.url));
            this.renderFavSection(container, id, list.name, listChannels, true);
        });

        if (favChannels.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 20px; color: var(--terminal-muted);';
            empty.textContent = '> No favorites yet';
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
                channels.forEach((ch, i) => section.appendChild(this.createChannelItem(ch, i, listId)));
            }
            container.appendChild(section);
        }
    }

    createChannelItem(ch, index, listId = null) {
        const isFav = this.state.favorites.has(ch.url);
        const isDead = (this.state.deadChannels.get(ch.url) || 0) >= 3;
        const item = document.createElement('div');
        item.className = `channel-item${isDead ? ' dead' : ''}`;
        item.dataset.url = ch.url;
        item.tabIndex = 0;

        const logo = ch.logo
            ? `<img class="ch-logo" src="${ch.logo}" loading="lazy" onerror="this.style.visibility='hidden'">`
            : `<div class="ch-logo ch-logo-placeholder"></div>`;

        const listBtn = this.state.activeTab !== 'recents'
            ? `<button class="add-to-list-btn" onclick="event.stopPropagation(); window.showAddToListMenu('${ch.url}', this)">☰</button>`
            : '';

        const removeBtn = listId && listId !== 'all'
            ? `<button class="list-remove-btn" onclick="event.stopPropagation(); window.removeFromFavList('${listId}', '${ch.url}')">−</button>`
            : '';

        item.innerHTML = `
            ${logo}
            <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); window.toggleFavoriteManual('${ch.url}', this)">${isFav ? '★' : '☆'}</button>
            ${listBtn}
            ${removeBtn}
            <div class="channel-main">
                <span class="ch-name">${ch.name}</span>
                <span class="ch-group">${ch.category}</span>
            </div>
        `;

        item.onclick = () => this.selectChannel(ch, item, index);
        return item;
    }

    selectChannel(ch, item, index) {
        this.state.selectedIndex = index;
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
        if (this.state.activeTab === 'favorites') this.renderFavoritesView();
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
        this.state.retryConfig.currentRetry = 0;

        this.ui.displayTitle.textContent = `[ ${channel.name.toUpperCase()} ]`;
        this.ui.displayInfo.textContent = channel.category;

        // Show live indicator
        this.ui.liveIndicator.classList.add('active');

        this.ui.overlay.classList.remove('hidden');
        this.ui.bootText.innerHTML = `<div class="line">> Connecting...</div>`;

        if (this.state.hls) {
            this.state.hls.destroy();
            this.state.hls = null;
        }

        if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            this.state.hls = hls;

            hls.attachMedia(this.ui.video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(channel.url));

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.ui.overlay.classList.add('hidden');
                this.db.resetChannelFails(channel.url);
                this.state.deadChannels.delete(channel.url);
                this.plyr.play().catch(() => this.showAutoplayPrompt());
            });

            hls.on(Hls.Events.ERROR, (_, data) => this.handleHlsError(data, hls));

        } else if (this.ui.video.canPlayType('application/vnd.apple.mpegurl')) {
            this.ui.video.src = channel.url;
            this.ui.video.onloadedmetadata = () => {
                this.ui.overlay.classList.add('hidden');
                this.plyr.play().catch(() => this.showAutoplayPrompt());
            };
            this.ui.video.onerror = () => this.handleChannelError();
        }
    }

    async handleHlsError(data, hls) {
        if (!data.fatal) return;

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
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const app = new TVApp();
    app.init();
});
