// =====================================================
// Torrent Bridge Plugin
// Минималистичный мост между TorrentManager и TorrServer
// Версия: 1.0
// =====================================================

(function() {
    'use strict';

    const PLUGIN_NAME = 'Torrent Bridge';
    const PLUGIN_VERSION = '1.0';

    // ===== КОНФИГУРАЦИЯ =====
    const CONFIG = {
        // Берем настройки из существующих плагинов
        get transmissionUrl() {
            return Lampa.Storage.get('lmetorrenttransmissionUrl') || 'http://192.168.1.101:9091';
        },
        get transmissionUser() {
            return Lampa.Storage.get('lmetorrenttransmissionUser') || 'admin';
        },
        get transmissionPass() {
            return Lampa.Storage.get('lmetorrenttransmissionPass') || 'admin';
        },
        get torrserverUrl() {
            // Берем из настроек TorrServer плагина Lampa
            return Lampa.Storage.get('torrserver_url') || 'http://192.168.1.101:8090';
        },
        get localPath() {
            return Lampa.Storage.get('torrentbridge_local_path') || 'http://192.168.1.112:8080/';
        },
        mode: 'hybrid' // hybrid | stream | download
    };

    // ===== РАБОТА С TRANSMISSION (через LME TorrentManager) =====
    // Используем готовые методы из LME TorrentManager
    function getTransmissionClient() {
        // Проверяем, доступен ли Transmission через LME TorrentManager
        if (typeof Transmission !== 'undefined' && Transmission.auth) {
            return Transmission;
        }

        // Если нет - создаем свой минимальный клиент
        return {
            sessionId: null,
            sessionKey: 'torrentbridge_transmission_session',

            getSessionId: async function() {
                if (this.sessionId) {
                    return this.sessionId;
                }

                this.sessionId = Lampa.Storage.get(this.sessionKey);
                if (this.sessionId) {
                    return this.sessionId;
                }

                try {
                    const response = await this.request('/transmission/rpc', {
                        method: 'session-get'
                    });

                    if (response && response.status === 409) {
                        this.sessionId = response.headers.get('X-Transmission-Session-Id');
                        Lampa.Storage.set(this.sessionKey, this.sessionId);
                        return this.sessionId;
                    }
                    return null;
                } catch (e) {
                    return null;
                }
            },

            request: async function(path, data) {
                const config = CONFIG;
                const url = `${config.transmissionUrl}${path}`;
                const headers = {
                    'Authorization': 'Basic ' + btoa(`${config.transmissionUser}:${config.transmissionPass}`),
                    'Content-Type': 'application/json'
                };

                if (this.sessionId) {
                    headers['X-Transmission-Session-Id'] = this.sessionId;
                }

                return new Promise((resolve, reject) => {
                    const req = new Lampa.Reguest();
                    req.quiet(url, resolve, reject, data ? JSON.stringify(data) : null, {
                        headers: headers,
                        type: 'POST',
                        dataType: 'json'
                    });
                });
            },

            addTorrent: async function(magnet, options = {}) {
                await this.getSessionId();
                const data = {
                    method: 'torrent-add',
                    arguments: {
                        filename: magnet,
                        paused: options.paused || false,
                        labels: options.labels || []
                    }
                };
                return await this.request('/transmission/rpc', data);
            },

            getTorrents: async function() {
                await this.getSessionId();
                const data = {
                    method: 'torrent-get',
                    arguments: {
                        fields: ['id', 'name', 'status', 'percentDone', 'downloadDir', 'files', 'hashString']
                    }
                };
                const response = await this.request('/transmission/rpc', data);
                return response.arguments.torrents || [];
            },

            findTorrent: async function(magnet) {
                const torrents = await this.getTorrents();
                const hash = magnet.match(/btih:([a-fA-F0-9]{40})/i);
                if (hash) {
                    const searchHash = hash[1].toLowerCase();
                    return torrents.find(t => t.hashString && t.hashString.toLowerCase() === searchHash);
                }
                return null;
            },

            startTorrent: async function(id) {
                await this.getSessionId();
                const data = {
                    method: 'torrent-start',
                    arguments: { ids: [id] }
                };
                return await this.request('/transmission/rpc', data);
            }
        };
    }

    // ===== РАБОТА С TORRSERVER =====
    function getTorrServerClient() {
        // Используем встроенный TorrServer плагин если есть
        if (typeof TorrServer !== 'undefined') {
            return TorrServer;
        }

        // Или создаем свой
        return {
            addTorrent: async function(magnet) {
                const config = CONFIG;
                const url = `${config.torrserverUrl}/torrent/add?link=${encodeURIComponent(magnet)}`;
                
                return new Promise((resolve, reject) => {
                    const req = new Lampa.Reguest();
                    req.quiet(url, resolve, reject, null, {
                        type: 'GET',
                        dataType: 'json'
                    });
                });
            },

            getStreamUrl: async function(magnet) {
                const config = CONFIG;
                const addResult = await this.addTorrent(magnet);
                
                if (!addResult || !addResult.hash) {
                    return null;
                }

                const filesUrl = `${config.torrserverUrl}/torrent/files?hash=${addResult.hash}`;
                
                return new Promise((resolve, reject) => {
                    const req = new Lampa.Reguest();
                    req.quiet(filesUrl, resolve, reject, null, {
                        type: 'GET',
                        dataType: 'json'
                    });
                }).then(response => {
                    if (!response || !response.files || response.files.length === 0) {
                        return null;
                    }

                    // Ищем видеофайл
                    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'];
                    let videoFile = response.files.find(f => {
                        const ext = f.name.split('.').pop().toLowerCase();
                        return videoExts.includes(ext);
                    });

                    if (!videoFile) {
                        videoFile = response.files[0];
                    }

                    return `${config.torrserverUrl}/stream/${addResult.hash}/${videoFile.index}`;
                });
            }
        };
    }

    // ===== ОСНОВНОЙ КЛАСС =====
    class TorrentBridge {
        constructor() {
            this.transmission = getTransmissionClient();
            this.torrserver = getTorrServerClient();
            this._init();
        }

        _init() {
            // Добавляем настройки
            this._addSettings();

            // Перехватываем выбор торрента
            this._interceptTorrents();

            // Добавляем кнопку в карточку
            this._addCardButton();

            console.log('[Bridge] Plugin initialized');
        }

        _addSettings() {
            // Регистрируем компонент
            Lampa.SettingsApi.addComponent({
                component: 'torrentbridge',
                name: 'Torrent Bridge',
                icon: '<svg>...</svg>'
            });

            // Настройка локального пути
            Lampa.SettingsApi.addParam({
                component: 'torrentbridge',
                param: {
                    name: 'torrentbridge_local_path',
                    type: 'input',
                    default: 'http://192.168.1.112:8080/'
                },
                field: {
                    name: 'Локальный путь к файлам (для плеера)'
                },
                onChange: (value) => {
                    Lampa.Storage.set('torrentbridge_local_path', value);
                }
            });

            // Режим работы
            Lampa.SettingsApi.addParam({
                component: 'torrentbridge',
                param: {
                    name: 'torrentbridge_mode',
                    type: 'select',
                    default: 'hybrid',
                    values: {
                        hybrid: 'Гибридный (локальный → стрим)',
                        stream: 'Всегда стрим через TorrServer',
                        download: 'Всегда скачивать в Transmission'
                    }
                },
                field: {
                    name: 'Режим работы'
                },
                onChange: (value) => {
                    Lampa.Storage.set('torrentbridge_mode', value);
                }
            });
        }

        _interceptTorrents() {
            // Перехватываем выбор торрента (как в LME TorrentManager)
            Lampa.Listener.follow('torrent', (e) => {
                if (e.type !== 'onlong') return;

                const torrent = e.element;
                const movie = Lampa.Activity.active().movie;

                if (!torrent) return;

                // Добавляем наш пункт в меню
                e.menu.push({
                    title: this._buildButton('🌉 Мост'),
                    onSelect: () => {
                        this._handleTorrent(torrent, movie);
                    }
                });
            });
        }

        _buildButton(label) {
            return `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
                </svg>
                ${label}
            </div>`;
        }

        async _handleTorrent(torrent, movie) {
            const magnet = torrent.MagnetUri || torrent.Link;
            const title = movie?.title || movie?.name || 'Фильм';

            if (!magnet) {
                Lampa.Bell.push({ text: '❌ Нет магнет-ссылки' });
                return;
            }

            const mode = Lampa.Storage.get('torrentbridge_mode') || 'hybrid';

            try {
                if (mode === 'download') {
                    await this._downloadOnly(magnet, title, movie);
                } else if (mode === 'stream') {
                    await this._streamOnly(magnet, title);
                } else {
                    await this._hybridMode(magnet, title, movie);
                }
            } catch (error) {
                console.error('[Bridge] Error:', error);
                Lampa.Bell.push({ text: `❌ ${error.message || 'Ошибка'}` });
            }
        }

        // ===== ГИБРИДНЫЙ РЕЖИМ =====
        async _hybridMode(magnet, title, movie) {
            // 1. Проверяем, есть ли торрент в Transmission
            Lampa.Bell.push({ text: '⏳ Проверка...' });

            let existing = await this.transmission.findTorrent(magnet);

            if (existing) {
                // Торрент уже есть
                const torrents = await this.transmission.getTorrents();
                const full = torrents.find(t => t.id === existing.id);

                if (full && full.percentDone >= 0.99) {
                    // Скачан - играем локально
                    await this._playLocal(full, title);
                    return;
                }

                // Скачивается - предлагаем выбор
                this._showOptions(existing, magnet, title);
                return;
            }

            // 2. Торрента нет - добавляем и стримим
            Lampa.Bell.push({ text: '⏳ Добавление...' });

            const result = await this.transmission.addTorrent(magnet, {
                paused: true,
                labels: movie ? [`movie/${movie.id}`] : []
            });

            if (result.result !== 'success') {
                throw new Error('Не удалось добавить торрент');
            }

            // 3. Стримим через TorrServer
            await this._streamViaTorrServer(magnet, title);

            // 4. Запускаем фоновую загрузку
            const added = result.arguments['torrent-added'];
            if (added && added.id) {
                setTimeout(() => {
                    this.transmission.startTorrent(added.id);
                }, 3000);
            }
        }

        // ===== СТРИМ РЕЖИМ =====
        async _streamOnly(magnet, title) {
            await this._streamViaTorrServer(magnet, title);
        }

        // ===== СКАЧИВАНИЕ РЕЖИМ =====
        async _downloadOnly(magnet, title, movie) {
            Lampa.Bell.push({ text: '⏳ Добавление...' });

            const result = await this.transmission.addTorrent(magnet, {
                paused: false,
                labels: movie ? [`movie/${movie.id}`] : []
            });

            if (result.result === 'success') {
                Lampa.Bell.push({ text: '✅ Торрент в очереди' });
                
                const added = result.arguments['torrent-added'];
                if (added && added.id) {
                    await this._waitForDownload(added.id, title);
                }
            } else {
                throw new Error('Не удалось добавить торрент');
            }
        }

        // ===== ВОСПРОИЗВЕДЕНИЕ ЛОКАЛЬНОГО ФАЙЛА =====
        async _playLocal(torrent, title) {
            const localPath = Lampa.Storage.get('torrentbridge_local_path') || CONFIG.localPath;
            const videoFiles = torrent.files.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'].includes(ext);
            });

            if (videoFiles.length === 0) {
                Lampa.Bell.push({ text: '❌ Нет видеофайлов' });
                return;
            }

            let file = videoFiles[0];
            if (videoFiles.length > 1) {
                file = await this._selectFile(videoFiles);
                if (!file) return;
            }

            const url = localPath + encodeURIComponent(file.name);
            const name = file.name.split('/').pop();

            Lampa.Player.play({
                url: url,
                title: title || name,
                timeline: false
            });

            Lampa.Bell.push({ text: '✅ Локальное воспроизведение' });
        }

        _selectFile(files) {
            return new Promise((resolve) => {
                const items = files.map(f => ({
                    title: f.name.split('/').pop() || f.name,
                    file: f
                }));

                Lampa.Select.show({
                    title: 'Выберите файл',
                    items: items,
                    onSelect: (item) => resolve(item.file)
                });
            });
        }

        // ===== СТРИМИМ ЧЕРЕЗ TORRSERVER =====
        async _streamViaTorrServer(magnet, title) {
            Lampa.Bell.push({ text: '⏳ Получение стрим-ссылки...' });

            const streamUrl = await this.torrserver.getStreamUrl(magnet);

            if (streamUrl) {
                Lampa.Player.play({
                    url: streamUrl,
                    title: title || 'Фильм',
                    timeline: false
                });
                Lampa.Bell.push({ text: '✅ Стрим через TorrServer' });
            } else {
                throw new Error('Не удалось получить стрим-ссылку');
            }
        }

        // ===== ПОКАЗ ВАРИАНТОВ =====
        _showOptions(torrent, magnet, title) {
            const percent = Math.round(torrent.percentDone * 100);
            const items = [
                {
                    title: '▶️ Стримить через TorrServer',
                    action: 'stream'
                },
                {
                    title: `⏳ Дождаться скачивания (${percent}%)`,
                    action: 'wait'
                }
            ];

            Lampa.Select.show({
                title: `Торрент уже в очереди`,
                items: items,
                onSelect: async (item) => {
                    if (item.action === 'stream') {
                        await this._streamViaTorrServer(magnet, title);
                    } else if (item.action === 'wait') {
                        await this._waitForDownload(torrent.id, title);
                    }
                }
            });
        }

        // ===== ОЖИДАНИЕ СКАЧИВАНИЯ =====
        async _waitForDownload(torrentId, title) {
            Lampa.Bell.push({ text: '⏳ Ожидание...' });

            let attempts = 0;
            const maxAttempts = 120; // 10 минут

            const check = async () => {
                attempts++;
                const torrents = await this.transmission.getTorrents();
                const torrent = torrents.find(t => t.id === torrentId);

                if (!torrent) {
                    Lampa.Bell.push({ text: '❌ Торрент не найден' });
                    return;
                }

                if (torrent.percentDone >= 0.99) {
                    await this._playLocal(torrent, title);
                    return;
                }

                if (attempts >= maxAttempts) {
                    Lampa.Bell.push({ text: '⏱ Превышено время ожидания' });
                    return;
                }

                setTimeout(check, 5000);
            };

            await check();
        }

        // ===== КНОПКА В КАРТОЧКЕ =====
        _addCardButton() {
            Lampa.Listener.follow('full', (e) => {
                if (e.type === 'complite') {
                    setTimeout(() => {
                        this._injectCardButton(e.object);
                    }, 500);
                }
            });
        }

        _injectCardButton(movieData) {
            const container = movieData.activity.render().find('.full-start-new__buttons');
            if (!container.length) return;

            container.find('.button--torrentbridge').remove();

            const button = $(`
                <div class="full-start__button selector button--torrentbridge" style="display:flex;align-items:center;gap:8px;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
                    </svg>
                    <span>🌉 Мост</span>
                </div>
            `);

            button.on('hover:enter', () => {
                Lampa.Bell.push({ text: 'ℹ️ Выберите торрент и нажмите "🌉 Мост"' });
            });

            container.append(button);
        }
    }

    // ===== ЗАПУСК =====
    function init() {
        if (window.appready) {
            if (!window.torrentbridge_loaded) {
                window.torrentbridge_loaded = true;
                new TorrentBridge();
            }
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready' && !window.torrentbridge_loaded) {
                    window.torrentbridge_loaded = true;
                    new TorrentBridge();
                }
            });
        }
    }

    init();

})();
