/**
 * Lampa Plugin: TorrServer Launcher for Torrent Manager
 * 
 * Позволяет запускать торренты из Torrent Manager на онлайн-просмотр
 * через TorrServer прямо из списка торрентов.
 * 
 * Интеграция: Добавляет пункт "Play on TorrServer" в меню действий
 * с торрентом в Torrent Manager.
 */

(function () {
    'use strict';

    // Конфигурация
    const CONFIG = {
        torrServerUrl: 'http://192.168.1.101:8090',
        transmissionUrl: Lampa.Storage.get('lmetorrenttransmissionUrl', 'http://192.168.1.112:9091'),
        transmissionPath: Lampa.Storage.get('lmetorrenttransmissionPath', '/transmission/rpc')
    };

    /**
     * Получение session ID для Transmission API
     */
    let transmissionSessionId = null;

    async function getTransmissionSessionId() {
        const config = {
            url: CONFIG.transmissionUrl,
            user: Lampa.Storage.get('lmetorrenttransmissionUser', ''),
            pass: Lampa.Storage.get('lmetorrenttransmissionPass', '')
        };

        const headers = {
            'Authorization': 'Basic ' + btoa(config.user + ':' + config.pass),
            'Content-Type': 'application/json'
        };

        if (transmissionSessionId) {
            headers['X-Transmission-Session-Id'] = transmissionSessionId;
        }

        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(10000);
            
            const makeRequest = (sessionId) => {
                const reqHeaders = {...headers};
                if (sessionId) {
                    reqHeaders['X-Transmission-Session-Id'] = sessionId;
                }
                
                network.quiet(
                    `${CONFIG.transmissionUrl}${CONFIG.transmissionPath}`,
                    (response) => {
                        if (typeof response === 'string') {
                            response = JSON.parse(response);
                        }
                        resolve(response);
                    },
                    (error) => {
                        // Обработка 409 Conflict — получение нового session ID
                        if (error.status === 409) {
                            const newSessionId = error.getResponseHeader('X-Transmission-Session-Id');
                            if (newSessionId) {
                                transmissionSessionId = newSessionId;
                                makeRequest(newSessionId);
                            } else {
                                reject(new Error('Failed to get Transmission session ID'));
                            }
                        } else {
                            reject(error);
                        }
                    },
                    JSON.stringify({method: 'session-get'}),
                    {
                        headers: reqHeaders,
                        type: 'POST',
                        dataType: 'json'
                    }
                );
            };

            makeRequest(transmissionSessionId);
        });
    }

    /**
     * Получение hashString торрента из Transmission по ID
     */
    async function getTorrentHash(torrentId) {
        await getTransmissionSessionId();

        const config = {
            url: CONFIG.transmissionUrl,
            user: Lampa.Storage.get('lmetorrenttransmissionUser', ''),
            pass: Lampa.Storage.get('lmetorrenttransmissionPass', '')
        };

        const headers = {
            'Authorization': 'Basic ' + btoa(config.user + ':' + config.pass),
            'Content-Type': 'application/json'
        };

        if (transmissionSessionId) {
            headers['X-Transmission-Session-Id'] = transmissionSessionId;
        }

        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(10000);
            
            const body = JSON.stringify({
                method: 'torrent-get',
                arguments: {
                    ids: [torrentId],
                    fields: ['hashString', 'name', 'id']
                }
            });

            const makeRequest = (sessionId) => {
                const reqHeaders = {...headers};
                if (sessionId) {
                    reqHeaders['X-Transmission-Session-Id'] = sessionId;
                }
                
                network.quiet(
                    `${CONFIG.transmissionUrl}${CONFIG.transmissionPath}`,
                    (response) => {
                        if (typeof response === 'string') {
                            response = JSON.parse(response);
                        }
                        
                        if (response.arguments && response.arguments.torrents && response.arguments.torrents.length > 0) {
                            const torrent = response.arguments.torrents[0];
                            resolve({
                                hash: torrent.hashString,
                                name: torrent.name,
                                id: torrent.id
                            });
                        } else {
                            reject(new Error('Torrent not found'));
                        }
                    },
                    (error) => {
                        if (error.status === 409) {
                            const newSessionId = error.getResponseHeader('X-Transmission-Session-Id');
                            if (newSessionId) {
                                transmissionSessionId = newSessionId;
                                makeRequest(newSessionId);
                            } else {
                                reject(new Error('Failed to get session ID'));
                            }
                        } else {
                            reject(error);
                        }
                    },
                    body,
                    {
                        headers: reqHeaders,
                        type: 'POST',
                        dataType: 'json'
                    }
                );
            };

            makeRequest(transmissionSessionId);
        });
    }

    /**
     * Добавление торрента в TorrServer
     */
    async function addToTorrServer(hash, title) {
        const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;
        
        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(15000);
            
            network.quiet(
                `${CONFIG.torrServerUrl}/torrents`,
                (response) => {
                    if (typeof response === 'string') {
                        response = JSON.parse(response);
                    }
                    resolve(response);
                },
                (error) => {
                    reject(error);
                },
                JSON.stringify({
                    link: magnet,
                    title: title,
                    poster: '',
                    save_to: ''
                }),
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    type: 'POST',
                    dataType: 'json'
                }
            );
        });
    }

    /**
     * Получение списка файлов из TorrServer
     */
    async function getTorrServerFiles(hash) {
        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(10000);
            
            network.quiet(
                `${CONFIG.torrServerUrl}/torrents/${hash}/files`,
                (response) => {
                    if (typeof response === 'string') {
                        response = JSON.parse(response);
                    }
                    resolve(response);
                },
                (error) => {
                    reject(error);
                },
                null,
                {
                    type: 'GET',
                    dataType: 'json'
                }
            );
        });
    }

    /**
     * Получение URL потока для воспроизведения
     */
    function getStreamUrl(hash, fileIndex = 0) {
        return `${CONFIG.torrServerUrl}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    /**
     * Запуск воспроизведения через Lampa.Player
     */
    function playOnTorrServer(torrentData) {
        Lampa.Activity.loader(true);
        
        // Показываем уведомление о начале
        Lampa.Bell.push({
            text: 'Подключение к TorrServer...'
        });

        getTorrentHash(torrentData.id)
            .then(async (torrentInfo) => {
                console.log('TSL', 'Torrent info:', torrentInfo);
                
                // Добавляем торрент в TorrServer
                await addToTorrServer(torrentInfo.hash, torrentInfo.name);
                
                Lampa.Bell.push({
                    text: 'Торрент добавлен, получение потока...'
                });

                // Получаем список файлов
                const files = await getTorrServerFiles(torrentInfo.hash);
                
                if (!files || files.length === 0) {
                    throw new Error('No files in torrent');
                }

                // Фильтруем медиафайлы
                const mediaExtensions = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg'];
                const mediaFiles = files.filter(file => {
                    const ext = String(file.name || '').split('.').pop().toLowerCase();
                    return mediaExtensions.includes(ext);
                });

                if (mediaFiles.length === 0) {
                    throw new Error('No media files found');
                }

                // Если несколько файлов — показываем выбор
                if (mediaFiles.length > 1) {
                    const fileItems = mediaFiles.map((file, index) => ({
                        title: String(file.name).split('/').pop(),
                        file: file,
                        index: index
                    }));

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
                } else {
                    // Один файл — сразу запускаем
                    const streamUrl = getStreamUrl(torrentInfo.hash, 0);
                    playStream(streamUrl, torrentInfo.name);
                }
            })
            .catch((error) => {
                console.error('TSL', 'Error playing torrent:', error);
                Lampa.Activity.loader(false);
                Lampa.Bell.push({
                    text: 'Ошибка: ' + (error.message || 'Failed to play')
                });
            });
    }

    /**
     * Запуск воспроизведения потока
     */
    function playStream(streamUrl, title) {
        Lampa.Activity.loader(false);
        
        // Используем Lampa.Player для внешнего плеера
        Lampa.Player.play({
            url: streamUrl,
            title: title,
            timeline: false
        });
    }

    /**
     * Перехват меню действий Torrent Manager
     */
    function hookTorrentMenu() {
        // Перехватываем оригинальную функцию showTorrentMenu
        const originalShowTorrentMenu = window.showTorrentMenu;
        
        if (originalShowTorrentMenu) {
            window.showTorrentMenu = function(torrentData, allTorrents) {
                // Добавляем пункт меню
                const enabled = Lampa.Controller.enabled().name;
                
                Lampa.Select.show({
                    title: torrentData.name,
                    items: [
                        // Существующие пункты
                        { title: 'Resume', action: 'resume' },
                        { title: 'Pause', action: 'pause' },
                        { title: 'Delete', action: 'delete' },
                        // Наш новый пункт
                        { title: '🎬 Play on TorrServer', action: 'play_torrserver' },
                        { title: 'Delete with files', action: 'delete', deleteFiles: true }
                    ],
                    onBack: () => {
                        const currentController = Lampa.Controller.enabled();
                        if (currentController && currentController.name !== enabled) {
                            Lampa.Controller.toggle(enabled);
                        } else {
                            Lampa.Controller.toggle('menu');
                        }
                    },
                    onSelect: (action) => {
                        if (action.action === 'play_torrserver') {
                            playOnTorrServer(torrentData);
                        } else if (action.action === 'resume') {
                            // Оригинальная логика resume
                            executeClientMethod(Lampa.Storage.field('lmetorrentSelect'), 'SendCommand', [action, torrentData], {silentAuth: true});
                        } else if (action.action === 'pause') {
                            // Оригинальная логика pause
                            executeClientMethod(Lampa.Storage.field('lmetorrentSelect'), 'SendCommand', [action, torrentData], {silentAuth: true});
                        } else if (action.action === 'delete') {
                            // Оригинальная логика delete
                            executeClientMethod(Lampa.Storage.field('lmetorrentSelect'), 'SendCommand', [action, torrentData], {silentAuth: true});
                        }
                    }
                });
            };
        }
    }

    /**
     * Инициализация плагина
     */
    function init() {
        // Ждём полной загрузки Lampa
        if (window.appready) {
            hookTorrentMenu();
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(hookTorrentMenu, 1000);
                }
            });
        }
    }

    // Запуск плагина
    init();
})();
