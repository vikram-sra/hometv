class TVApp {
    constructor() {
        this.DEFAULT_PLAYLIST = 'https://iptv-org.github.io/iptv/index.m3u';

        this.state = {
            channels: [],
            filteredChannels: [],
            categories: {},
            languages: new Set(),
            favorites: new Set(JSON.parse(localStorage.getItem('fav_channels') || '[]')),
            // Multiple favorites lists: { listId: { name: string, channels: string[], collapsed: boolean } }
            favoriteLists: JSON.parse(localStorage.getItem('fav_lists') || '{}'),
            activeFavList: 'all', // 'all' shows all starred, or a specific list ID
            favListsCollapsed: JSON.parse(localStorage.getItem('fav_lists_collapsed') || '{}'),
            currentChannel: null,
            hls: null,
            renderIndex: 0,
            batchSize: 100,
            selectedIndex: -1,
            activeTab: 'all',
            recents: JSON.parse(localStorage.getItem('recent_channels') || '[]'),
            volume: parseFloat(localStorage.getItem('tv_volume') || '0.5'),
            viewMode: localStorage.getItem('view_mode') || 'list',
            groupBy: '',
            theme: localStorage.getItem('tv_theme') || 'green',
            sidebarCollapsed: localStorage.getItem('sidebar_collapsed') === 'true',
            // Retry configuration for exponential backoff
            retryConfig: {
                maxRetries: 3,
                baseDelay: 1000,
                maxDelay: 10000,
                currentRetry: 0
            }
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
            mobileBtn: document.getElementById('mobileBtn'),
            indicator: document.getElementById('ui-indicator'),
            playlistSelect: document.getElementById('playlistSelect'),
            hwPlay: document.getElementById('hw-play-btn'),
            hwMute: document.getElementById('hw-mute-btn'),
            hwFS: document.getElementById('hw-fs-btn'),
            hwVolSlider: document.getElementById('hw-vol-slider'),
            hwVolFill: document.getElementById('hw-vol-fill'),
            hwPip: document.getElementById('hw-pip-btn'),
            hwSeek: document.getElementById('hw-seek'),
            hwProgress: document.getElementById('hw-progress'),
            statusDash: document.getElementById('statusDashboard'),
            helpOverlay: document.getElementById('helpOverlay'),
            themeSelect: document.getElementById('themeSelect'),
            collapseBtn: document.getElementById('collapseBtn')
        };

        this.plyr = null;
    }

    init() {
        const saved = localStorage.getItem('playlist_url') || this.DEFAULT_PLAYLIST;
        const startUrl = (saved === 'favorites' || saved === this.DEFAULT_PLAYLIST) ? saved : this.DEFAULT_PLAYLIST;

        this.ui.sourceInput.value = startUrl;
        this.ui.playlistSelect.value = (startUrl === 'favorites') ? 'favorites' : 'manual';

        Array.from(this.ui.playlistSelect.options).forEach(opt => {
            if (opt.value === startUrl) this.ui.playlistSelect.value = startUrl;
        });

        // Initialize theme
        this.applyTheme(this.state.theme);
        if (this.ui.themeSelect) {
            this.ui.themeSelect.value = this.state.theme;
        }

        // Initialize sidebar state
        if (this.state.sidebarCollapsed) {
            this.ui.sidebar.classList.add('collapsed');
        }

        this.setupListeners();
        this.setupPlayer();
        this.setupHardwareControls();
        this.setupKeyboard();
        this.setupThemeAndCollapse();

        // Load playlist then switch to favorites tab
        this.loadPlaylist(startUrl).then(() => {
            this.setListTab('favorites', document.getElementById('tab-fav'));
        });

        // Register Service Worker for PWA
        this.registerServiceWorker();

        // Global exposed function for onclick handlers in HTML
        window.setListTab = (tab, el) => this.setListTab(tab, el);
        window.toggleFavoriteManual = (url, btn) => this.toggleFavoriteManual(url, btn);
        window.toggleConfig = () => this.toggleConfig();

        // Favorites list management
        window.createNewFavList = () => this.promptCreateList();
        window.deleteFavList = (listId) => this.promptDeleteList(listId);
        window.renameFavList = (listId) => this.promptRenameList(listId);
        window.toggleFavSection = (listId) => {
            this.toggleFavListCollapse(listId);
            this.renderFavoritesView();
        };
        window.showAddToListMenu = (url, btn) => this.showAddToListMenu(url, btn);
        window.removeFromFavList = (listId, url) => {
            this.removeChannelFromList(listId, url);
            this.renderFavoritesView();
        };
    }

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => {
                    console.log('> SERVICE_WORKER: Registered', reg.scope);
                })
                .catch(err => {
                    console.warn('> SERVICE_WORKER: Registration failed', err);
                });
        }
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        this.state.theme = theme;
        localStorage.setItem('tv_theme', theme);

        // Update theme-color meta tag
        const themeColors = {
            green: '#00ff41',
            amber: '#ffb000',
            cyan: '#00d4ff',
            red: '#ff3366'
        };
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.content = themeColors[theme] || themeColors.green;
        }
    }

    setupThemeAndCollapse() {
        // Theme switcher
        if (this.ui.themeSelect) {
            this.ui.themeSelect.onchange = () => {
                this.applyTheme(this.ui.themeSelect.value);
            };
        }

        // Sidebar collapse button
        if (this.ui.collapseBtn) {
            this.ui.collapseBtn.onclick = () => {
                this.toggleSidebarCollapse();
            };
        }
    }

    toggleSidebarCollapse() {
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        this.ui.sidebar.classList.toggle('collapsed', this.state.sidebarCollapsed);
        localStorage.setItem('sidebar_collapsed', this.state.sidebarCollapsed);
    }

    setupListeners() {
        this.ui.sourceInput.oninput = () => { this.ui.playlistSelect.value = 'manual'; };

        let searchTimeout;
        this.ui.searchInput.oninput = () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.applyFilters(), 250);
        };

        this.ui.playlistSelect.onchange = () => {
            const val = this.ui.playlistSelect.value;
            if (val !== 'manual') {
                if (val !== 'favorites') this.ui.sourceInput.value = val;
                this.loadPlaylist(val);
            }
        };

        this.ui.loadBtn.onclick = () => this.loadPlaylist(this.ui.sourceInput.value);
        this.ui.sourceInput.onkeydown = (e) => {
            if (e.key === 'Enter') this.loadPlaylist(this.ui.sourceInput.value);
        };

        this.ui.categorySelect.onchange = () => this.applyFilters();
        this.ui.mobileBtn.onclick = () => this.ui.sidebar.classList.toggle('open');

        this.ui.channelList.onscroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = this.ui.channelList;
            if (scrollTop + clientHeight >= scrollHeight - 100) {
                this.renderMoreChannels();
            }
        };


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

        this.ui.hwPip.onclick = async () => {
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else if (this.ui.video.readyState >= 2) await this.ui.video.requestPictureInPicture();
            } catch (e) { console.error(e); }
        };

        this.ui.hwMute.onclick = () => {
            this.ui.video.muted = !this.ui.video.muted;
            this.ui.hwMute.classList.toggle('active', this.ui.video.muted);
            this.ui.hwMute.textContent = this.ui.video.muted ? 'UNMUTE' : 'MUTE';
        };

        this.ui.hwFS.onclick = () => { this.plyr.fullscreen.toggle(); };

        this.ui.hwSeek.onclick = (e) => {
            const rect = this.ui.hwSeek.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            this.ui.video.currentTime = pos * this.ui.video.duration;
        };

        this.ui.hwVolSlider.onclick = (e) => {
            const rect = this.ui.hwVolSlider.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const vol = Math.max(0, Math.min(1, x / rect.width));
            this.ui.video.volume = vol;
            this.state.volume = vol;
            localStorage.setItem('tv_volume', vol);
            this.updateVolumeUI(vol);
        };

        // Key controls for sliders
        const handleSliderKey = (e, callback) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.stopPropagation();
                callback(e.key === 'ArrowRight');
            }
        };

        this.ui.hwSeek.onkeydown = (e) => {
            handleSliderKey(e, (isRight) => {
                this.ui.video.currentTime += isRight ? 10 : -10;
            });
        };

        this.ui.hwVolSlider.onkeydown = (e) => {
            handleSliderKey(e, (isRight) => {
                let v = this.ui.video.volume;
                v = isRight ? Math.min(1, v + 0.1) : Math.max(0, v - 0.1);
                this.updateVolumeUI(v);
                this.state.volume = v;
                localStorage.setItem('tv_volume', v);
            });
        };

        this.ui.video.addEventListener('dblclick', () => {
            this.plyr.fullscreen.toggle();
        });

        this.ui.video.addEventListener('timeupdate', () => {
            const perc = (this.ui.video.currentTime / this.ui.video.duration) * 100;
            this.ui.hwProgress.style.width = (perc || 0) + '%';
        });

        this.ui.video.addEventListener('play', () => {
            this.ui.hwPlay.textContent = 'PAUSE';
            this.ui.hwPlay.classList.add('active');
        });

        this.ui.video.addEventListener('pause', () => {
            this.ui.hwPlay.textContent = 'PLAY';
            this.ui.hwPlay.classList.remove('active');
        });
    }

    updateVolumeUI(v) {
        this.ui.video.volume = v;
        if (this.plyr) this.plyr.volume = v;
        if (this.ui.hwVolFill) this.ui.hwVolFill.style.width = (v * 100) + '%';

        const originalTitle = this.ui.displayTitle.textContent;
        // Don't overwrite if it's already a volume indicator to avoid flickering
        if (!originalTitle.startsWith('[ VOL:')) {
            this.ui.displayTitle.dataset.originalTitle = originalTitle;
        }

        this.ui.displayTitle.textContent = `[ VOL: ${Math.round(v * 100)}% ]`;

        clearTimeout(this.volTimeout);
        this.volTimeout = setTimeout(() => {
            if (this.ui.displayTitle.textContent.startsWith('[ VOL:')) {
                // Restore title if playing, or default
                this.ui.displayTitle.textContent = this.ui.displayTitle.dataset.originalTitle || originalTitle;
            }
        }, 1000);
    }

    setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            const isInput = document.activeElement.tagName === 'INPUT';
            const isActiveSelect = document.activeElement.tagName === 'SELECT';

            if (e.key === 'Tab' || e.key === 'Escape') {
                if (e.key === 'Tab') e.preventDefault();
                this.ui.sidebar.classList.toggle('open');
                return;
            }

            // Spatial Navigation
            if (document.activeElement.classList.contains('channel-item')) {
                this.handleChannelListNav(e);
            } else if (document.activeElement === this.ui.searchInput) {
                this.handleSearchNav(e);
            } else if (document.activeElement.classList.contains('hw-btn') ||
                document.activeElement.classList.contains('hw-vol-slider-container') ||
                document.activeElement.classList.contains('hw-progress-container')) {
                this.handleHardwareNav(e);
            } else if (this.ui.sidebar.contains(document.activeElement)) {
                if (e.key === 'ArrowRight' && !isActiveSelect) {
                    e.preventDefault();
                    this.ui.sidebar.classList.remove('open');
                    this.focusChannelList();
                }
            } else {
                if (e.key === 'ArrowLeft' && !isInput) {
                    this.ui.sidebar.classList.add('open');
                    this.ui.categorySelect.focus();
                }
            }

            // Global Shortcuts
            if (!isInput) {
                if (e.key === '1') this.setListTab('all', document.getElementById('tab-all'));
                else if (e.key === '2') this.setListTab('favorites', document.getElementById('tab-fav'));
                else if (e.key === '3') this.setListTab('recents', document.getElementById('tab-recent'));
                else if (e.key === 'h' || e.key === 'H' || e.key === '?') {
                    if (this.ui.helpOverlay) this.ui.helpOverlay.classList.toggle('hidden');
                } else if (e.key === 'f' || e.key === 'F') {
                    const active = document.activeElement;
                    if (active.classList.contains('channel-item')) {
                        const idx = parseInt(active.dataset.index);
                        const ch = this.state.filteredChannels[idx];
                        if (ch) this.toggleFavoriteManual(ch.url, active.querySelector('.fav-btn'));
                    }
                } else if (e.key === 'm' || e.key === 'M') {
                    this.ui.hwMute.click();
                } else if (e.key === ' ') {
                    e.preventDefault();
                    this.ui.hwPlay.click();
                }
            }
        });
    }

    handleChannelListNav(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = document.activeElement.nextElementSibling;
            if (next) next.focus();
            else this.ui.hwPlay.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prev = document.activeElement.previousElementSibling;
            if (prev) prev.focus();
            else this.ui.searchInput.focus();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.ui.sidebar.classList.add('open');
            this.ui.categorySelect.focus();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.ui.hwPlay.focus();
        }
    }

    handleSearchNav(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const first = this.ui.channelList.querySelector('.channel-item');
            if (first) first.focus();
        } else if (e.key === 'ArrowLeft') {
            this.ui.sidebar.classList.add('open');
            this.ui.playlistSelect.focus();
        }
    }

    handleHardwareNav(e) {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.focusChannelList();
        } else if (e.key === 'ArrowRight') {
            if (document.activeElement === this.ui.hwFS) {
                e.preventDefault();
                this.ui.hwPlay.focus();
            }
        } else if (e.key === 'ArrowLeft') {
            if (document.activeElement === this.ui.hwPlay) {
                e.preventDefault();
                this.ui.hwFS.focus();
            }
        }
    }

    focusChannelList() {
        const items = this.ui.channelList.querySelectorAll('.channel-item');
        if (items[this.state.selectedIndex]) items[this.state.selectedIndex].focus();
        else if (items[0]) items[0].focus();
    }

    setListTab(tab, el) {
        this.state.activeTab = tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        if (el) el.classList.add('active');
        this.applyFilters();
    }

    toggleConfig() {
        const panel = document.getElementById('configPanel');
        const icon = document.getElementById('configToggle');
        panel.classList.toggle('collapsed');
        icon.textContent = panel.classList.contains('collapsed') ? '[+]' : '[-]';
    }

    async loadPlaylist(url) {
        localStorage.setItem('playlist_url', url);

        if (url === 'favorites') {
            this.setListTab('favorites', document.getElementById('tab-fav'));
            this.ui.statusText.textContent = 'LOCAL_MODE';
            this.ui.channelList.innerHTML = '';
            this.ui.channelCount.textContent = this.state.favorites.size;
            this.applyFilters();
            this.triggerStatic(500);
            return;
        }

        url = url.trim() || this.DEFAULT_PLAYLIST;

        // Sync dropdown
        const option = Array.from(this.ui.playlistSelect.options).find(opt => opt.value === url);
        if (option) this.ui.playlistSelect.value = url;
        else this.ui.playlistSelect.value = 'manual';

        this.ui.sourceInput.value = url;
        this.ui.statusText.textContent = 'LOADING...';
        this.ui.statusDot.classList.remove('error');
        this.ui.channelList.innerHTML = '<div style="padding:20px; color:var(--terminal-muted)">&gt; FETCHING MANIFEST...</div>';

        this.triggerStatic(1000);

        try {
            let text;
            try {
                console.log(`> FETCH: Attempting direct connection to ${url}`);
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP_${res.status}`);
                text = await res.text();
            } catch (directErr) {
                console.warn(`> DIRECT_FETCH_FAILED: ${directErr.message}. Retrying via CORS Proxy...`);
                this.ui.channelList.innerHTML = '<div style="padding:20px; color:var(--terminal-amber)">&gt; DIRECT_CONN_FAIL <br>&gt; REROUTING VIA PROXY...</div>';

                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
                const proxyRes = await fetch(proxyUrl);
                if (!proxyRes.ok) throw new Error(`PROXY_HTTP_${proxyRes.status}`);
                text = await proxyRes.text();
            }

            if (!text || (!text.includes('#EXTM3U') && !url.includes('.m3u8'))) {
                throw new Error('INVALID_M3U_FORMAT');
            }

            if (url.includes('.m3u8') && !text.includes('#EXTINF')) {
                const isCp24 = url.toLowerCase().includes('cp24');
                const channelName = isCp24 ? 'CP24 LIVE' : 'DIRECT STREAM';
                const logo = isCp24 ? 'https://www.cp24.com/polopoly_fs/1.4334334.1553086303!/httpImage/image.jpg_gen/derivatives/landscape_620/image.jpg' : '';
                const category = isCp24 ? 'NEWS' : 'LIVE';
                text = `#EXTM3U\n#EXTINF:-1 tvg-logo="${logo}" group-title="${category}",${channelName}\n${url}`;
            }

            this.parsePlaylist(text);
            this.populateCategoryDropdown();
            this.applyFilters();

            this.ui.statusText.textContent = 'READY';
            this.ui.channelCount.textContent = this.state.channels.length;

        } catch (err) {
            console.error(err);
            this.ui.channelList.innerHTML = `
                <div style="padding:20px; color:var(--terminal-red)">
                    <div>> ERR_CONNECTION_FAILED</div>
                    <div style="color:var(--terminal-muted); font-size:10px; margin-top:5px">${err.message}</div>
                    <div style="margin-top:10px">> CHECK URL OR TRY PRESET</div>
                    <button onclick="window.retryPlaylist()" style="background:transparent; border:1px solid var(--terminal-amber); color:var(--terminal-amber); padding:8px 16px; font-family:inherit; cursor:pointer; margin-top:15px; font-size:11px;">
                        > RETRY_CONNECTION
                    </button>
                </div>`;
            this.ui.statusText.textContent = 'ERROR';
            this.ui.statusDot.classList.add('error');

            // Expose retry function
            window.retryPlaylist = () => {
                this.loadPlaylist(this.ui.sourceInput.value || this.DEFAULT_PLAYLIST);
            };
        }
    }

    parsePlaylist(content) {
        this.state.channels = [];
        this.state.categories = {};
        this.state.languages = new Set();

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

                const logo = getAttr('tvg-logo');
                const country = getAttr('tvg-country');
                const groupRaw = getAttr('group-title') || 'UNCATEGORIZED';
                const language = getAttr('tvg-language') || getAttr('tvg-lang') || 'Unknown';

                let category = groupRaw;
                if (groupRaw.includes(';')) {
                    category = groupRaw.split(';')[0].trim();
                } else if (groupRaw.includes('|')) {
                    category = groupRaw.split('|')[0].trim();
                }

                current = { name, category, language, groupRaw, logo, country, url: '' };
            } else if (line.startsWith('http')) {
                current.url = line;
                this.state.channels.push(current);

                if (current.category) {
                    if (!this.state.categories[current.category]) this.state.categories[current.category] = 0;
                    this.state.categories[current.category]++;
                }
                if (current.language) this.state.languages.add(current.language);
                current = {};
            }
        }
    }

    populateCategoryDropdown() {
        const cats = Object.keys(this.state.categories).sort();
        this.ui.categorySelect.innerHTML = '<option value="">* ALL *</option>' +
            cats.map(c => `<option value="${c}">${c.toUpperCase()} (${this.state.categories[c]})</option>`).join('');
    }

    triggerStatic(duration = 400) {
        const noise = document.querySelector('.static-noise');
        noise.classList.add('active');
        setTimeout(() => noise.classList.remove('active'), duration);
    }

    applyFilters() {
        // Special handling for favorites tab - use the new collapsible lists view
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
            if (search && !ch.name.toLowerCase().includes(search) && !ch.groupRaw.toLowerCase().includes(search)) return false;
            return true;
        });

        if (this.state.activeTab === 'recents') {
            this.state.filteredChannels.sort((a, b) => {
                const idxA = this.state.recents.findIndex(r => r.url === a.url);
                const idxB = this.state.recents.findIndex(r => r.url === b.url);
                return idxA - idxB;
            });
        }

        this.state.renderIndex = 0;
        this.state.selectedIndex = -1;
        this.ui.channelList.innerHTML = '';
        this.renderMoreChannels();
        this.ui.channelCount.textContent = this.state.filteredChannels.length;

        if (this.state.filteredChannels.length === 0) {
            this.ui.channelList.innerHTML = '<div style="padding:20px; color:var(--terminal-muted)"> &gt; NO SIGNALS FOUND</div>';
        }
    }

    renderMoreChannels() {
        // Don't render more channels if on favorites tab - it has its own rendering
        if (this.state.activeTab === 'favorites') return;

        // Optimization: Reduce batch size to prevent long frames
        const batchSize = 50;
        const start = this.state.renderIndex;
        const end = Math.min(start + batchSize, this.state.filteredChannels.length);

        if (start >= this.state.filteredChannels.length) return;

        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const ch = this.state.filteredChannels[i];
            const isFav = this.state.favorites.has(ch.url);
            const item = document.createElement('div');
            item.className = 'channel-item';
            item.dataset.index = i;
            item.tabIndex = 7;

            // Safe logo - lazy loaded
            const logoHtml = ch.logo ?
                `<img class="ch-logo" src="${ch.logo}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 100 100\\'%3E%3Crect width=\\'100\\' height=\\'100\\' fill=\\'%231a1a1a\\'/%3E%3Ctext y=\\'50%25\\' x=\\'50%25\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\' fill=\\'%23333\\' font-size=\\'40\\' font-family=\\'monospace\\'%3ETV%3C/text%3E%3C/svg%3E'">` :
                `<div class="ch-logo" style="display:flex;align-items:center;justify-content:center;color:#333;font-size:10px;">TV</div>`;

            item.innerHTML = `
                ${logoHtml}
                <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); window.toggleFavoriteManual('${ch.url}', this)" tabindex="-1">${isFav ? '★' : '☆'}</button>
                <div class="channel-main">
                    <span class="ch-name">${ch.name}</span>
                    <span class="ch-group" style="margin-left:auto;">${ch.category}</span>
                </div>
            `;
            item.onclick = () => this.selectChannel(ch, item, i);
            item.onkeydown = (e) => {
                if (e.key === 'Enter') this.selectChannel(ch, item, i);
            };
            item.onfocus = () => {
                this.state.selectedIndex = i;
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            };
            fragment.appendChild(item);
        }

        this.ui.channelList.appendChild(fragment);
        this.state.renderIndex = end;
    }

    selectChannel(ch, item, index) {
        this.state.selectedIndex = index;
        this.ui.channelList.querySelectorAll('.channel-item').forEach(c => c.classList.remove('active'));
        item.classList.add('active');

        // Update recents
        this.state.recents = [{ name: ch.name, url: ch.url }, ...this.state.recents.filter(r => r.url !== ch.url)].slice(0, 10);
        localStorage.setItem('recent_channels', JSON.stringify(this.state.recents));

        this.triggerStatic(300);
        this.playChannel(ch);
        if (window.innerWidth <= 900) this.ui.sidebar.classList.remove('open');
    }

    toggleFavoriteManual(url, btn) {
        this.toggleFavorite(url);
        const isFav = this.state.favorites.has(url);
        if (btn) {
            btn.className = `fav-btn ${isFav ? 'active' : ''}`;
            btn.textContent = isFav ? '★' : '☆';
        }

        // Always refresh favorites view when on favorites tab
        if (this.state.activeTab === 'favorites') {
            this.renderFavoritesView();
        }
    }

    toggleFavorite(url) {
        if (this.state.favorites.has(url)) {
            this.state.favorites.delete(url);
            // Also remove from all custom lists
            Object.keys(this.state.favoriteLists).forEach(listId => {
                const idx = this.state.favoriteLists[listId].channels.indexOf(url);
                if (idx > -1) {
                    this.state.favoriteLists[listId].channels.splice(idx, 1);
                }
            });
            this.saveFavoriteLists();
        } else {
            this.state.favorites.add(url);
        }
        localStorage.setItem('fav_channels', JSON.stringify(Array.from(this.state.favorites)));
    }

    // ========== FAVORITES LISTS MANAGEMENT ==========

    saveFavoriteLists() {
        localStorage.setItem('fav_lists', JSON.stringify(this.state.favoriteLists));
        localStorage.setItem('fav_lists_collapsed', JSON.stringify(this.state.favListsCollapsed));
    }

    createFavoriteList(name) {
        const listId = 'list_' + Date.now();
        this.state.favoriteLists[listId] = {
            name: name,
            channels: []
        };
        this.state.favListsCollapsed[listId] = false;
        this.saveFavoriteLists();
        return listId;
    }

    deleteFavoriteList(listId) {
        if (this.state.favoriteLists[listId]) {
            delete this.state.favoriteLists[listId];
            delete this.state.favListsCollapsed[listId];
            this.saveFavoriteLists();
            // Reset to 'all' view if we deleted the active list
            if (this.state.activeFavList === listId) {
                this.state.activeFavList = 'all';
            }
            this.renderFavoritesView();
        }
    }

    renameFavoriteList(listId, newName) {
        if (this.state.favoriteLists[listId]) {
            this.state.favoriteLists[listId].name = newName;
            this.saveFavoriteLists();
            this.renderFavoritesView();
        }
    }

    addChannelToList(listId, url) {
        if (this.state.favoriteLists[listId]) {
            if (!this.state.favoriteLists[listId].channels.includes(url)) {
                this.state.favoriteLists[listId].channels.push(url);
                this.saveFavoriteLists();
            }
        }
    }

    removeChannelFromList(listId, url) {
        if (this.state.favoriteLists[listId]) {
            const idx = this.state.favoriteLists[listId].channels.indexOf(url);
            if (idx > -1) {
                this.state.favoriteLists[listId].channels.splice(idx, 1);
                this.saveFavoriteLists();
            }
        }
    }

    toggleFavListCollapse(listId) {
        this.state.favListsCollapsed[listId] = !this.state.favListsCollapsed[listId];
        this.saveFavoriteLists();
    }

    showAddToListMenu(url, btn) {
        // Remove any existing menu
        const existing = document.querySelector('.add-to-list-menu');
        if (existing) existing.remove();

        const lists = Object.entries(this.state.favoriteLists);
        if (lists.length === 0) {
            // No lists, prompt to create one
            this.promptCreateList(url);
            return;
        }

        const menu = document.createElement('div');
        menu.className = 'add-to-list-menu';
        menu.innerHTML = `
            <div class="menu-header">ADD TO LIST</div>
            ${lists.map(([id, list]) => {
            const isInList = list.channels.includes(url);
            return `<div class="menu-item ${isInList ? 'in-list' : ''}" data-list-id="${id}">
                    <span class="menu-check">${isInList ? '✓' : ''}</span>
                    <span class="menu-name">${list.name}</span>
                </div>`;
        }).join('')}
            <div class="menu-divider"></div>
            <div class="menu-item menu-new" data-action="new">+ NEW LIST</div>
        `;

        // Position menu near the button
        const rect = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.right + 5}px`;
        menu.style.top = `${rect.top}px`;
        menu.style.zIndex = '10000';

        document.body.appendChild(menu);

        // Handle clicks
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.menu-item');
            if (!item) return;

            if (item.dataset.action === 'new') {
                menu.remove();
                this.promptCreateList(url);
            } else if (item.dataset.listId) {
                const listId = item.dataset.listId;
                const isInList = this.state.favoriteLists[listId].channels.includes(url);
                if (isInList) {
                    this.removeChannelFromList(listId, url);
                } else {
                    this.addChannelToList(listId, url);
                }
                menu.remove();
                if (this.state.activeTab === 'favorites') {
                    this.renderFavoritesView();
                }
            }
        });

        // Close on outside click
        const closeHandler = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) {
                menu.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    promptCreateList(preAddUrl = null) {
        const name = prompt('Enter list name:');
        if (name && name.trim()) {
            const listId = this.createFavoriteList(name.trim());
            if (preAddUrl) {
                this.addChannelToList(listId, preAddUrl);
            }
            if (this.state.activeTab === 'favorites') {
                this.renderFavoritesView();
            }
        }
    }

    promptDeleteList(listId) {
        const list = this.state.favoriteLists[listId];
        if (list && confirm(`Delete list "${list.name}"? Channels will remain in All Starred.`)) {
            this.deleteFavoriteList(listId);
        }
    }

    promptRenameList(listId) {
        const list = this.state.favoriteLists[listId];
        if (list) {
            const newName = prompt('Enter new name:', list.name);
            if (newName && newName.trim()) {
                this.renameFavoriteList(listId, newName.trim());
            }
        }
    }

    renderFavoritesView() {
        const container = this.ui.channelList;
        container.innerHTML = '';

        // Header with + button
        const header = document.createElement('div');
        header.className = 'fav-lists-header';
        header.innerHTML = `
            <button class="fav-new-list-btn" onclick="window.createNewFavList()" title="Create New List">+ NEW LIST</button>
        `;
        container.appendChild(header);

        // Get all favorited channels
        const favChannels = this.state.channels.filter(ch => this.state.favorites.has(ch.url));

        // Render "All Starred" section (always first, not deletable)
        this.renderFavSection(container, 'all', 'ALL STARRED', favChannels, false);

        // Render custom lists
        const listIds = Object.keys(this.state.favoriteLists);
        listIds.forEach(listId => {
            const list = this.state.favoriteLists[listId];
            const listChannels = favChannels.filter(ch => list.channels.includes(ch.url));
            this.renderFavSection(container, listId, list.name, listChannels, true);
        });

        if (favChannels.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 20px; color: var(--terminal-muted); text-align: center;';
            empty.innerHTML = '> NO FAVORITES YET<br><span style="font-size:10px;color:var(--terminal-gray)">Star a channel to add it here</span>';
            container.appendChild(empty);
        }

        this.ui.channelCount.textContent = favChannels.length;
    }

    renderFavSection(container, listId, name, channels, isDeletable) {
        const isCollapsed = this.state.favListsCollapsed[listId] || false;

        // Section header
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'fav-section-header';
        sectionHeader.innerHTML = `
            <span class="fav-section-toggle" onclick="window.toggleFavSection('${listId}')">${isCollapsed ? '▶' : '▼'}</span>
            <span class="fav-section-name" onclick="window.toggleFavSection('${listId}')">${name.toUpperCase()}</span>
            <span class="fav-section-count">(${channels.length})</span>
            ${isDeletable ? `
                <button class="fav-section-delete" onclick="event.stopPropagation(); window.deleteFavList('${listId}')" title="Delete List">✕</button>
            ` : ''}
        `;
        container.appendChild(sectionHeader);

        // Section content (channels)
        if (!isCollapsed) {
            const section = document.createElement('div');
            section.className = 'fav-section-content';
            section.dataset.listId = listId;

            if (channels.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'fav-section-empty';
                empty.textContent = listId === 'all' ? '> No starred channels' : '> No channels in this list';
                section.appendChild(empty);
            } else {
                channels.forEach((ch, i) => {
                    const item = this.createChannelItem(ch, i, listId);
                    section.appendChild(item);
                });
            }

            container.appendChild(section);
        }
    }

    createChannelItem(ch, index, listId = null) {
        const isFav = this.state.favorites.has(ch.url);
        const item = document.createElement('div');
        item.className = 'channel-item';
        item.dataset.index = index;
        item.dataset.url = ch.url;
        item.tabIndex = 7;

        const logoHtml = ch.logo ?
            `<img class="ch-logo" src="${ch.logo}" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 100 100\\'%3E%3Crect width=\\'100\\' height=\\'100\\' fill=\\'%231a1a1a\\'/%3E%3Ctext y=\\'50%25\\' x=\\'50%25\\' text-anchor=\\'middle\\' dominant-baseline=\\'middle\\' fill=\\'%23333\\' font-size=\\'40\\' font-family=\\'monospace\\'%3ETV%3C/text%3E%3C/svg%3E'">` :
            `<div class="ch-logo" style="display:flex;align-items:center;justify-content:center;color:#333;font-size:10px;">TV</div>`;

        // Show list button only if not in "all" view
        const listBtnHtml = listId !== 'all' ?
            `<button class="list-remove-btn" onclick="event.stopPropagation(); window.removeFromFavList('${listId}', '${ch.url}')" title="Remove from list">−</button>` :
            '';

        item.innerHTML = `
            ${logoHtml}
            <button class="fav-btn ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); window.toggleFavoriteManual('${ch.url}', this)" tabindex="-1">${isFav ? '★' : '☆'}</button>
            <button class="add-to-list-btn" onclick="event.stopPropagation(); window.showAddToListMenu('${ch.url}', this)" tabindex="-1" title="Add to list">☰</button>
            ${listBtnHtml}
            <div class="channel-main">
                <span class="ch-name">${ch.name}</span>
                <span class="ch-group" style="margin-left:auto;">${ch.category}</span>
            </div>
        `;

        item.onclick = () => {
            const channelIndex = this.state.channels.findIndex(c => c.url === ch.url);
            this.selectChannel(ch, item, channelIndex);
        };
        item.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const channelIndex = this.state.channels.findIndex(c => c.url === ch.url);
                this.selectChannel(ch, item, channelIndex);
            }
        };

        return item;
    }


    playChannel(channel) {
        this.state.currentChannel = channel;

        this.ui.displayTitle.textContent = `[ ${channel.name.toUpperCase()} ]`;
        // Save original title for volume UI restoration
        this.ui.displayTitle.dataset.originalTitle = this.ui.displayTitle.textContent;

        this.ui.displayInfo.innerHTML = `<span style="color:var(--terminal-muted)">GENRE:</span> ${channel.groupRaw}`;
        this.ui.indicator.classList.add('on');

        this.ui.overlay.classList.remove('hidden');
        this.ui.bootText.innerHTML = `
            <div class="line">&gt; CONNECTING TO STREAM...</div>
            <div class="line" style="animation-delay:0.2s">&gt; TARGET: ${channel.name}</div>
            <div class="line" style="animation-delay:0.4s">&gt; PROTOCOL: HLS/M3U8</div>
        `;

        if (this.state.hls) {
            this.state.hls.destroy();
            this.state.hls = null;
        }

        if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
            this.state.hls = hls;

            hls.attachMedia(this.ui.video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(channel.url);
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.ui.overlay.classList.add('hidden');
                this.plyr.play().catch(error => {
                    this.showAutoplayError();
                });
            });

            hls.on(Hls.Events.ERROR, (_, data) => this.handleHlsError(data, hls));

            // Stats
            hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
                if (data.stats) {
                    const bitrate = Math.round(data.stats.total / (data.stats.tloaded - data.stats.trequest) * 1000 * 8 / 1024);
                    if (document.getElementById('statBitrate')) document.getElementById('statBitrate').textContent = `${bitrate} kbps`;
                }
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                if (hls.levels[data.level]) {
                    const level = hls.levels[data.level];
                    if (document.getElementById('statRes')) document.getElementById('statRes').textContent = `${level.width}x${level.height}`;
                }
            });

        } else if (this.ui.video.canPlayType('application/vnd.apple.mpegurl')) {
            this.ui.video.src = channel.url;
            this.ui.video.addEventListener('loadedmetadata', () => {
                this.ui.overlay.classList.add('hidden');
                this.plyr.play().catch(error => this.showAutoplayError());
            }, { once: true });
            this.ui.video.addEventListener('error', () => this.showError('DECODE_ERROR'), { once: true });
        }
    }

    handleHlsError(data, hls) {
        const config = this.state.retryConfig;

        if (data.fatal) {
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    // Use exponential backoff for network errors
                    if (config.currentRetry < config.maxRetries) {
                        const delay = this.calculateBackoffDelay(config.currentRetry);
                        config.currentRetry++;

                        console.log(`> STREAM_RETRY: Attempt ${config.currentRetry}/${config.maxRetries} in ${delay}ms`);
                        this.showRetrying(config.currentRetry, config.maxRetries, delay);

                        setTimeout(() => {
                            hls.startLoad();
                        }, delay);
                    } else {
                        config.currentRetry = 0;
                        this.showError('NETWORK_ERROR', true);
                    }
                    break;

                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('> STREAM: Recovering from media error...');
                    hls.recoverMediaError();
                    break;

                default:
                    config.currentRetry = 0;
                    hls.destroy();
                    this.showError('STREAM_OFFLINE', true);
                    break;
            }
        }
    }

    calculateBackoffDelay(retryCount) {
        const config = this.state.retryConfig;
        // Exponential backoff: baseDelay * 2^retryCount with jitter
        const exponentialDelay = config.baseDelay * Math.pow(2, retryCount);
        const jitter = Math.random() * 500; // Add random jitter up to 500ms
        return Math.min(exponentialDelay + jitter, config.maxDelay);
    }

    showRetrying(attempt, maxAttempts, delay) {
        this.ui.overlay.classList.remove('hidden');
        this.ui.bootText.innerHTML = `
            <div class="line" style="color:var(--terminal-amber)">> STREAM_INTERRUPTED</div>
            <div class="line" style="animation-delay:0.2s">> RETRY_ATTEMPT: ${attempt}/${maxAttempts}</div>
            <div class="line" style="animation-delay:0.4s">> RECONNECTING IN ${Math.round(delay / 1000)}s...</div>
            <div class="line" style="animation-delay:0.6s; color:var(--terminal-muted)">> EXPONENTIAL_BACKOFF_ACTIVE</div>
        `;
        this.ui.displayTitle.textContent = '[ RECONNECTING... ]';

        // Auto-hide overlay if stream recovers
        setTimeout(() => {
            if (this.ui.video.readyState >= 2 && !this.ui.video.paused) {
                this.ui.overlay.classList.add('hidden');
                this.state.retryConfig.currentRetry = 0;
            }
        }, delay + 1000);
    }

    showError(code, allowRetry = false) {
        this.state.retryConfig.currentRetry = 0;
        this.ui.overlay.classList.remove('hidden');

        const retryButton = allowRetry && this.state.currentChannel ? `
            <div class="line" style="animation-delay:0.6s">
                <button onclick="window.retryStream()" style="background:transparent; border:1px solid var(--terminal-amber); color:var(--terminal-amber); padding:8px 16px; font-family:inherit; cursor:pointer; margin-top:10px;">
                    > RETRY_CONNECTION
                </button>
            </div>
        ` : '';

        this.ui.bootText.innerHTML = `
            <div class="line error-text">> ERROR: ${code}</div>
            <div class="line" style="animation-delay:0.2s; color:var(--terminal-muted)">> STREAM MAY BE OFFLINE OR GEO-BLOCKED</div>
            <div class="line" style="animation-delay:0.4s; color:var(--terminal-amber)">> SELECT ANOTHER CHANNEL_</div>
            ${retryButton}
        `;
        this.ui.displayTitle.textContent = '[ SIGNAL LOST ]';
        this.ui.indicator.classList.remove('on');

        // Expose retry function
        window.retryStream = () => {
            if (this.state.currentChannel) {
                this.playChannel(this.state.currentChannel);
            }
        };
    }

    showAutoplayError() {
        this.ui.bootText.innerHTML = `
            <div class="line" style="color:var(--terminal-amber)">> AUTOPLAY_BLOCKED</div>
            <div class="line" style="animation-delay:0.2s">> BROWSER_POLICY_RESTRICTION</div>
            <div class="line" style="animation-delay:0.4s">> CLICK_SCREEN_TO_INITIALIZE</div>
        `;
        this.ui.overlay.classList.remove('hidden');

        // Allow clicking overlay to play
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
