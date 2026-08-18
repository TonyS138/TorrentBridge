// =====================================================
// Torrent Bridge Plugin - ИСПРАВЛЕННАЯ ВЕРСИЯ 2.0
// Версия: 1.2
// =====================================================

(function() {
    'use strict';

    const PLUGIN_NAME = 'Torrent Bridge';
    const PLUGIN_VERSION = '1.2';
    const COMPONENT_NAME = 'torrentbridge';

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

            console.log('[Bridge] Plugin initialized v' + PLUGIN_VERSION);
        }

        _addSettings() {
            // Регистрируем компонент в настройках
            Lampa.SettingsApi.addComponent({
                component: COMPONENT_NAME,
                name: 'Torrent Bridge',
                icon: '<svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>'
            });

            // Настройка локального пути
            Lampa.SettingsApi.addParam({
                component: COMPONENT_NAME,
                param: {
                    name: 'local_path',
                    type: 'input',
                    default: 'http://192.168.1.112:8080/'
                },
                field: {
                    name: 'Локальный путь к файлам (для плеера)',
                    placeholder: 'http://192.168.1.112:8080/'
                },
                onChange: function(value) {
                    Lampa.Storage.set('torrentbridge_local_path', value);
                }
            });

            // Режим работы
            Lampa.SettingsApi.addParam({
                component: COMPONENT_NAME,
                param: {
                    name: 'mode',
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
                onChange: function(value) {
                    Lampa.Storage.set('torrentbridge_mode', value);
                }
            });

            // Кнопка для теста подключения
            Lampa.SettingsApi.addParam({
                component: COMPONENT_NAME,
                param: {
                    name: 'test_connection',
                    type: 'button'
                },
                field: {
                    name: 'Проверить подключение'
                },
                onChange: function() {
                    TorrentBridge.testConnection();
                }
            });
        }

        _interceptTorrents() {
            // Перехватываем выбор торрента
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

        // ===== ОБРАБОТКА ТОРРЕНТА =====
        async _handleTorrent(torrent, movie) {
            const magnet = torrent.MagnetUri || torrent.Link;
            const title = movie?.title || movie?.name || 'Фильм';

            if (!magnet) {
                Lampa.Bell.push({ text: '❌ Нет магнет-ссылки' });
                return;
            }

            const mode = Lampa.Storage.get('torrentbridge_mode') || 'hybrid';

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
            // Проверяем, есть ли торрент в Transmission
            const exists = await this._checkTorrentExists(magnet);
            
            if (exists) {
                // Торрент уже есть - проверяем статус
                const torrents = await this._getTorrents();
                const torrent = torrents.find(t => t.hashString && magnet.includes(t.hashString.toLowerCase()));
                
                if (torrent && torrent.percentDone >= 0.99) {
                    // Скачан - играем локально
                    await this._playLocal(torrent, title);
                    return;
                }
                
                // Скачивается - предлагаем выбор
                this._showOptions(torrent, magnet, title);
                return;
            }

            // Торрента нет - добавляем и стримим
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
            // Используем Transmission из LME TorrentManager если доступен
            if (typeof Transmission !== 'undefined' && Transmission.getTorrents) {
                try {
                    return await Transmission.getTorrents();
                } catch (e) {
                    console.error('[Bridge] Transmission.getTorrents error:', e);
                }
            }

            // Собственная реализация через прямой запрос
            try {
                const config = this._getConfig();
                const url = `${config.transmissionUrl}/transmission/rpc`;
                const headers = {
                    'Authorization': 'Basic ' + btoa(`${config.transmissionUser}:${config.transmissionPass}`),
                    'Content-Type': 'application/json'
                };

                // Получаем Session ID
                let sessionId = Lampa.Storage.get('torrentbridge_session_id');
                if (sessionId) {
                    headers['X-Transmission-Session-Id'] = sessionId;
                }

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

        // ===== ДОБАВЛЕНИЕ В TRANSMISSION =====
        async _addToTransmission(magnet, title, movie) {
            try {
                const config = this._getConfig();
                const url = `${config.transmissionUrl}/transmission/rpc`;
                const headers = {
                    'Authorization': 'Basic ' + btoa(`${config.transmissionUser}:${config.transmissionPass}`),
                    'Content-Type': 'application/json'
                };

                // Получаем Session ID
                let sessionId = Lampa.Storage.get('torrentbridge_session_id');
                if (sessionId) {
                    headers['X-Transmission-Session-Id'] = sessionId;
                }

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
                    Lampa.Bell.push({ text: '✅ Торрент добавлен в Transmission' });
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
            // Добавляем в Transmission
            const result = await this._addToTransmission(magnet, title, movie);
            
            if (result && result.result === 'success') {
                // Стримим через TorrServer
                await this._streamViaTorrServer(magnet, title);
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
                    throw new Error('Не удалось добавить в TorrServer');
                }

                // Получаем список файлов
                const filesUrl = `${torrserverUrl}/torrent/files?hash=${addResponse.hash}`;
                const filesResponse = await this._request(filesUrl, {}, null, 'GET');
                
                if (!filesResponse || !filesResponse.files || filesResponse.files.length === 0) {
                    throw new Error('Нет файлов в TorrServer');
                }

                // Ищем видеофайл
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
                
                Lampa.Bell.push({ text: '✅ Стрим через TorrServer' });
            } catch (e) {
                console.error('[Bridge] TorrServer error:', e);
                throw new Error('Не удалось получить стрим-ссылку');
            }
        }

        // ===== ВОСПРОИЗВЕДЕНИЕ ЛОКАЛЬНОГО ФАЙЛА =====
        async _playLocal(torrent, title) {
            const localPath = Lampa.Storage.get('torrentbridge_local_path') || 'http://192.168.1.112:8080/';
            
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
                        this._waitForDownload(torrent, title);
                    }
                }
            });
        }

        // ===== ОЖИДАНИЕ СКАЧИВАНИЯ =====
        async _waitForDownload(torrent, title) {
            Lampa.Bell.push({ text: '⏳ Ожидание скачивания...' });

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
                    Lampa.Bell.push({ text: '⏱ Превышено время ожидания' });
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

        // ===== ТЕСТ ПОДКЛЮЧЕНИЯ =====
        static async testConnection() {
            try {
                Lampa.Bell.push({ text: '⏳ Проверка...' });
                
                // Проверяем Transmission
                const plugin = new TorrentBridge();
                const torrents = await plugin._getTorrents();
                
                if (torrents && torrents.length >= 0) {
                    Lampa.Bell.push({ text: '✅ Transmission: OK (' + torrents.length + ' торрентов)' });
                } else {
                    Lampa.Bell.push({ text: '⚠️ Transmission: нет данных' });
                }
            } catch (e) {
                Lampa.Bell.push({ text: '❌ Ошибка: ' + (e.message || 'неизвестная') });
            }
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
