/**
 * Torrent Bridge - плагин для запуска торрентов из Torrent Manager через TorrServer
 * Версия 1.0.11 - с выбором торрента из списка
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '1.0.11',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Launch torrents from Torrent Manager via TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;
    let originalSelectShow = null;

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function isPluginEnabled() {
        return Lampa.Storage.get(MANIFEST.component + '_enabled', false) === true;
    }

    function setPluginEnabled(value) {
        Lampa.Storage.set(MANIFEST.component + '_enabled', value === true);
    }

    function getTorrServerUrl() {
        const mainUrl = Lampa.Storage.get('torrserver_url', '');
        if (mainUrl && String(mainUrl).trim()) {
            let url = String(mainUrl).trim();
            url = url.replace(/\/+$/, '');
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'http://' + url;
            }
            return url;
        }
        return 'http://192.168.1.101:8090';
    }

    function getTransmissionConfig() {
        return {
            url: Lampa.Storage.get('lmetorrenttransmissionUrl', 'http://192.168.1.112:9091'),
            user: Lampa.Storage.get('lmetorrenttransmissionUser', ''),
            pass: Lampa.Storage.get('lmetorrenttransmissionPass', ''),
            path: Lampa.Storage.get('lmetorrenttransmissionPath', '/transmission/rpc')
        };
    }

    /**
     * Запрос к Transmission
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
                network.timeout(10000);
                
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
     * Запрос к TorrServer
     */
    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const torrServerUrl = getTorrServerUrl();
            const url = `${torrServerUrl}${path}`;
            
            log('TorrServer request:', method, url);
            
            const network = new Lampa.Reguest();
            network.timeout(10000);
            
            const options = {
                type: method,
                dataType: 'text'
            };
            
            if (body) {
                options.headers = {
                    'Content-Type': 'application/json'
                };
            }
            
            network.quiet(
                url,
                (response) => {
                    log('TorrServer response:', response);
                    resolve(response);
                },
                (error) => {
                    log('TorrServer error:', error);
                    reject(error);
                },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

    /**
     * Получение списка всех торрентов из Transmission
     */
    async function getAllTorrents() {
        const response = await transmissionRequest('torrent-get', {
            fields: ['hashString', 'name', 'id', 'percentDone', 'status']
        });

        if (response.arguments && response.arguments.torrents) {
            return response.arguments.torrents;
        }

        return [];
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
            if (typeof response === 'string') {
                try {
                    return JSON.parse(response);
                } catch (e) {
                    return [];
                }
            }
            return response || [];
        } catch (e) {
            log('Error getting files:', e);
            return [];
        }
    }

    function getStreamUrl(hash, fileIndex = 0) {
        const torrServerUrl = getTorrServerUrl();
        return `${torrServerUrl}/stream?link=${hash}&index=${fileIndex}&play=1`;
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

    /**
     * Показать список торрентов для выбора
     */
    async function showTorrentList() {
        Lampa.Activity.loader(true);
        
        try {
            const torrents = await getAllTorrents();
            log('All torrents:', torrents);
            
            if (!torrents || torrents.length === 0) {
                Lampa.Activity.loader(false);
                Lampa.Bell.push({ text: 'Нет торрентов в Transmission' });
                return;
            }

            const items = torrents.map(torrent => ({
                title: `${torrent.name} (${Math.round(torrent.percentDone * 100)}%)`,
                torrent: torrent
            }));

            Lampa.Activity.loader(false);
            
            Lampa.Select.show({
                title: 'Выберите торрент для просмотра',
                items: items,
                onSelect: (item) => {
                    if (item.torrent) {
                        playTorrentFromTransmission(item.torrent);
                    }
                },
                onBack: () => {
                    Lampa.Controller.toggle('content');
                }
            });
        } catch (error) {
            log('Error getting torrents:', error);
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ text: 'Ошибка: ' + (error.message || 'Не удалось получить торренты') });
        }
    }

    /**
     * Запуск торрента из данных Transmission
     */
    async function playTorrentFromTransmission(torrent) {
        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

        try {
            const hash = torrent.hashString;
            const name = torrent.name;

            if (!hash) {
                throw new Error('Не удалось получить hash торрента');
            }

            await addToTorrServer(hash, name);
            
            Lampa.Bell.push({ text: 'Получение потока...' });

            await new Promise(resolve => setTimeout(resolve, 3000));

            const files = await getTorrServerFiles(hash);
            log('Files:', files);

            if (!files || files.length === 0) {
                const streamUrl = getStreamUrl(hash, 0);
                playStream(streamUrl, name);
                return;
            }

            const mediaFiles = [];
            files.forEach((file, index) => {
                if (isMediaFile(file.name)) {
                    mediaFiles.push({ ...file, _index: index });
                }
            });

            if (mediaFiles.length === 0) {
                const streamUrl = getStreamUrl(hash, 0);
                playStream(streamUrl, name);
                return;
            }

            if (mediaFiles.length === 1) {
                const streamUrl = getStreamUrl(hash, mediaFiles[0]._index);
                playStream(streamUrl, name);
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
                        const streamUrl = getStreamUrl(hash, item.index);
                        playStream(streamUrl, name);
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
        const torrServerUrl = getTorrServerUrl();
        log('Testing TorrServer at:', torrServerUrl);
        
        Lampa.Bell.push({ text: 'Проверка TorrServer...' });
        
        try {
            const response = await torrServerRequest('/echo', 'GET');
            log('TorrServer echo response:', response);
            
            if (response && String(response).includes('MatriX')) {
                Lampa.Bell.push({ text: '✅ TorrServer доступен' });
            } else {
                Lampa.Bell.push({ text: '⚠️ TorrServer ответил: ' + response });
            }
        } catch (e) {
            log('TorrServer test failed:', e);
            Lampa.Bell.push({ 
                text: '❌ TorrServer недоступен: ' + (e.message || e.statusText || 'unknown')
            });
        }

        const config = getTransmissionConfig();
        log('Testing Transmission at:', config.url);
        
        Lampa.Bell.push({ text: 'Проверка Transmission...' });
        
        try {
            const response = await transmissionRequest('session-get', {});
            log('Transmission session:', response);
            Lampa.Bell.push({ text: '✅ Transmission доступен' });
        } catch (e) {
            log('Transmission test failed:', e);
            Lampa.Bell.push({ text: '❌ Transmission недоступен: ' + (e.message || 'unknown') });
        }
    }

    // Создание меню в настройках
    function createSettingsMenu() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

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

    // Перехват Lampa.Select.show
    function hookSelectShow() {
        if (originalSelectShow) return;

        originalSelectShow = Lampa.Select.show;
        
        Lampa.Select.show = function(options) {
            const items = options.items || [];
            
            const isTorrentMenu = items.some(item => 
                item.action === 'resume' || 
                item.action === 'pause' || 
                item.action === 'delete'
            );

            if (isTorrentMenu && isPluginEnabled()) {
                log('Torrent menu detected');
                
                const playItem = {
                    title: '🎬 Play on TorrServer',
                    action: 'play_torrserver'
                };

                const openIndex = items.findIndex(item => item.action === 'card');
                const insertIndex = openIndex >= 0 ? openIndex + 1 : 2;

                items.splice(insertIndex, 0, playItem);

                const originalOnSelect = options.onSelect;
                
                options.onSelect = function(item) {
                    log('Item selected:', item);
                    
                    if (item && item.action === 'play_torrserver') {
                        // Показываем список торрентов для выбора
                        showTorrentList();
                    } else if (originalOnSelect) {
                        originalOnSelect(item);
                    }
                };
            }

            return originalSelectShow.call(this, options);
        };
        
        log('Hooked Lampa.Select.show');
    }

    function init() {
        log('Initializing Torrent Bridge...');
        log('Enabled state:', isPluginEnabled());
        log('TorrServer URL:', getTorrServerUrl());

        createSettingsMenu();
        Lampa.Manifest.plugins = MANIFEST;

        hookSelectShow();

        log('Torrent Bridge initialized');
    }

    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        
        if (window.appready) {
            init();
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(init, 500);
                }
            });
        }
    }
})();
