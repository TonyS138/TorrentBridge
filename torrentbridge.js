/**
 * Torrent Bridge - плагин для запуска торрентов из Torrent Manager через TorrServer
 * 
 * Добавляет пункт меню в настройки Lampa и пункт "Play on TorrServer" в меню торрентов
 */

(function () {
    'use strict';

    // Конфигурация по умолчанию
    const MANIFEST = {
        type: 'other',
        version: '1.0.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Launch torrents from Torrent Manager via TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    const TORRSERVER_URL = 'http://192.168.1.101:8090';
    
    let transmissionSessionId = null;
    let pluginEnabled = false;

    /**
     * Логирование
     */
    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    /**
     * Получение конфигурации Transmission
     */
    function getTransmissionConfig() {
        return {
            url: Lampa.Storage.get('lmetorrenttransmissionUrl', 'http://192.168.1.112:9091'),
            user: Lampa.Storage.get('lmetorrenttransmissionUser', ''),
            pass: Lampa.Storage.get('lmetorrenttransmissionPass', ''),
            path: Lampa.Storage.get('lmetorrenttransmissionPath', '/transmission/rpc')
        };
    }

    /**
     * Выполнение запроса к Transmission RPC
     */
    function transmissionRequest(method, args, retry = true) {
        return new Promise((resolve, reject) => {
            const config = getTransmissionConfig();
            
            const headers = {
                'Authorization': 'Basic ' + btoa(config.user + ':' + config.pass),
                'Content-Type': 'application/json'
            };

            if (transmissionSessionId) {
                headers['X-Transmission-Session-Id'] = transmissionSessionId;
            }

            const body = JSON.stringify({
                method: method,
                arguments: args
            });

            const makeRequest = () => {
                const network = new Lampa.Reguest();
                network.timeout(15000);
                
                network.quiet(
                    `${config.url}${config.path}`,
                    (response) => {
                        if (typeof response === 'string') {
                            try {
                                response = JSON.parse(response);
                            } catch (e) {
                                reject(new Error('Invalid response from Transmission'));
                                return;
                            }
                        }
                        resolve(response);
                    },
                    (error) => {
                        if (error.status === 409 && retry) {
                            const newSessionId = error.getResponseHeader ? error.getResponseHeader('X-Transmission-Session-Id') : null;
                            if (newSessionId) {
                                transmissionSessionId = newSessionId;
                                transmissionRequest(method, args, false)
                                    .then(resolve)
                                    .catch(reject);
                            } else {
                                reject(new Error('Failed to get Transmission session ID'));
                            }
                        } else {
                            reject(error);
                        }
                    },
                    body,
                    {
                        headers: headers,
                        type: 'POST',
                        dataType: 'json'
                    }
                );
            };

            makeRequest();
        });
    }

    /**
     * Получение hash торрента по ID
     */
    async function getTorrentHash(torrentId) {
        const response = await transmissionRequest('torrent-get', {
            ids: [torrentId],
            fields: ['hashString', 'name', 'id', 'percentDone', 'status']
        });

        if (response.arguments && response.arguments.torrents && response.arguments.torrents.length > 0) {
            const torrent = response.arguments.torrents[0];
            return {
                hash: torrent.hashString,
                name: torrent.name,
                id: torrent.id,
                percentDone: torrent.percentDone,
                status: torrent.status
            };
        }

        throw new Error('Torrent not found in Transmission');
    }

    /**
     * Запрос к TorrServer
     */
    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(15000);
            
            const options = {
                type: method,
                dataType: 'json'
            };

            if (body) {
                options.headers = {
                    'Content-Type': 'application/json'
                };
            }

            network.quiet(
                `${TORRSERVER_URL}${path}`,
                (response) => {
                    if (typeof response === 'string') {
                        try {
                            response = JSON.parse(response);
                        } catch (e) {
                            resolve(null);
                            return;
                        }
                    }
                    resolve(response);
                },
                (error) => {
                    reject(error);
                },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

    /**
     * Добавление торрента в TorrServer
     */
    async function addToTorrServer(hash, title) {
        log('Adding to TorrServer:', hash, title);
        
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        
        const response = await torrServerRequest('/torrents', 'POST', {
            link: magnet,
            title: title,
            poster: '',
            save_to: ''
        });

        log('TorrServer response:', response);
        
        // Ждём, пока TorrServer обработает торрент
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        return response;
    }

    /**
     * Получение списка файлов из TorrServer
     */
    async function getTorrServerFiles(hash) {
        try {
            const response = await torrServerRequest(`/torrents/${hash}/files`, 'GET');
            return response || [];
        } catch (e) {
            log('Error getting files:', e);
            return [];
        }
    }

    /**
     * Получение URL потока
     */
    function getStreamUrl(hash, fileIndex = 0) {
        return `${TORRSERVER_URL}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    /**
     * Проверка, является ли файл медиафайлом
     */
    function isMediaFile(filename) {
        const mediaExtensions = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp'];
        const ext = String(filename || '').split('.').pop().toLowerCase();
        return mediaExtensions.includes(ext);
    }

    /**
     * Запуск воспроизведения
     */
    function playStream(streamUrl, title) {
        log('Playing stream:', streamUrl);
        
        Lampa.Activity.loader(false);
        
        Lampa.Player.play({
            url: streamUrl,
            title: title,
            timeline: false
        });
    }

    /**
     * Основная функция запуска торрента
     */
    async function playTorrent(torrentData) {
        if (!pluginEnabled) {
            Lampa.Bell.push({ text: 'Torrent Bridge не активирован' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

        try {
            // Получаем hash из Transmission
            const torrentInfo = await getTorrentHash(torrentData.id);
            log('Torrent info:', torrentInfo);

            if (!torrentInfo.hash) {
                throw new Error('Не удалось получить hash торрента');
            }

            // Добавляем в TorrServer
            await addToTorrServer(torrentInfo.hash, torrentInfo.name);
            
            Lampa.Bell.push({ text: 'Получение потока...' });

            // Ждём, пока TorrServer обработает торрент
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Получаем список файлов
            const files = await getTorrServerFiles(torrentInfo.hash);
            log('Files:', files);

            if (!files || files.length === 0) {
                // Если файлы ещё не готовы — используем direct stream
                const streamUrl = getStreamUrl(torrentInfo.hash, 0);
                playStream(streamUrl, torrentInfo.name);
                return;
            }

            // Фильтруем медиафайлы
            const mediaFiles = [];
            files.forEach((file, index) => {
                if (isMediaFile(file.name)) {
                    mediaFiles.push({ ...file, _index: index });
                }
            });

            if (mediaFiles.length === 0) {
                // Если медиафайлы не найдены — пробуем первый файл
                const streamUrl = getStreamUrl(torrentInfo.hash, 0);
                playStream(streamUrl, torrentInfo.name);
                return;
            }

            if (mediaFiles.length === 1) {
                // Один файл — сразу запускаем
                const streamUrl = getStreamUrl(torrentInfo.hash, mediaFiles[0]._index);
                playStream(streamUrl, torrentInfo.name);
            } else {
                // Несколько файлов — показываем выбор
                const fileItems = mediaFiles.map((file) => ({
                    title: String(file.name).split('/').pop(),
                    file: file,
                    index: file._index
                }));

                Lampa.Activity.loader(false);
                
                Lampa.Select.show({
                    title: 'Выберите файл для просмотра',
                    items: fileItems,
                    onSelect: (item) => {
                        const streamUrl = getStreamUrl(torrentInfo.hash, item.index);
                        playStream(streamUrl, torrentInfo.name);
                    },
                    onBack: () => {
                        Lampa.Controller.toggle('content');
                    }
                });
            }
        } catch (error) {
            log('Error playing torrent:', error);
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ 
                text: 'Ошибка: ' + (error.message || 'Не удалось запустить') 
            });
        }
    }

    /**
     * Перехват меню торрента через Lampa.Select.show
     */
    let originalSelectShow = null;

    function hookSelectShow() {
        if (originalSelectShow) return;

        originalSelectShow = Lampa.Select.show;

        Lampa.Select.show = function(options) {
            // Проверяем, что это меню торрента
            const items = options.items || [];
            
            // Определяем, является ли это меню Torrent Manager
            const hasResume = items.some(item => 
                item.action === 'resume' || 
                (item.title && item.title.toLowerCase().includes('возобновить'))
            );
            
            const hasPause = items.some(item => 
                item.action === 'pause' || 
                (item.title && item.title.toLowerCase().includes('пауза'))
            );
            
            const hasDelete = items.some(item => 
                item.action === 'delete' || 
                (item.title && item.title.toLowerCase().includes('удалить'))
            );

            // Это меню торрента
            if (hasResume && hasPause && hasDelete && pluginEnabled) {
                // Добавляем пункт "Play on TorrServer"
                const playItem = {
                    title: '🎬 Play on TorrServer',
                    action: 'play_torrserver',
                    separator: true
                };

                // Находим позицию для вставки
                const openIndex = items.findIndex(item => 
                    item.action === 'card' || 
                    (item.title && item.title.toLowerCase().includes('открыть'))
                );

                const insertIndex = openIndex >= 0 ? openIndex + 1 : 2;

                items.splice(insertIndex, 0, playItem);

                // Перехватываем onSelect
                const originalOnSelect = options.onSelect;
                
                options.onSelect = function(item) {
                    if (item.action === 'play_torrserver') {
                        // Получаем данные торрента
                        const torrentData = getTorrentData();
                        
                        if (torrentData) {
                            playTorrent(torrentData);
                        } else {
                            Lampa.Bell.push({ 
                                text: 'Не удалось получить данные торрента' 
                            });
                        }
                    } else if (originalOnSelect) {
                        originalOnSelect(item);
                    }
                };
            }

            // Вызываем оригинальный метод
            return originalSelectShow.call(this, options);
        };
    }

    /**
     * Получение данных торрента
     */
    function getTorrentData() {
        // Пробуем получить из глобального состояния Torrent Manager
        if (window.TorrentStateManager && window.TorrentStateManager.torrents) {
            const torrents = window.TorrentStateManager.torrents;
            return torrents[0] || null;
        }

        // Пробуем через Lampa.Activity
        const activity = Lampa.Activity.active();
        if (activity && activity.movie) {
            return activity.movie;
        }

        return null;
    }

    /**
     * Создание пункта меню в настройках
     */
    function createSettingsMenu() {
        // Регистрируем компонент в настройках
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        // Добавляем параметр активации
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_enabled',
                type: 'trigger',
                default: false
            },
            field: {
                name: 'Активировать плагин',
                description: 'Включает пункт "Play on TorrServer" в меню торрентов'
            },
            onChange: function(value) {
                pluginEnabled = value === true;
                Lampa.Storage.set(MANIFEST.component + '_enabled', pluginEnabled);
                log('Plugin enabled:', pluginEnabled);
                
                if (pluginEnabled) {
                    Lampa.Bell.push({ text: 'Torrent Bridge активирован' });
                } else {
                    Lampa.Bell.push({ text: 'Torrent Bridge деактивирован' });
                }
                
                Lampa.Settings.update();
            }
        });

        // Добавляем кнопку тестирования
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_test',
                type: 'button'
            },
            field: {
                name: 'Проверить подключение'
            },
            onChange: function() {
                testConnection();
            }
        });
    }

    /**
     * Тестирование подключения
     */
    async function testConnection() {
        Lampa.Bell.push({ text: 'Проверка TorrServer...' });
        
        try {
            const response = await torrServerRequest('/echo', 'GET');
            log('TorrServer echo:', response);
            Lampa.Bell.push({ text: 'TorrServer доступен' });
        } catch (e) {
            log('TorrServer test failed:', e);
            Lampa.Bell.push({ text: 'TorrServer недоступен: ' + e.message });
        }

        Lampa.Bell.push({ text: 'Проверка Transmission...' });
        
        try {
            const response = await transmissionRequest('session-get', {});
            log('Transmission session:', response);
            Lampa.Bell.push({ text: 'Transmission доступен' });
        } catch (e) {
            log('Transmission test failed:', e);
            Lampa.Bell.push({ text: 'Transmission недоступен: ' + e.message });
        }
    }

    /**
     * Инициализация плагина
     */
    function init() {
        log('Initializing Torrent Bridge...');

        // Восстанавливаем состояние
        pluginEnabled = Lampa.Storage.get(MANIFEST.component + '_enabled', false) === true;
        log('Plugin enabled state:', pluginEnabled);

        // Создаём меню в настройках
        createSettingsMenu();

        // Регистрируем плагин
        Lampa.Manifest.plugins = MANIFEST;

        // Устанавливаем перехват меню
        if (window.appready) {
            hookSelectShow();
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(() => {
                        hookSelectShow();
                    }, 2000);
                }
            });
        }

        log('Torrent Bridge initialized');
    }

    // Запуск плагина
    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        
        if (window.appready) {
            init();
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    init();
                }
            });
        }
    }
})();
