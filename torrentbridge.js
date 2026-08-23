/**
 * Torrent Bridge - кнопка запуска видео на карточке фильма
 * Версия 2.4.0 - с правильным API TorrServer
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '2.4.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Кнопка запуска видео из Torrent Manager через TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function isPluginEnabled() {
        return Lampa.Storage.get(MANIFEST.component + '_enabled', false) === true;
    }

    function getTorrServerUrl() {
        return Lampa.Storage.get('torrserver_url', 'http://192.168.1.101:8090');
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

            const network = new Lampa.Reguest();
            network.timeout(10000);
            network.quiet(
                `${config.url}${config.path}`,
                (response) => {
                    if (typeof response === 'string') {
                        try { response = JSON.parse(response); } catch (e) {}
                    }
                    resolve(response);
                },
                (error) => {
                    if (error.status === 409 && retry) {
                        const newSid = error.getResponseHeader ? error.getResponseHeader('X-Transmission-Session-Id') : null;
                        if (newSid) {
                            transmissionSessionId = newSid;
                            transmissionRequest(method, args, false).then(resolve).catch(reject);
                        } else {
                            reject(error);
                        }
                    } else {
                        reject(error);
                    }
                },
                JSON.stringify({ method: method, arguments: args }),
                { headers: headers, type: 'POST', dataType: 'json' }
            );
        });
    }

    /**
     * Добавление торрента в TorrServer через правильный API
     * TorrServer использует GET /torrent/add?link=MAGNET
     */
    function addToTorrServer(magnet) {
        return new Promise((resolve, reject) => {
            const torrServerUrl = getTorrServerUrl();
            const url = `${torrServerUrl}/torrent/add?link=${encodeURIComponent(magnet)}`;
            
            log('Adding to TorrServer:', url);
            
            const network = new Lampa.Reguest();
            network.timeout(15000);
            
            network.quiet(
                url,
                (response) => {
                    log('TorrServer add response:', response);
                    resolve(response);
                },
                (error) => {
                    log('TorrServer add error:', error);
                    reject(error);
                },
                null,
                { type: 'GET', dataType: 'text' }
            );
        });
    }

    /**
     * Получение URL потока от TorrServer
     */
    function getStreamUrl(hash, fileIndex = 0) {
        const torrServerUrl = getTorrServerUrl();
        return `${torrServerUrl}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    /**
     * Запуск торрента
     */
    async function playByMagnet(magnet, title) {
        Lampa.Bell.push({ text: 'Добавление в TorrServer...' });

        try {
            // Добавляем торрент в TorrServer
            await addToTorrServer(magnet);
            
            log('Torrent added to TorrServer');
            
            Lampa.Bell.push({ text: 'Получение потока...' });
            
            // Ждём, пока TorrServer обработает торрент
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Извлекаем hash из magnet
            const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/);
            const hash = hashMatch ? hashMatch[1] : '';
            
            if (!hash) {
                throw new Error('Не удалось извлечь hash из magnet');
            }

            // Формируем URL потока
            const streamUrl = getStreamUrl(hash);
            log('Stream URL:', streamUrl);

            Lampa.Bell.push({ text: 'Запуск воспроизведения...' });

            // Запускаем воспроизведение
            Lampa.Player.play({
                url: streamUrl,
                title: title || 'Torrent',
                timeline: false
            });
        } catch (error) {
            log('Play error:', error);
            Lampa.Bell.push({ 
                text: 'Ошибка: ' + (error.message || error.statusText || 'Не удалось запустить')
            });
        }
    }

    /**
     * Поиск торрента в Transmission
     */
    async function findTorrentByMovie(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const searchLabel = `${method}/${id}`;

        log('Searching for label:', searchLabel);

        try {
            const response = await transmissionRequest('torrent-get', {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status']
            });

            if (response && response.arguments && response.arguments.torrents) {
                const torrents = response.arguments.torrents;
                log('Total torrents in Transmission:', torrents.length);

                // Ищем по метке
                const matched = torrents.find(torrent => {
                    const labels = torrent.labels || [];
                    return labels.includes(searchLabel);
                });

                if (matched) {
                    log('Found by label:', matched.name);
                    return matched;
                }

                // По имени
                const movieTitle = (movie.title || movie.name || movie.original_title || '').toLowerCase();
                const matchedByName = torrents.find(torrent => {
                    const torrentName = (torrent.name || '').toLowerCase();
                    return movieTitle && torrentName.includes(movieTitle);
                });

                if (matchedByName) {
                    log('Found by name:', matchedByName.name);
                    return matchedByName;
                }

                log('Torrent not found for:', movieTitle);
            }
        } catch (error) {
            log('Error searching torrent:', error);
        }

        return null;
    }

    /**
     * Добавление кнопки на карточку фильма
     */
    async function addPlayButton(movieData) {
        if (!isPluginEnabled()) {
            log('Plugin disabled');
            return;
        }

        const movie = movieData.movie || movieData;
        if (!movie || !movie.id) {
            log('No movie data');
            return;
        }

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

                // Создаём magnet-ссылку
                const magnet = `magnet:?xt=urn:btih:${torrent.hashString}&dn=${encodeURIComponent(torrent.name)}`;
                log('Magnet:', magnet);

                await playByMagnet(magnet, torrent.name);
            } catch (error) {
                log('Error on button click:', error);
                Lampa.Bell.push({ text: 'Ошибка: ' + (error.message || 'unknown') });
            }
        });

        const buttonsContainer = $('.full-start-new__buttons');
        if (buttonsContainer.length) {
            buttonsContainer.find('.button--torrent_bridge').remove();
            buttonsContainer.append($button);
            log('Button added to card');
        } else {
            log('Container .full-start-new__buttons not found');
        }
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
    }

    function init() {
        log('Initializing Torrent Bridge v2.4...');
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
