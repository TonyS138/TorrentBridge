/**
 * Torrent Bridge - автономный плагин
 * Версия 3.0.0 - с собственными настройками и API
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '3.0.0',
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

    // Получение настроек
    function getTorrServerUrl() {
        return Lampa.Storage.get(MANIFEST.component + '_torrserver_url', 'http://192.168.1.101:8090');
    }

    function getTransmissionConfig() {
        return {
            url: Lampa.Storage.get(MANIFEST.component + '_transmission_url', 'http://192.168.1.112:9091'),
            user: Lampa.Storage.get(MANIFEST.component + '_transmission_user', ''),
            pass: Lampa.Storage.get(MANIFEST.component + '_transmission_pass', ''),
            path: Lampa.Storage.get(MANIFEST.component + '_transmission_path', '/transmission/rpc')
        };
    }

    /**
     * Запрос к Transmission API
     */
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
                    // Обработка 409 — нужен новый session ID
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

    /**
     * Запрос к TorrServer API
     * Используем разные варианты API
     */
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

    /**
     * Добавление торрента в TorrServer
     * Пробуем разные API
     */
    async function addToTorrServer(magnet) {
        const torrServerUrl = getTorrServerUrl();
        
        // Вариант 1: GET /torrent/add?link=MAGNET
        try {
            log('Trying GET /torrent/add');
            await torrServerRequest('/torrent/add', 'GET', { link: magnet });
            log('GET /torrent/add works!');
            return;
        } catch (e) {
            log('GET /torrent/add failed:', e.message);
        }
        
        // Вариант 2: POST /torrent/add с form data
        try {
            log('Trying POST /torrent/add');
            await $.ajax({
                url: `${torrServerUrl}/torrent/add`,
                method: 'POST',
                data: { link: magnet },
                dataType: 'text',
                timeout: 15000
            });
            log('POST /torrent/add works!');
            return;
        } catch (e) {
            log('POST /torrent/add failed:', e.message);
        }
        
        // Вариант 3: GET /api/torrent/add?link=MAGNET
        try {
            log('Trying GET /api/torrent/add');
            await torrServerRequest('/api/torrent/add', 'GET', { link: magnet });
            log('GET /api/torrent/add works!');
            return;
        } catch (e) {
            log('GET /api/torrent/add failed:', e.message);
        }
        
        // Вариант 4: POST /torrents с JSON
        try {
            log('Trying POST /torrents');
            await $.ajax({
                url: `${torrServerUrl}/torrents`,
                method: 'POST',
                data: JSON.stringify({ link: magnet }),
                contentType: 'application/json',
                dataType: 'text',
                timeout: 15000
            });
            log('POST /torrents works!');
            return;
        } catch (e) {
            log('POST /torrents failed:', e.message);
        }
        
        throw new Error('Не удалось добавить торрент в TorrServer');
    }

    /**
     * Получение URL потока
     */
    function getStreamUrl(hash) {
        const torrServerUrl = getTorrServerUrl();
        return `${torrServerUrl}/stream?link=${hash}&index=0&play=1`;
    }

    /**
     * Запуск воспроизведения
     */
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
     * Поиск торрента по фильму
     */
    async function findTorrentByMovie(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const searchLabel = `${method}/${id}`;

        log('Searching for:', searchLabel);

        try {
            const response = await transmissionRequest('torrent-get', {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status']
            });

            if (response && response.arguments && response.arguments.torrents) {
                const torrents = response.arguments.torrents;
                log('Total torrents:', torrents.length);

                const matched = torrents.find(torrent => {
                    const labels = torrent.labels || [];
                    return labels.includes(searchLabel);
                });

                if (matched) {
                    log('Found by label:', matched.name);
                    return matched;
                }

                const movieTitle = (movie.title || movie.name || movie.original_title || '').toLowerCase();
                const matchedByName = torrents.find(torrent => {
                    const torrentName = (torrent.name || '').toLowerCase();
                    return movieTitle && torrentName.includes(movieTitle);
                });

                if (matchedByName) {
                    log('Found by name:', matchedByName.name);
                    return matchedByName;
                }
            }
        } catch (error) {
            log('Search error:', error);
        }

        return null;
    }

    /**
     * Добавление кнопки на карточку фильма
     */
    async function addPlayButton(movieData) {
        if (!isPluginEnabled()) return;

        const movie = movieData.movie || movieData;
        if (!movie || !movie.id) return;

        currentMovie = movie;
        log('Adding button for:', movie.title || movie.name);

        const $button = $(`
            <div class="full-start__button selector button--torrent_bridge">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width: 24px; height: 24px;">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Смотреть через TorrServer</span>
            </div>
        `);

        $button.on('hover:enter', async function() {
            log('Button clicked!');
            
            try {
                const torrent = await findTorrentByMovie(movie);
                
                if (!torrent || !torrent.hashString) {
                    Lampa.Bell.push({ text: 'Торрент не найден в Transmission' });
                    return;
                }

                const magnet = `magnet:?xt=urn:btih:${torrent.hashString}&dn=${encodeURIComponent(torrent.name)}`;
                log('Magnet:', magnet);

                await playByMagnet(magnet, torrent.name);
            } catch (error) {
                log('Click error:', error);
                Lampa.Bell.push({ text: 'Ошибка: ' + (error.message || 'unknown') });
            }
        });

        const buttonsContainer = $('.full-start-new__buttons');
        if (buttonsContainer.length) {
            buttonsContainer.find('.button--torrent_bridge').remove();
            buttonsContainer.append($button);
            log('Button added');
        }
    }

    /**
     * Тестирование подключения
     */
    async function testConnection() {
        // Проверка TorrServer
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

        // Проверка Transmission
        Lampa.Bell.push({ text: 'Проверка Transmission...' });
        try {
            const response = await transmissionRequest('session-get', {});
            log('Transmission response:', response);
            Lampa.Bell.push({ text: '✅ Transmission доступен' });
        } catch (e) {
            Lampa.Bell.push({ text: '❌ Transmission недоступен: ' + e.message });
        }
    }

    /**
     * Создание меню настроек
     */
    function createSettingsMenu() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        // Активация
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

        // TorrServer URL
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_torrserver_url',
                type: 'input',
                default: 'http://192.168.1.101:8090'
            },
            field: {
                name: 'TorrServer URL',
                description: 'Адрес TorrServer'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_torrserver_url', value);
                Lampa.Settings.update();
            }
        });

        // Transmission URL
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_url',
                type: 'input',
                default: 'http://192.168.1.112:9091'
            },
            field: {
                name: 'Transmission URL',
                description: 'Адрес Transmission'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_url', value);
                Lampa.Settings.update();
            }
        });

        // Transmission User
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_user',
                type: 'input',
                default: 'admin'
            },
            field: {
                name: 'Transmission Login'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_user', value);
                Lampa.Settings.update();
            }
        });

        // Transmission Password
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_pass',
                type: 'input',
                default: 'admin'
            },
            field: {
                name: 'Transmission Password'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_pass', value);
                Lampa.Settings.update();
            }
        });

        // Transmission RPC Path
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_transmission_path',
                type: 'input',
                default: '/transmission/rpc'
            },
            field: {
                name: 'Transmission RPC Path'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_transmission_path', value);
                Lampa.Settings.update();
            }
        });

        // Кнопка проверки
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
                log('Movie card opened');
                setTimeout(() => {
                    addPlayButton(e.object);
                }, 1000);
            }
        });
    }

    function init() {
        log('Initializing Torrent Bridge v3.0...');
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
