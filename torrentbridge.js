/**
 * Torrent Bridge - кнопка запуска видео на карточке фильма
 * Версия 2.0.0
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '2.0.0',
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

    // Запрос к Transmission
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

    // Запрос к TorrServer
    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = `${getTorrServerUrl()}${path}`;
            const network = new Lampa.Reguest();
            network.timeout(10000);
            network.quiet(
                url,
                (response) => resolve(response),
                (error) => reject(error),
                body ? JSON.stringify(body) : null,
                { type: method, dataType: 'text' }
            );
        });
    }

    // Запуск торрента
    async function playTorrentByHash(hash, title) {
        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

        try {
            // Добавляем в TorrServer
            const magnet = `magnet:?xt=urn:btih:${hash}`;
            await torrServerRequest('/torrents', 'POST', {
                link: magnet,
                title: title || 'Torrent',
                poster: '',
                save_to: ''
            });

            await new Promise(resolve => setTimeout(resolve, 3000));

            // Получаем URL потока
            const streamUrl = `${getTorrServerUrl()}/stream?link=${hash}&index=0&play=1`;

            log('Stream URL:', streamUrl);

            Lampa.Activity.loader(false);
            Lampa.Player.play({
                url: streamUrl,
                title: title || 'Torrent',
                timeline: false
            });
        } catch (error) {
            log('Error:', error);
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ text: 'Ошибка: ' + (error.message || 'Не удалось запустить') });
        }
    }

    // Найти торрент по метаданным фильма
    async function findTorrentByMovie(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const searchLabel = `${method}/${id}`;

        log('Searching torrent for:', searchLabel);

        const response = await transmissionRequest('torrent-get', {
            fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status']
        });

        if (response && response.arguments && response.arguments.torrents) {
            const torrents = response.arguments.torrents;
            
            // Ищем по метке
            const matched = torrents.find(torrent => {
                const labels = torrent.labels || [];
                return labels.includes(searchLabel);
            });

            if (matched) {
                log('Found torrent by label:', matched);
                return matched;
            }

            // Если не нашли по метке — пробуем по имени
            const movieTitle = (movie.title || movie.name || movie.original_title || '').toLowerCase();
            const matchedByName = torrents.find(torrent => {
                const torrentName = (torrent.name || '').toLowerCase();
                return movieTitle && torrentName.includes(movieTitle);
            });

            if (matchedByName) {
                log('Found torrent by name:', matchedByName);
                return matchedByName;
            }
        }

        return null;
    }

    // Добавление кнопки на карточку фильма
    async function addPlayButton(movieData) {
        if (!isPluginEnabled()) return;

        const movie = movieData.movie || movieData;
        if (!movie || !movie.id) return;

        log('Adding play button for movie:', movie.title || movie.name);

        try {
            const torrent = await findTorrentByMovie(movie);
            
            if (!torrent) {
                log('Torrent not found for this movie');
                return;
            }

            // Создаём кнопку
            const $button = $(`
                <div class="full-start__button selector button--torrent_bridge">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                    <span>Смотреть через TorrServer</span>
                </div>
            `);

            $button.on('hover:enter', function() {
                playTorrentByHash(torrent.hashString, torrent.name);
            });

            // Добавляем кнопку на карточку
            const buttonsContainer = $('.full-start-new__buttons');
            if (buttonsContainer.length) {
                // Убираем старую кнопку, если есть
                buttonsContainer.find('.button--torrent_bridge').remove();
                buttonsContainer.append($button);
                log('Button added');
            } else {
                log('Buttons container not found');
            }
        } catch (error) {
            log('Error adding button:', error);
        }
    }

    // Слушаем событие открытия карточки фильма
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
        log('Initializing Torrent Bridge...');
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
