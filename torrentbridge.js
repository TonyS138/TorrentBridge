/**
 * Torrent Bridge - плагин для запуска торрентов из Torrent Manager через TorrServer
 * Версия 1.0.3
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '1.0.3',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Launch torrents from Torrent Manager via TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    const TORRSERVER_URL = 'http://192.168.1.101:8090';
    
    let transmissionSessionId = null;

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function isPluginEnabled() {
        return Lampa.Storage.get(MANIFEST.component + '_enabled', false) === true;
    }

    function setPluginEnabled(value) {
        Lampa.Storage.set(MANIFEST.component + '_enabled', value === true);
        log('Plugin enabled set to:', value);
    }

    function getTransmissionConfig() {
        return {
            url: Lampa.Storage.get('lmetorrenttransmissionUrl', 'http://192.168.1.112:9091'),
            user: Lampa.Storage.get('lmetorrenttransmissionUser', ''),
            pass: Lampa.Storage.get('lmetorrenttransmissionPass', ''),
            path: Lampa.Storage.get('lmetorrenttransmissionPath', '/transmission/rpc')
        };
    }

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

    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const network = new Lampa.Reguest();
            network.timeout(15000);
            
            const options = {
                type: method
            };

            if (body) {
                options.headers = {
                    'Content-Type': 'application/json'
                };
            }

            network.quiet(
                `${TORRSERVER_URL}${path}`,
                (response) => {
                    // TorrServer может возвращать JSON или текст
                    if (typeof response === 'string') {
                        try {
                            resolve(JSON.parse(response));
                        } catch (e) {
                            // Если не JSON — возвращаем как есть
                            resolve(response);
                        }
                    } else {
                        resolve(response);
                    }
                },
                (error) => {
                    reject(error);
                },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

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
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        return response;
    }

    async function getTorrServerFiles(hash) {
        try {
            const response = await torrServerRequest(`/torrents/${hash}/files`, 'GET');
            return response || [];
        } catch (e) {
            log('Error getting files:', e);
            return [];
        }
    }

    function getStreamUrl(hash, fileIndex = 0) {
        return `${TORRSERVER_URL}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    function isMediaFile(filename) {
        const mediaExtensions = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp'];
        const ext = String(filename || '').split('.').pop().toLowerCase();
        return mediaExtensions.includes(ext);
    }

    function playStream(streamUrl, title) {
        log('Playing stream:', streamUrl);
        Lampa.Activity.loader(false);
        Lampa.Player.play({
            url: streamUrl,
            title: title,
            timeline: false
        });
    }

    async function playTorrent(torrentData) {
        if (!isPluginEnabled()) {
            Lampa.Bell.push({ text: 'Torrent Bridge не активирован' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

        try {
            const torrentInfo = await getTorrentHash(torrentData.id);
            log('Torrent info:', torrentInfo);

            if (!torrentInfo.hash) {
                throw new Error('Не удалось получить hash торрента');
            }

            await addToTorrServer(torrentInfo.hash, torrentInfo.name);
            
            Lampa.Bell.push({ text: 'Получение потока...' });

            await new Promise(resolve => setTimeout(resolve, 3000));

            const files = await getTorrServerFiles(torrentInfo.hash);
            log('Files:', files);

            if (!files || files.length === 0) {
                const streamUrl = getStreamUrl(torrentInfo.hash, 0);
                playStream(streamUrl, torrentInfo.name);
                return;
            }

            const mediaFiles = [];
            files.forEach((file, index) => {
                if (isMediaFile(file.name)) {
                    mediaFiles.push({ ...file, _index: index });
                }
            });

            if (mediaFiles.length === 0) {
                const streamUrl = getStreamUrl(torrentInfo.hash, 0);
                playStream(streamUrl, torrentInfo.name);
                return;
            }

            if (mediaFiles.length === 1) {
                const streamUrl = getStreamUrl(torrentInfo.hash, mediaFiles[0]._index);
                playStream(streamUrl, torrentInfo.name);
            } else {
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

    // Тестирование подключения
    async function testConnection() {
        Lampa.Bell.push({ text: 'Проверка TorrServer...' });
        
        try {
            const response = await torrServerRequest('/echo', 'GET');
            log('TorrServer echo response:', response);
            
            if (response && String(response).includes('MatriX')) {
                Lampa.Bell.push({ text: 'TorrServer доступен (MatriX)' });
            } else {
                Lampa.Bell.push({ text: 'TorrServer доступен: ' + response });
            }
        } catch (e) {
            log('TorrServer test failed:', e);
            Lampa.Bell.push({ 
                text: 'TorrServer недоступен: ' + (e.statusText || e.message || 'unknown') 
            });
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

    // Создание меню в настройках
    function createSettingsMenu() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        // Триггер активации
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
                const enabled = value === true || value === 'true';
                setPluginEnabled(enabled);
                log('Toggle changed:', value, '->', enabled);
                
                if (enabled) {
                    Lampa.Bell.push({ text: 'Torrent Bridge активирован' });
                } else {
                    Lampa.Bell.push({ text: 'Torrent Bridge деактивирован' });
                }
                
                Lampa.Settings.update();
            }
        });

        // Кнопка тестирования
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

    // Перехват меню торрента
    function hookTorrentMenu() {
        const originalSelectShow = Lampa.Select.show;
        
        Lampa.Select.show = function(options) {
            const items = options.items || [];
            
            const isTorrentMenu = items.some(item => 
                item.action === 'resume' || 
                item.action === 'pause' || 
                item.action === 'delete'
            );

            if (isTorrentMenu && isPluginEnabled()) {
                const playItem = {
                    title: '🎬 Play on TorrServer',
                    action: 'play_torrserver',
                    separator: true
                };

                const openIndex = items.findIndex(item => item.action === 'card');
                const insertIndex = openIndex >= 0 ? openIndex + 1 : 2;

                items.splice(insertIndex, 0, playItem);

                const originalOnSelect = options.onSelect;
                
                options.onSelect = function(item) {
                    if (item.action === 'play_torrserver') {
                        const torrentData = getTorrentDataFromContext();
                        
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

            return originalSelectShow.call(this, options);
        };
    }

    function getTorrentDataFromContext() {
        if (window.TorrentStateManager && window.TorrentStateManager.torrents) {
            return window.TorrentStateManager.torrents[0] || null;
        }

        if (window.currentTorrent) {
            return window.currentTorrent;
        }

        return null;
    }

    // Инициализация
    function init() {
        log('Initializing Torrent Bridge...');
        log('Enabled state:', isPluginEnabled());

        createSettingsMenu();
        Lampa.Manifest.plugins = MANIFEST;

        setTimeout(() => {
            hookTorrentMenu();
            log('Hooked torrent menu');
        }, 3000);

        log('Torrent Bridge initialized');
    }

    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        
        if (window.appready) {
            init();
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(init, 1000);
                }
            });
        }
    }
})();
