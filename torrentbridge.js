// =====================================================
// Torrent Bridge Plugin - ФИНАЛЬНАЯ ВЕРСИЯ
// Версия: 1.3
// =====================================================

(function() {
    'use strict';

    const COMPONENT = 'torrentbridge';

    // ===== ОСНОВНОЙ КЛАСС =====
    class TorrentBridge {
        constructor() {
            this._init();
        }

        _init() {
            // Добавляем настройки
            this._addSettings();

            // Перехватываем выбор торрента
            this._interceptTorrents();

            console.log('[Bridge] Plugin initialized');
        }

        _addSettings() {
            // Регистрируем компонент
            Lampa.SettingsApi.addComponent({
                component: COMPONENT,
                name: 'Torrent Bridge',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>'
            });

            // Настройка локального пути - используем полное имя как в LME TorrentManager
            Lampa.SettingsApi.addParam({
                component: COMPONENT,
                param: {
                    name: COMPONENT + 'LocalPath',
                    type: 'input',
                    default: ''
                },
                field: {
                    name: 'Локальный путь к файлам'
                },
                onChange: function(value) {
                    Lampa.Storage.set(COMPONENT + 'LocalPath', value);
                }
            });

            // Режим работы
            Lampa.SettingsApi.addParam({
                component: COMPONENT,
                param: {
                    name: COMPONENT + 'Mode',
                    type: 'select',
                    default: 'hybrid',
                    values: {
                        hybrid: 'Гибридный',
                        stream: 'Только стрим',
                        download: 'Только скачивание'
                    }
                },
                field: {
                    name: 'Режим работы'
                },
                onChange: function(value) {
                    Lampa.Storage.set(COMPONENT + 'Mode', value);
                }
            });
        }

        _interceptTorrents() {
            Lampa.Listener.follow('torrent', (e) => {
                if (e.type !== 'onlong') return;

                const torrent = e.element;
                const movie = Lampa.Activity.active().movie;

                if (!torrent) return;

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

            const mode = Lampa.Storage.get(COMPONENT + 'Mode') || 'hybrid';

            try {
                Lampa.Bell.push({ text: '⏳ Обработка...' });

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
            // Проверяем через Transmission
            const exists = await this._checkTorrentExists(magnet);
            
            if (exists) {
                const torrents = await this._getTorrents();
                const torrent = torrents.find(t => t.hashString && magnet.includes(t.hashString.toLowerCase()));
                
                if (torrent && torrent.percentDone >= 0.99) {
                    await this._playLocal(torrent, title);
                    return;
                }
                
                this._showOptions(torrent, magnet, title);
                return;
            }

            await this._addAndStream(magnet, title, movie);
        }

        // ===== СТРИМ РЕЖИМ =====
        async _streamOnly(magnet, title) {
            await this._streamViaTorrServer(magnet, title);
        }

        // ===== СКАЧИВАНИЕ РЕЖИМ =====
        async _downloadOnly(magnet, title, movie) {
            await this._addToTransmission(magnet, title, movie);
        }

        // ===== ПРОВЕРКА СУЩЕСТВОВАНИЯ ТОРРЕНТА =====
        async _checkTorrentExists(magnet) {
            try {
                const torrents = await this._getTorrents();
                const hash = magnet.match(/btih:([a-fA-F0-9]{40})/i);
                if (hash) {
                    const searchHash = hash[1].toLowerCase();
                    return torrents.some(t => t.hashString && t.hashString.toLowerCase() === searchHash);
                }
                return false;
            } catch (e) {
                return false;
            }
        }

        // ===== ПОЛУЧЕНИЕ СПИСКА ТОРРЕНТОВ =====
        async _getTorrents() {
            // Используем Transmission из LME TorrentManager
            if (typeof Transmission !== 'undefined' && Transmission.getTorrents) {
                try {
                    return await Transmission.getTorrents();
                } catch (e) {
                    console.error('[Bridge] Transmission.getTorrents error:', e);
                }
            }

            // Собственная реализация
            try {
                const config = this._getConfig();
                const url = `${config.transmissionUrl}/transmission/rpc`;
                const headers = this._getHeaders(config);

                const data = {
                    method: 'torrent-get',
                    arguments: {
                        fields: ['id', 'name', 'hashString', 'percentDone', 'files', 'downloadDir']
                    }
                };

                const response = await this._request(url, headers, data);
                
                if (response && response.arguments && response.arguments.torrents) {
                    return response.arguments.torrents;
                }
                return [];
            } catch (e) {
                console.error('[Bridge] Error getting torrents:', e);
                return [];
            }
        }

        // ===== ЗАГОЛОВКИ ДЛЯ ЗАПРОСА =====
        _getHeaders(config) {
            const headers = {
                'Authorization': 'Basic ' + btoa(`${config.transmissionUser}:${config.transmissionPass}`),
                'Content-Type': 'application/json'
            };

            const sessionId = Lampa.Storage.get('torrentbridge_session_id');
            if (sessionId) {
                headers['X-Transmission-Session-Id'] = sessionId;
            }

            return headers;
        }

        // ===== ДОБАВЛЕНИЕ В TRANSMISSION =====
        async _addToTransmission(magnet, title, movie) {
            try {
                const config = this._getConfig();
                const url = `${config.transmissionUrl}/transmission/rpc`;
                const headers = this._getHeaders(config);

                const data = {
                    method: 'torrent-add',
                    arguments: {
                        filename: magnet,
                        paused: false,
                        labels: movie ? [`movie/${movie.id}`] : []
                    }
                };

                const response = await this._request(url, headers, data);
                
                if (response && response.result === 'success') {
                    Lampa.Bell.push({ text: '✅ Торрент добавлен' });
                    
                    // Сохраняем Session ID если он пришел
                    if (response.session_id) {
                        Lampa.Storage.set('torrentbridge_session_id', response.session_id);
                    }
                    
                    return response;
                } else {
                    throw new Error('Не удалось добавить торрент');
                }
            } catch (e) {
                console.error('[Bridge] Error adding torrent:', e);
                throw e;
            }
        }

        // ===== ДОБАВЛЕНИЕ И СТРИМ =====
        async _addAndStream(magnet, title, movie) {
            const result = await this._addToTransmission(magnet, title, movie);
            
            if (result && result.result === 'success') {
                setTimeout(() => {
                    this._streamViaTorrServer(magnet, title);
                }, 1000);
            }
        }

        // ===== СТРИМ ЧЕРЕЗ TORRSERVER =====
        async _streamViaTorrServer(magnet, title) {
            try {
                const config = this._getConfig();
                const torrserverUrl = config.torrserverUrl;
                
                // Добавляем в TorrServer
                const addUrl = `${torrserverUrl}/torrent/add?link=${encodeURIComponent(magnet)}`;
                const addResponse = await this._request(addUrl, {}, null, 'GET');
                
                if (!addResponse || !addResponse.hash) {
                    throw new Error('Ошибка TorrServer');
                }

                // Получаем список файлов
                const filesUrl = `${torrserverUrl}/torrent/files?hash=${addResponse.hash}`;
                const filesResponse = await this._request(filesUrl, {}, null, 'GET');
                
                if (!filesResponse || !filesResponse.files || filesResponse.files.length === 0) {
                    throw new Error('Нет файлов');
                }

                // Ищем видео
                const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'];
                let videoFile = filesResponse.files.find(f => {
                    const ext = f.name.split('.').pop().toLowerCase();
                    return videoExts.includes(ext);
                });

                if (!videoFile) {
                    videoFile = filesResponse.files[0];
                }

                const streamUrl = `${torrserverUrl}/stream/${addResponse.hash}/${videoFile.index}`;
                
                Lampa.Player.play({
                    url: streamUrl,
                    title: title || 'Фильм',
                    timeline: false
                });
                
                Lampa.Bell.push({ text: '✅ Стрим' });
            } catch (e) {
                console.error('[Bridge] TorrServer error:', e);
                Lampa.Bell.push({ text: '❌ Ошибка стрима' });
            }
        }

        // ===== ВОСПРОИЗВЕДЕНИЕ ЛОКАЛЬНОГО ФАЙЛА =====
        async _playLocal(torrent, title) {
            const localPath = Lampa.Storage.get(COMPONENT + 'LocalPath') || '';
            
            if (!localPath) {
                Lampa.Bell.push({ text: '⚠️ Укажите локальный путь в настройках' });
                return;
            }

            const videoFiles = torrent.files.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'].includes(ext);
            });

            if (videoFiles.length === 0) {
                Lampa.Bell.push({ text: '❌ Нет видео' });
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

            Lampa.Bell.push({ text: '✅ Локально' });
        }

        // ===== ВЫБОР ФАЙЛА =====
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

        // ===== ПОКАЗ ВАРИАНТОВ =====
        _showOptions(torrent, magnet, title) {
            const percent = Math.round(torrent.percentDone * 100);
            const items = [
                {
                    title: '▶️ Стримить',
                    action: 'stream'
                },
                {
                    title: `⏳ Дождаться (${percent}%)`,
                    action: 'wait'
                }
            ];

            Lampa.Select.show({
                title: `Торрент в очереди`,
                items: items,
                onSelect: async (item) => {
                    if (item.action === 'stream') {
                        await this._streamViaTorrServer(magnet, title);
                    } else if (item.action === 'wait') {
                        this._waitForDownload(torrent, title);
                    }
                }
            });
        }

        // ===== ОЖИДАНИЕ СКАЧИВАНИЯ =====
        async _waitForDownload(torrent, title) {
            Lampa.Bell.push({ text: '⏳ Ожидание...' });

            let attempts = 0;
            const maxAttempts = 120;

            const check = async () => {
                attempts++;
                const torrents = await this._getTorrents();
                const current = torrents.find(t => t.id === torrent.id);

                if (!current) {
                    Lampa.Bell.push({ text: '❌ Торрент не найден' });
                    return;
                }

                if (current.percentDone >= 0.99) {
                    await this._playLocal(current, title);
                    return;
                }

                if (attempts >= maxAttempts) {
                    Lampa.Bell.push({ text: '⏱ Время вышло' });
                    return;
                }

                setTimeout(check, 5000);
            };

            await check();
        }

        // ===== УНИВЕРСАЛЬНЫЙ ЗАПРОС =====
        _request(url, headers, data, method = 'POST') {
            return new Promise((resolve, reject) => {
                const req = new Lampa.Reguest();
                const options = {
                    headers: headers || {},
                    type: method,
                    dataType: 'json'
                };

                req.quiet(url, resolve, reject, data ? JSON.stringify(data) : null, options);
            });
        }

        // ===== ПОЛУЧЕНИЕ КОНФИГА =====
        _getConfig() {
            return {
                transmissionUrl: Lampa.Storage.get('lmetorrenttransmissionUrl') || 'http://192.168.1.101:9091',
                transmissionUser: Lampa.Storage.get('lmetorrenttransmissionUser') || 'admin',
                transmissionPass: Lampa.Storage.get('lmetorrenttransmissionPass') || 'admin',
                torrserverUrl: Lampa.Storage.get('torrserver_url') || 'http://192.168.1.101:8090'
            };
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
