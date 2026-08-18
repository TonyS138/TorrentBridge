/**
 * TorrServer Launcher for Torrent Manager
 * Добавляет пункт "Play on TorrServer" в меню торрентов
 */

(function () {
    'use strict';

    // Конфигурация
    const TORRSERVER_URL = 'http://192.168.1.101:8090';
    
    let transmissionSessionId = null;
    let originalSelectShow = null;

    /**
     * Логирование
     */
    function log(...args) {
        console.log('TSL', ...args);
    }

    /**
     * Получение конфигурации Transmission из хранилища Lampa
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
    function transmissionRequest(method, arguments, retry = true) {
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
                arguments: arguments
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
                        // Обработка 409 — нужен новый session ID
                        if (error.status === 409 && retry) {
                            const newSessionId = error.getResponseHeader ? error.getResponseHeader('X-Transmission-Session-Id') : null;
                            if (newSessionId) {
                                transmissionSessionId = newSessionId;
                                transmissionRequest(method, arguments, false)
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
     * Перехват Lampa.Select.show для добавления пункта меню
     */
    function hookSelectShow() {
        if (originalSelectShow) return;

        originalSelectShow = Lampa.Select.show;

        Lampa.Select.show = function(options) {
            // Проверяем, что это меню торрента
            const title = options.title || '';
            const items = options.items || [];
            
            // Определяем, является ли это меню Torrent Manager
            // По наличию характерных пунктов меню
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
            if (hasResume && hasPause && hasDelete) {
                // Находим данные торрента
                // Они могут быть в замыкании, но мы можем получить их из items
                // или из контекста вызова
                
                // Добавляем пункт "Play on TorrServer"
                const playItem = {
                    title: '🎬 Play on TorrServer',
                    action: 'play_torrserver',
                    separator: true
                };

                // Вставляем после "Открыть" если есть, иначе после "Удалить"
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
                        // Нам нужны данные торрента
                        // Они должны быть в замыкании, но мы можем получить их
                        // через глобальное состояние Torrent Manager
                        
                        // Пробуем получить данные из разных источников
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
            // Находим последний выбранный торрент
            // Это не идеально, но лучше чем ничего
            const torrents = window.TorrentStateManager.torrents;
            return torrents[0] || null;
        }

        // Альтернативный способ — через Lampa.Activity
        const activity = Lampa.Activity.active();
        if (activity && activity.movie) {
            return activity.movie;
        }

        return null;
    }

    /**
     * Инициализация
     */
    function init() {
        log('Initializing TorrServer Launcher...');

        if (window.appready) {
            hookSelectShow();
            log('Hooked Lampa.Select.show');
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(() => {
                        hookSelectShow();
                        log('Hooked Lampa.Select.show (delayed)');
                    }, 2000);
                }
            });
        }
    }

    // Запуск
    init();
})();
