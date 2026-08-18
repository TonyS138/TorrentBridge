// =====================================================
// TorrentBridge Plugin for Lampa
// Основан на коде LME TorrentManager
// Версия: 2.0
// =====================================================

(function() {
    'use strict';

    // ===== КОНФИГУРАЦИЯ =====
    const PLUGIN_NAME = 'TorrentBridge';
    const PLUGIN_COMPONENT = 'torrentbridge';
    const CONFIG_PREFIX = 'torrentbridge_';

    // ===== ЗАГРУЗКА НАСТРОЕК ИЗ STORAGE =====
    function getConfig() {
        return {
            // Transmission
            transmissionUrl: Lampa.Storage.get(`${CONFIG_PREFIX}transmission_url`) || 'http://192.168.1.101:9091',
            transmissionUser: Lampa.Storage.get(`${CONFIG_PREFIX}transmission_user`) || 'admin',
            transmissionPass: Lampa.Storage.get(`${CONFIG_PREFIX}transmission_pass`) || 'admin',
            
            // TorrServer
            torrserverUrl: Lampa.Storage.get(`${CONFIG_PREFIX}torrserver_url`) || 'http://192.168.1.101:8090',
            
            // Локальный путь для плеера
            localPath: Lampa.Storage.get(`${CONFIG_PREFIX}local_path`) || 'http://192.168.1.101:8080/',
            
            // Режим работы
            mode: Lampa.Storage.get(`${CONFIG_PREFIX}mode`) || 'hybrid' // hybrid | stream | download
        };
    }

    // ===== РАБОТА С TRANSMISSION (из кода LME TorrentManager) =====
    const TransmissionClient = {
        sessionId: null,
        sessionKey: `${CONFIG_PREFIX}transmission_session`,

        // Получение Session ID
        getSessionId: async function() {
            if (this.sessionId) {
                return this.sessionId;
            }

            // Восстанавливаем из Storage
            this.sessionId = Lampa.Storage.get(this.sessionKey);
            if (this.sessionId) {
                return this.sessionId;
            }

            const config = getConfig();
            
            try {
                const response = await this._request('POST', '/transmission/rpc', {
                    method: 'session-get'
                });

                if (response.status === 409) {
                    this.sessionId = response.headers.get('X-Transmission-Session-Id');
                    Lampa.Storage.set(this.sessionKey, this.sessionId);
                    return this.sessionId;
                }

                return null;
            } catch (error) {
                console.error('[TorrentBridge] getSessionId error:', error);
                return null;
            }
        },

        // Запрос к Transmission
        _request: async function(method, path, data) {
            const config = getConfig();
            const url = `${config.transmissionUrl}${path}`;
            
            const headers = {
                'Authorization': 'Basic ' + btoa(`${config.transmissionUser}:${config.transmissionPass}`),
                'Content-Type': 'application/json'
            };

            if (this.sessionId) {
                headers['X-Transmission-Session-Id'] = this.sessionId;
            }

            const options = {
                method: method,
                headers: headers,
                body: data ? JSON.stringify(data) : undefined
            };

            // Используем Lampa.Reguest для совместимости
            return new Promise((resolve, reject) => {
                const request = new Lampa.Reguest();
                request.quiet(url, resolve, reject, options.body, {
                    headers: headers,
                    type: 'POST',
                    dataType: 'json'
                });
            });
        },

        // Добавление торрента
        addTorrent: async function(magnet, options = {}) {
            await this.getSessionId();

            const config = getConfig();
            const data = {
                method: 'torrent-add',
                arguments: {
                    filename: magnet,
                    'download-dir': options.downloadDir || '/sdcard/Download/Torrents/',
                    paused: options.paused || false,
                    labels: options.labels || []
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response;
            } catch (error) {
                console.error('[TorrentBridge] addTorrent error:', error);
                throw error;
            }
        },

        // Получение списка торрентов
        getTorrents: async function() {
            await this.getSessionId();

            const data = {
                method: 'torrent-get',
                arguments: {
                    fields: ['id', 'name', 'status', 'percentDone', 'downloadDir', 'files', 'labels', 'hashString']
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response.arguments.torrents;
            } catch (error) {
                console.error('[TorrentBridge] getTorrents error:', error);
                return [];
            }
        },

        // Поиск торрента по имени или хешу
        findTorrent: async function(query) {
            const torrents = await this.getTorrents();
            
            // Поиск по хешу (из магнет-ссылки)
            const hashMatch = query.match(/btih:([a-fA-F0-9]{40})/i);
            if (hashMatch) {
                const hash = hashMatch[1].toLowerCase();
                return torrents.find(t => 
                    t.hashString && t.hashString.toLowerCase() === hash
                );
            }

            // Поиск по имени
            return torrents.find(t => 
                t.name && t.name.toLowerCase().includes(query.toLowerCase())
            );
        },

        // Получение файлов торрента
        getTorrentFiles: async function(torrentId) {
            await this.getSessionId();

            const data = {
                method: 'torrent-get',
                arguments: {
                    ids: [torrentId],
                    fields: ['id', 'name', 'files', 'downloadDir', 'percentDone']
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response.arguments.torrents[0];
            } catch (error) {
                console.error('[TorrentBridge] getTorrentFiles error:', error);
                return null;
            }
        },

        // Запуск скачивания
        startTorrent: async function(torrentId) {
            await this.getSessionId();

            const data = {
                method: 'torrent-start',
                arguments: {
                    ids: [torrentId]
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response;
            } catch (error) {
                console.error('[TorrentBridge] startTorrent error:', error);
                throw error;
            }
        },

        // Остановка
        stopTorrent: async function(torrentId) {
            await this.getSessionId();

            const data = {
                method: 'torrent-stop',
                arguments: {
                    ids: [torrentId]
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response;
            } catch (error) {
                console.error('[TorrentBridge] stopTorrent error:', error);
                throw error;
            }
        },

        // Удаление
        removeTorrent: async function(torrentId, deleteData = false) {
            await this.getSessionId();

            const data = {
                method: 'torrent-remove',
                arguments: {
                    ids: [torrentId],
                    'delete-local-data': deleteData
                }
            };

            try {
                const response = await this._request('POST', '/transmission/rpc', data);
                return response;
            } catch (error) {
                console.error('[TorrentBridge] removeTorrent error:', error);
                throw error;
            }
        }
    };

    // ===== РАБОТА С TORRSERVER =====
    const TorrServerClient = {
        // Добавление торрента в TorrServer
        addTorrent: async function(magnet) {
            const config = getConfig();
            const url = `${config.torrserverUrl}/torrent/add?link=${encodeURIComponent(magnet)}`;

            try {
                const response = await new Promise((resolve, reject) => {
                    const request = new Lampa.Reguest();
                    request.quiet(url, resolve, reject, null, {
                        type: 'GET',
                        dataType: 'json'
                    });
                });

                return response;
            } catch (error) {
                console.error('[TorrentBridge] TorrServer addTorrent error:', error);
                return null;
            }
        },

        // Получение стрим-ссылки
        getStreamUrl: async function(magnet) {
            const config = getConfig();
            
            // Добавляем торрент в TorrServer
            const addResult = await this.addTorrent(magnet);
            if (!addResult || !addResult.hash) {
                return null;
            }

            // Получаем список файлов
            const filesUrl = `${config.torrserverUrl}/torrent/files?hash=${addResult.hash}`;
            
            try {
                const filesResponse = await new Promise((resolve, reject) => {
                    const request = new Lampa.Reguest();
                    request.quiet(filesUrl, resolve, reject, null, {
                        type: 'GET',
                        dataType: 'json'
                    });
                });

                if (!filesResponse || !filesResponse.files || filesResponse.files.length === 0) {
                    return null;
                }

                // Ищем видеофайл
                const videoExtensions = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'];
                let videoFile = filesResponse.files.find(f => {
                    const ext = f.name.split('.').pop().toLowerCase();
                    return videoExtensions.includes(ext);
                });

                if (!videoFile) {
                    videoFile = filesResponse.files[0];
                }

                // Стрим-ссылка
                return `${config.torrserverUrl}/stream/${addResult.hash}/${videoFile.index}`;
            } catch (error) {
                console.error('[TorrentBridge] TorrServer getStreamUrl error:', error);
                return null;
            }
        }
    };

    // ===== ОСНОВНОЙ КЛАСС ПЛАГИНА =====
    class TorrentBridgePlugin {
        constructor() {
            this.name = PLUGIN_NAME;
            this.component = PLUGIN_COMPONENT;
            
            this._init();
        }

        _init() {
            // 1. Регистрируем настройки
            this._registerSettings();

            // 2. Добавляем кнопку в меню
            this._addMenuButton();

            // 3. Перехватываем выбор торрента
            this._interceptTorrentSelection();

            // 4. Добавляем кнопку в карточку фильма
            this._addCardButton();

            console.log('[TorrentBridge] Plugin initialized');
        }

        // ===== НАСТРОЙКИ =====
        _registerSettings() {
            Lampa.SettingsApi.addComponent({
                component: this.component,
                name: 'Torrent Bridge',
                icon: '<svg>...</svg>'
            });

            // Transmission URL
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}transmission_url`,
                    type: 'input',
                    default: 'http://192.168.1.101:9091'
                },
                field: {
                    name: 'Transmission URL'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}transmission_url`, value);
                }
            });

            // Transmission Login
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}transmission_user`,
                    type: 'input',
                    default: 'admin'
                },
                field: {
                    name: 'Transmission Login'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}transmission_user`, value);
                }
            });

            // Transmission Password
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}transmission_pass`,
                    type: 'input',
                    default: 'admin',
                    password: true
                },
                field: {
                    name: 'Transmission Password'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}transmission_pass`, value);
                }
            });

            // TorrServer URL
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}torrserver_url`,
                    type: 'input',
                    default: 'http://192.168.1.101:8090'
                },
                field: {
                    name: 'TorrServer URL'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}torrserver_url`, value);
                }
            });

            // Локальный путь
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}local_path`,
                    type: 'input',
                    default: 'http://192.168.1.101:8080/'
                },
                field: {
                    name: 'Локальный путь к файлам (для плеера)'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}local_path`, value);
                }
            });

            // Режим работы
            Lampa.SettingsApi.addParam({
                component: this.component,
                param: {
                    name: `${CONFIG_PREFIX}mode`,
                    type: 'select',
                    default: 'hybrid',
                    values: {
                        hybrid: 'Гибридный (сначала локальный, потом стрим)',
                        stream: 'Всегда стримить через TorrServer',
                        download: 'Всегда скачивать в Transmission'
                    }
                },
                field: {
                    name: 'Режим работы'
                },
                onChange: (value) => {
                    Lampa.Storage.set(`${CONFIG_PREFIX}mode`, value);
                }
            });
        }

        // ===== КНОПКА В МЕНЮ =====
        _addMenuButton() {
            Lampa.Menu.addButton(
                '<svg>...</svg>',
                'Torrent Bridge',
                () => {
                    Lampa.Activity.push({
                        url: '',
                        title: 'Torrent Bridge',
                        component: this.component,
                        page: 1
                    });
                }
            );
        }

        // ===== ПЕРЕХВАТ ВЫБОРА ТОРРЕНТА =====
        _interceptTorrentSelection() {
            // Используем ту же механику, что и в LME TorrentManager
            Lampa.Listener.follow('torrent', async (e) => {
                if (e.type !== 'onlong') {
                    return;
                }

                const selectedTorrent = e.element;
                const movie = Lampa.Activity.active().movie;

                if (!selectedTorrent || !movie) {
                    return;
                }

                // Добавляем наш пункт в меню
                e.menu.push({
                    title: this._buildButtonTitle('⚡ Bridge'),
                    onSelect: () => {
                        this._handleTorrentSelect(selectedTorrent, movie);
                    }
                });
            });
        }

        _buildButtonTitle(label) {
            return `<div class="btnTDdownload wait" style="display:flex;align-items:center;gap:8px;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
                </svg>
                ${label}
            </div>`;
        }

        // ===== ОБРАБОТКА ВЫБОРА ТОРРЕНТА =====
        async _handleTorrentSelect(torrent, movie) {
            try {
                const config = getConfig();
                const magnet = torrent.MagnetUri || torrent.Link;
                const title = movie.title || movie.name || 'Фильм';

                if (!magnet) {
                    Lampa.Bell.push({ text: '❌ Нет магнет-ссылки' });
                    return;
                }

                Lampa.Bell.push({ text: '⏳ Проверка...' });

                // 1. Проверяем, есть ли торрент в Transmission
                let existingTorrent = await TransmissionClient.findTorrent(magnet);

                if (existingTorrent) {
                    // Торрент уже есть
                    const files = await TransmissionClient.getTorrentFiles(existingTorrent.id);
                    
                    if (files && files.percentDone >= 0.99) {
                        // Торрент скачан - воспроизводим локально
                        await this._playLocal(files, title);
                        return;
                    } else if (config.mode === 'hybrid' || config.mode === 'stream') {
                        // Торрент скачивается - предлагаем выбор или стримим
                        this._showDownloadOptions(existingTorrent, magnet, title);
                        return;
                    }
                }

                // 2. Торрента нет - добавляем
                if (config.mode === 'download') {
                    // Только скачивание
                    await this._addAndDownload(magnet, title, movie);
                    return;
                }

                // 3. Гибридный режим или стрим
                await this._addAndStream(magnet, title, movie);

            } catch (error) {
                console.error('[TorrentBridge] Error:', error);
                Lampa.Bell.push({ text: `❌ Ошибка: ${error.message || 'Неизвестная ошибка'}` });
            }
        }

        // ===== ВОСПРОИЗВЕДЕНИЕ ЛОКАЛЬНОГО ФАЙЛА =====
        async _playLocal(torrentFiles, title) {
            const config = getConfig();
            const videoFiles = torrentFiles.files.filter(f => {
                const ext = f.name.split('.').pop().toLowerCase();
                return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'].includes(ext);
            });

            if (videoFiles.length === 0) {
                Lampa.Bell.push({ text: '❌ Видеофайлы не найдены' });
                return;
            }

            let file = videoFiles[0];
            if (videoFiles.length > 1) {
                // Показываем выбор
                file = await this._selectFile(videoFiles);
                if (!file) return;
            }

            // Формируем локальный URL
            const localUrl = config.localPath + encodeURIComponent(file.name);
            const fileName = file.name.split('/').pop();

            // Воспроизводим
            Lampa.Player.play({
                url: localUrl,
                title: title || fileName,
                timeline: false
            });

            Lampa.Bell.push({ text: '✅ Воспроизведение из локальной сети' });
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

        // ===== ПОКАЗ ВАРИАНТОВ ДЛЯ СКАЧИВАЮЩЕГОСЯ ТОРРЕНТА =====
        _showDownloadOptions(torrent, magnet, title) {
            const items = [
                {
                    title: '▶️ Стримить через TorrServer (мгновенно)',
                    action: 'stream'
                },
                {
                    title: `⏳ Дождаться скачивания (${Math.round(torrent.percentDone * 100)}%)`,
                    action: 'wait'
                }
            ];

            if (torrent.percentDone < 0.99) {
                items.push({
                    title: '⏹ Отменить и скачать заново',
                    action: 'restart'
                });
            }

            Lampa.Select.show({
                title: `Торрент уже в очереди`,
                items: items,
                onSelect: async (item) => {
                    if (item.action === 'stream') {
                        await this._streamViaTorrServer(magnet, title);
                    } else if (item.action === 'wait') {
                        await this._waitForDownload(torrent.id, title);
                    } else if (item.action === 'restart') {
                        await TransmissionClient.removeTorrent(torrent.id, true);
                        await this._addAndStream(magnet, title, null);
                    }
                }
            });
        }

        // ===== СТРИМИМ ЧЕРЕЗ TORRSERVER =====
        async _streamViaTorrServer(magnet, title) {
            Lampa.Bell.push({ text: '⏳ Получение стрим-ссылки...' });

            const streamUrl = await TorrServerClient.getStreamUrl(magnet);
            
            if (streamUrl) {
                Lampa.Player.play({
                    url: streamUrl,
                    title: title || 'Фильм',
                    timeline: false
                });
                Lampa.Bell.push({ text: '✅ Воспроизведение через TorrServer' });
            } else {
                Lampa.Bell.push({ text: '❌ Не удалось получить стрим-ссылку' });
            }
        }

        // ===== ДОБАВЛЯЕМ И СТРИМИМ =====
        async _addAndStream(magnet, title, movie) {
            Lampa.Bell.push({ text: '⏳ Добавление в Transmission...' });

            // Добавляем в паузе
            const result = await TransmissionClient.addTorrent(magnet, {
                paused: true,
                labels: movie ? [`movie/${movie.id}`] : []
            });

            if (!result || result.result !== 'success') {
                Lampa.Bell.push({ text: '❌ Ошибка добавления в Transmission' });
                return;
            }

            // Воспроизводим через TorrServer
            await this._streamViaTorrServer(magnet, title);

            // Запускаем фоновую загрузку
            const torrentId = result.arguments['torrent-added']?.id || result.arguments['torrent-duplicate']?.id;
            if (torrentId) {
                setTimeout(() => {
                    TransmissionClient.startTorrent(torrentId);
                }, 3000);
            }
        }

        // ===== ТОЛЬКО СКАЧИВАНИЕ =====
        async _addAndDownload(magnet, title, movie) {
            Lampa.Bell.push({ text: '⏳ Добавление в Transmission...' });

            const result = await TransmissionClient.addTorrent(magnet, {
                paused: false,
                labels: movie ? [`movie/${movie.id}`] : []
            });

            if (result && result.result === 'success') {
                Lampa.Bell.push({ text: '✅ Торрент добавлен в очередь' });
                const torrentId = result.arguments['torrent-added']?.id;
                if (torrentId) {
                    await this._waitForDownload(torrentId, title);
                }
            } else {
                Lampa.Bell.push({ text: '❌ Ошибка добавления' });
            }
        }

        // ===== ОЖИДАНИЕ СКАЧИВАНИЯ =====
        async _waitForDownload(torrentId, title) {
            Lampa.Bell.push({ text: '⏳ Ожидание скачивания...' });

            const checkStatus = async () => {
                const files = await TransmissionClient.getTorrentFiles(torrentId);
                if (files && files.percentDone >= 0.99) {
                    await this._playLocal(files, title);
                    return true;
                }
                return false;
            };

            // Проверяем каждые 5 секунд
            const interval = setInterval(async () => {
                const done = await checkStatus();
                if (done) {
                    clearInterval(interval);
                }
            }, 5000);

            // Первая проверка
            await checkStatus();
        }

        // ===== КНОПКА В КАРТОЧКЕ ФИЛЬМА =====
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
            const $container = movieData.activity.render().find('.full-start-new__buttons');
            if (!$container.length) return;

            // Удаляем старую кнопку
            $container.find('.button--torrentbridge').remove();

            const $button = $(`
                <div class="full-start__button selector button--torrentbridge" style="display:flex;align-items:center;gap:8px;">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
                    </svg>
                    <span>⚡ Torrent Bridge</span>
                </div>
            `);

            $button.on('hover:enter', () => {
                this._handleCardButtonClick(movieData);
            });

            $container.append($button);
        }

        async _handleCardButtonClick(movieData) {
            // Получаем торренты из TorrServer или TMDB
            // Здесь нужно реализовать получение списка торрентов
            
            Lampa.Bell.push({ text: 'ℹ️ Выберите торрент через контекстное меню' });
            
            // Показываем подсказку, как использовать плагин
            Lampa.Select.show({
                title: 'Torrent Bridge',
                items: [
                    {
                        title: 'ℹ️ Нажмите на торрент в списке и выберите "⚡ Bridge"',
                        action: 'info'
                    }
                ],
                onSelect: () => {}
            });
        }
    }

    // ===== ИНИЦИАЛИЗАЦИЯ =====
    function init() {
        if (window.appready) {
            if (!window.torrentbridge_initialized) {
                window.torrentbridge_initialized = true;
                new TorrentBridgePlugin();
            }
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready' && !window.torrentbridge_initialized) {
                    window.torrentbridge_initialized = true;
                    new TorrentBridgePlugin();
                }
            });
        }
    }

    init();

})();