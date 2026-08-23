/**
 * Torrent Bridge - с диагностикой поиска
 * Версия 3.1.0
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '3.1.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Автономный мост между Transmission и TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;
    let currentMovie = null;

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function isPluginEnabled() {
        return Lampa.Storage.get(MANIFEST.component + '_enabled', false) === true;
    }

    function getTorrServerUrl() {
        return Lampa.Storage.get(MANIFEST.component + '_torrserver_url', 'http://192.168.1.101:8090');
    }

    function getTransmissionConfig() {
        return {
            url: Lampa.Storage.get(MANIFEST.component + '_transmission_url', 'http://192.168.1.112:9091'),
            user: Lampa.Storage.get(MANIFEST.component + '_transmission_user', 'admin'),
            pass: Lampa.Storage.get(MANIFEST.component + '_transmission_pass', 'admin'),
            path: Lampa.Storage.get(MANIFEST.component + '_transmission_path', '/transmission/rpc')
        };
    }

    function transmissionRequest(method, args, retry = true) {
        return new Promise((resolve, reject) => {
            const config = getTransmissionConfig();
            
            $.ajax({
                url: `${config.url}${config.path}`,
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(config.user + ':' + config.pass),
                    'Content-Type': 'application/json',
                    ...(transmissionSessionId ? {'X-Transmission-Session-Id': transmissionSessionId} : {})
                },
                data: JSON.stringify({
                    method: method,
                    arguments: args
                }),
                dataType: 'json',
                timeout: 10000,
                success: function(response) {
                    resolve(response);
                },
                error: function(xhr, status, error) {
                    if (xhr.status === 409 && retry) {
                        const newSid = xhr.getResponseHeader('X-Transmission-Session-Id');
                        if (newSid) {
                            transmissionSessionId = newSid;
                            transmissionRequest(method, args, false)
                                .then(resolve)
                                .catch(reject);
                        } else {
                            reject(new Error('Failed to get session ID'));
                        }
                    } else {
                        reject(new Error(error || status || 'Network error'));
                    }
                }
            });
        });
    }

    function torrServerRequest(path, method = 'GET', data = null) {
        return new Promise((resolve, reject) => {
            const url = `${getTorrServerUrl()}${path}`;
            
            log('TorrServer request:', method, url);
            
            $.ajax({
                url: url,
                method: method,
                data: data,
                dataType: 'text',
                timeout: 15000,
                success: function(response) {
                    log('TorrServer success:', response);
                    resolve(response);
                },
                error: function(xhr, status, error) {
                    log('TorrServer error:', {
                        status: xhr.status,
                        statusText: xhr.statusText,
                        responseText: xhr.responseText
                    });
                    reject(new Error(error || status || 'Network error'));
                }
            });
        });
    }

    async function addToTorrServer(magnet) {
        const torrServerUrl = getTorrServerUrl();
        
        // Пробуем разные API TorrServer
        const apiVariants = [
            {
                name: 'GET /torrent/add',
                method: 'GET',
                url: `${torrServerUrl}/torrent/add`,
                data: { link: magnet }
            },
            {
                name: 'POST /torrent/add',
                method: 'POST',
                url: `${torrServerUrl}/torrent/add`,
                data: { link: magnet }
            },
            {
                name: 'GET /api/torrent/add',
                method: 'GET',
                url: `${torrServerUrl}/api/torrent/add`,
                data: { link: magnet }
            }
        ];

        for (const variant of apiVariants) {
            try {
                log(`Trying ${variant.name}...`);
                await $.ajax({
                    url: variant.url,
                    method: variant.method,
                    data: variant.data,
                    dataType: 'text',
                    timeout: 15000
                });
                log(`${variant.name} works!`);
                return;
            } catch (e) {
                log(`${variant.name} failed:`, e.message);
            }
        }

        throw new Error('Не удалось добавить торрент в TorrServer');
    }

    function getStreamUrl(hash) {
        const torrServerUrl = getTorrServerUrl();
        return `${torrServerUrl}/stream?link=${hash}&index=0&play=1`;
    }

    async function playByMagnet(magnet, title) {
        Lampa.Bell.push({ text: 'Добавление в TorrServer...' });

        try {
            await addToTorrServer(magnet);
            
            Lampa.Bell.push({ text: 'Получение потока...' });
            
            await new Promise(resolve => setTimeout(resolve, 5000));

            const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/);
            const hash = hashMatch ? hashMatch[1] : '';
            
            if (!hash) {
                throw new Error('Не удалось извлечь hash');
            }

            const streamUrl = getStreamUrl(hash);
            log('Stream URL:', streamUrl);

            Lampa.Player.play({
                url: streamUrl,
                title: title || 'Torrent',
                timeline: false
            });
        } catch (error) {
            log('Play error:', error);
            Lampa.Bell.push({ 
                text: 'Ошибка: ' + (error.message || 'Не удалось запустить')
            });
        }
    }

    /**
     * Диагностика: показать все торренты из Transmission
     */
    async function listAllTorrents() {
        log('=== ВСЕ ТОРРЕНТЫ В TRANSMISSION ===');
        
        const response = await transmissionRequest('torrent-get', {
            fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status']
        });

        if (response && response.arguments && response.arguments.torrents) {
            const torrents = response.arguments.torrents;
            log('Количество торрентов:', torrents.length);
            
            torrents.forEach((torrent, index) => {
                log(`--- Торрент ${index + 1} ---`);
                log('ID:', torrent.id);
                log('Name:', torrent.name);
                log('Hash:', torrent.hashString);
                log('Labels:', JSON.stringify(torrent.labels));
                log('Status:', torrent.status);
                log('Progress:', torrent.percentDone);
            });
            
            return torrents;
        }
        
        return [];
    }

    /**
     * Поиск торрента разными способами
     */
    async function findTorrentByMovie(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const title = movie.title || movie.name || movie.original_title || '';
        
        log('=== ПОИСК ТОРРЕНТА ===');
        log('Movie:', title);
        log('TMDB ID:', id);
        log('Type:', method);
        
        // Получаем все торренты
        const allTorrents = await listAllTorrents();
        
        if (allTorrents.length === 0) {
            log('Нет торрентов в Transmission');
            return null;
        }
        
        // Способ 1: По метке movie/ID или tv/ID
        const labelToFind = `${method}/${id}`;
        log('Ищем метку:', labelToFind);
        
        const byLabel = allTorrents.find(torrent => {
            const labels = torrent.labels || [];
            return labels.includes(labelToFind);
        });
        
        if (byLabel) {
            log('✅ Найден по метке:', byLabel.name);
            return byLabel;
        }
        
        // Способ 2: По названию фильма
        const titleLower = title.toLowerCase().replace(/[^a-zа-я0-9]/g, '');
        log('Ищем по названию:', titleLower);
        
        const byName = allTorrents.find(torrent => {
            const torrentName = (torrent.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
            return titleLower && torrentName.includes(titleLower);
        });
        
        if (byName) {
            log('✅ Найден по названию:', byName.name);
            return byName;
        }
        
        // Способ 3: Показать все торренты и дать выбрать
        log('❌ Не найден автоматически. Показываем список...');
        
        const menuItems = allTorrents.map(torrent => ({
            title: torrent.name,
            subtitle: (torrent.percentDone * 100).toFixed(0) + '%',
            torrent: torrent
        }));
        
        return new Promise((resolve) => {
            Lampa.Select.show({
                title: 'Выберите торрент',
                items: menuItems,
                onSelect: (item) => {
                    log('Выбран торрент:', item.torrent.name);
                    resolve(item.torrent);
                },
                onBack: () => {
                    log('Выбор отменён');
                    resolve(null);
                }
            });
        });
    }

    async function addPlayButton(movieData) {
        if (!isPluginEnabled()) return;

        const movie = movieData.movie || movieData;
        if (!movie || !movie.id) return;

        currentMovie = movie;
        log('=== ДОБАВЛЕНИЕ КНОПКИ ===');
        log('Movie:', movie.title || movie.name);
        log('ID:', movie.id);
        log('Type:', movie.first_air_date ? 'tv' : 'movie');

        const $button = $(`
            <div class="full-start__button selector button--torrent_bridge">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width: 24px; height: 24px;">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Смотреть через TorrServer</span>
            </div>
        `);

        $button.on('hover:enter', async function() {
            log('Кнопка нажата!');
            
            try {
                const torrent = await findTorrentByMovie(movie);
                
                if (!torrent || !torrent.hashString) {
                    Lampa.Bell.push({ text: 'Торрент не найден' });
                    return;
                }

                log('Выбран торрент:', torrent.name);
                log('Hash:', torrent.hashString);

                const magnet = `magnet:?xt=urn:btih:${torrent.hashString}&dn=${encodeURIComponent(torrent.name)}`;
                log('Magnet:', magnet);

                await playByMagnet(magnet, torrent.name);
            } catch (error) {
                log('Ошибка при нажатии:', error);
                Lampa.Bell.push({ text: 'Ошибка: ' + (error.message || 'unknown') });
            }
        });

        const buttonsContainer = $('.full-start-new__buttons');
        if (buttonsContainer.length) {
            buttonsContainer.find('.button--torrent_bridge').remove();
            buttonsContainer.append($button);
            log('Кнопка добавлена');
        }
    }

    async function testConnection() {
        Lampa.Bell.push({ text: 'Проверка TorrServer...' });
        try {
            const response = await torrServerRequest('/echo', 'GET');
            log('TorrServer echo:', response);
            if (response && String(response).includes('MatriX')) {
                Lampa.Bell.push({ text: '✅ TorrServer доступен' });
            } else {
                Lampa.Bell.push({ text: '⚠️ TorrServer ответил: ' + response });
            }
        } catch (e) {
            Lampa.Bell.push({ text: '❌ TorrServer недоступен: ' + e.message });
        }

        Lampa.Bell.push({ text: 'Проверка Transmission...' });
        try {
            const response = await transmissionRequest('session-get', {});
            log('Transmission response:', response);
            Lampa.Bell.push({ text: '✅ Transmission доступен' });
        } catch (e) {
            Lampa.Bell.push({ text: '❌ Transmission недоступен: ' + e.message });
        }
    }

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
                name: 'Активировать плагин'
            },
            onChange: function(value) {
                const enabled = value === true || value === 'true';
                Lampa.Storage.set(MANIFEST.component + '_enabled', enabled === true);
                
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
                name: MANIFEST.component + '_torrserver_url',
                type: 'input',
                values: getTorrServerUrl(),
                placeholder: 'http://192.168.1.101:8090'
            },
            field: {
                name: 'TorrServer URL'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_torrserver_url', value);
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_url',
                type: 'input',
                values: getTransmissionConfig().url,
                placeholder: 'http://192.168.1.112:9091'
            },
            field: {
                name: 'Transmission URL'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_url', value);
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_user',
                type: 'input',
                values: getTransmissionConfig().user,
                placeholder: 'admin'
            },
            field: {
                name: 'Transmission Login'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_user', value);
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_pass',
                type: 'input',
                values: getTransmissionConfig().pass,
                placeholder: 'admin'
            },
            field: {
                name: 'Transmission Password'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_pass', value);
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_path',
                type: 'input',
                values: getTransmissionConfig().path,
                placeholder: '/transmission/rpc'
            },
            field: {
                name: 'Transmission RPC Path'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_path', value);
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

    function listenForMovieCard() {
        Lampa.Listener.follow('full', function(e) {
            if (e.type === 'complite') {
                log('Карточка фильма открыта');
                setTimeout(() => {
                    addPlayButton(e.object);
                }, 1000);
            }
        });
    }

    function init() {
        log('Initializing Torrent Bridge v3.1...');
        createSettingsMenu();
        Lampa.Manifest.plugins = MANIFEST;
        listenForMovieCard();
        log('Torrent Bridge initialized');
    }

    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        
        if (window.appready) {
            init();
        } else {
            Lampa.Listener.follow('app', function(e) {
                if (e.type === 'ready') {
                    setTimeout(init, 500);
                }
            });
        }
    }
})();
