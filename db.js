// HOME TV - IndexedDB Storage Module
// Provides persistent storage that survives cache clears
// Falls back to localStorage if IndexedDB unavailable

class TVDatabase {
    constructor() {
        this.DB_NAME = 'HomeTVData';
        this.DB_VERSION = 1;
        this.db = null;
        this.isReady = false;
        this.readyPromise = this.init();
    }

    async init() {
        if (!window.indexedDB) {
            console.warn('[DB] IndexedDB not supported, using localStorage fallback');
            this.useFallback = true;
            this.isReady = true;
            return;
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => {
                console.warn('[DB] Failed to open IndexedDB, using localStorage fallback');
                this.useFallback = true;
                this.isReady = true;
                resolve();
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.useFallback = false;
                this.isReady = true;
                console.log('[DB] IndexedDB initialized successfully');
                this.migrateFromLocalStorage();
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Store for user preferences and app state
                if (!db.objectStoreNames.contains('preferences')) {
                    db.createObjectStore('preferences', { keyPath: 'key' });
                }

                // Store for favorites
                if (!db.objectStoreNames.contains('favorites')) {
                    db.createObjectStore('favorites', { keyPath: 'url' });
                }

                // Store for custom lists
                if (!db.objectStoreNames.contains('lists')) {
                    db.createObjectStore('lists', { keyPath: 'id' });
                }

                // Store for recent channels
                if (!db.objectStoreNames.contains('recents')) {
                    db.createObjectStore('recents', { keyPath: 'url' });
                }

                // Store for dead/problematic channels
                if (!db.objectStoreNames.contains('deadChannels')) {
                    const store = db.createObjectStore('deadChannels', { keyPath: 'url' });
                    store.createIndex('failCount', 'failCount', { unique: false });
                }

                console.log('[DB] Database schema created');
            };
        });
    }

    async ensureReady() {
        if (!this.isReady) {
            await this.readyPromise;
        }
    }

    // === MIGRATION FROM LOCALSTORAGE ===
    async migrateFromLocalStorage() {
        try {
            const migrated = await this.get('preferences', '_migrated');
            if (migrated) return;

            console.log('[DB] Migrating from localStorage...');

            // Migrate favorites
            const favChannels = JSON.parse(localStorage.getItem('fav_channels') || '[]');
            for (const url of favChannels) {
                await this.put('favorites', { url, addedAt: Date.now() });
            }

            // Migrate custom lists
            const favLists = JSON.parse(localStorage.getItem('fav_lists') || '{}');
            const favListsCollapsed = JSON.parse(localStorage.getItem('fav_lists_collapsed') || '{}');
            for (const [id, list] of Object.entries(favLists)) {
                await this.put('lists', {
                    id,
                    name: list.name,
                    channels: list.channels,
                    collapsed: favListsCollapsed[id] !== undefined ? favListsCollapsed[id] : true,
                    createdAt: Date.now()
                });
            }

            // Migrate recents
            const recents = JSON.parse(localStorage.getItem('recent_channels') || '[]');
            for (let i = 0; i < recents.length; i++) {
                await this.put('recents', {
                    url: recents[i].url,
                    name: recents[i].name,
                    timestamp: Date.now() - i * 1000,
                    order: i
                });
            }

            // Migrate preferences
            const prefs = [
                { key: 'playlist_url', value: localStorage.getItem('playlist_url') },
                { key: 'tv_volume', value: parseFloat(localStorage.getItem('tv_volume') || '0.5') },
                { key: 'tv_theme', value: localStorage.getItem('tv_theme') || 'green' },
                { key: 'sidebar_collapsed', value: localStorage.getItem('sidebar_collapsed') === 'true' },
                { key: 'view_mode', value: localStorage.getItem('view_mode') || 'list' }
            ];
            for (const pref of prefs) {
                if (pref.value !== null) {
                    await this.put('preferences', pref);
                }
            }

            // Mark as migrated
            await this.put('preferences', { key: '_migrated', value: true, migratedAt: Date.now() });
            console.log('[DB] Migration complete');

        } catch (err) {
            console.error('[DB] Migration error:', err);
        }
    }

    // === GENERIC CRUD OPERATIONS ===
    async put(storeName, data) {
        await this.ensureReady();

        if (this.useFallback) {
            return this._localStoragePut(storeName, data);
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(data);
            request.onerror = () => reject(request.error);
        });
    }

    async get(storeName, key) {
        await this.ensureReady();

        if (this.useFallback) {
            return this._localStorageGet(storeName, key);
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll(storeName) {
        await this.ensureReady();

        if (this.useFallback) {
            return this._localStorageGetAll(storeName);
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async delete(storeName, key) {
        await this.ensureReady();

        if (this.useFallback) {
            return this._localStorageDelete(storeName, key);
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async clear(storeName) {
        await this.ensureReady();

        if (this.useFallback) {
            return this._localStorageClear(storeName);
        }

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // === LOCALSTORAGE FALLBACK ===
    _getStorageKey(storeName, key = null) {
        return key ? `hometv_${storeName}_${key}` : `hometv_${storeName}`;
    }

    _localStoragePut(storeName, data) {
        const key = data.key || data.url || data.id;
        const items = JSON.parse(localStorage.getItem(this._getStorageKey(storeName)) || '{}');
        items[key] = data;
        localStorage.setItem(this._getStorageKey(storeName), JSON.stringify(items));
        return data;
    }

    _localStorageGet(storeName, key) {
        const items = JSON.parse(localStorage.getItem(this._getStorageKey(storeName)) || '{}');
        return items[key];
    }

    _localStorageGetAll(storeName) {
        const items = JSON.parse(localStorage.getItem(this._getStorageKey(storeName)) || '{}');
        return Object.values(items);
    }

    _localStorageDelete(storeName, key) {
        const items = JSON.parse(localStorage.getItem(this._getStorageKey(storeName)) || '{}');
        delete items[key];
        localStorage.setItem(this._getStorageKey(storeName), JSON.stringify(items));
    }

    _localStorageClear(storeName) {
        localStorage.removeItem(this._getStorageKey(storeName));
    }

    // === HIGH-LEVEL API ===

    // Favorites
    async getFavorites() {
        const favs = await this.getAll('favorites');
        return new Set(favs.map(f => f.url));
    }

    async addFavorite(url) {
        await this.put('favorites', { url, addedAt: Date.now() });
    }

    async removeFavorite(url) {
        await this.delete('favorites', url);
    }

    async isFavorite(url) {
        const fav = await this.get('favorites', url);
        return !!fav;
    }

    // Lists
    async getLists() {
        const lists = await this.getAll('lists');
        const result = {};
        for (const list of lists) {
            result[list.id] = {
                name: list.name,
                channels: list.channels || [],
                collapsed: list.collapsed !== undefined ? list.collapsed : true
            };
        }
        return result;
    }

    async saveList(id, data) {
        await this.put('lists', { id, ...data });
    }

    async deleteList(id) {
        await this.delete('lists', id);
    }

    // Recents
    async getRecents() {
        const recents = await this.getAll('recents');
        return recents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 10);
    }

    async addRecent(channel) {
        await this.put('recents', {
            url: channel.url,
            name: channel.name,
            timestamp: Date.now()
        });
        // Trim to 10 most recent
        const all = await this.getAll('recents');
        const sorted = all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        for (let i = 10; i < sorted.length; i++) {
            await this.delete('recents', sorted[i].url);
        }
    }

    // Preferences
    async getPref(key, defaultValue = null) {
        const pref = await this.get('preferences', key);
        return pref ? pref.value : defaultValue;
    }

    async setPref(key, value) {
        await this.put('preferences', { key, value });
    }

    // Dead Channels
    async markChannelFailed(url) {
        const existing = await this.get('deadChannels', url) || { url, failCount: 0, lastFail: 0 };
        existing.failCount++;
        existing.lastFail = Date.now();
        await this.put('deadChannels', existing);
        return existing.failCount;
    }

    async getChannelFailCount(url) {
        const record = await this.get('deadChannels', url);
        return record ? record.failCount : 0;
    }

    async resetChannelFails(url) {
        await this.delete('deadChannels', url);
    }

    async getDeadChannels() {
        const all = await this.getAll('deadChannels');
        return all.filter(c => c.failCount >= 3);
    }

    // === EXPORT / IMPORT ===
    async exportAllData() {
        await this.ensureReady();

        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            favorites: await this.getAll('favorites'),
            lists: await this.getAll('lists'),
            recents: await this.getAll('recents'),
            preferences: await this.getAll('preferences')
        };

        return data;
    }

    async importAllData(data) {
        await this.ensureReady();

        if (!data || data.version !== 1) {
            throw new Error('Invalid backup file format');
        }

        // Clear existing data
        await this.clear('favorites');
        await this.clear('lists');
        await this.clear('recents');
        await this.clear('preferences');

        // Import favorites
        for (const fav of (data.favorites || [])) {
            await this.put('favorites', fav);
        }

        // Import lists
        for (const list of (data.lists || [])) {
            await this.put('lists', list);
        }

        // Import recents
        for (const recent of (data.recents || [])) {
            await this.put('recents', recent);
        }

        // Import preferences (except migration flag)
        for (const pref of (data.preferences || [])) {
            if (pref.key !== '_migrated') {
                await this.put('preferences', pref);
            }
        }

        // Re-mark as migrated to prevent re-migration
        await this.put('preferences', { key: '_migrated', value: true, migratedAt: Date.now() });

        console.log('[DB] Import complete');
    }
}

// Global instance
window.tvDB = new TVDatabase();
