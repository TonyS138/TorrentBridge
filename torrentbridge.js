/**
 * Torrent Bridge - v4.7.0
 * Прямое добавление кнопки в меню "Смотреть" через DOM
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '4.7.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;
    let currentMovie = null;
    let bridgeAdded = false;

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function isEnabled() {
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

    function getPlayerType() {
        return Lampa.Storage.get(MANIFEST.component + '_player_type', 'internal');
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
                data: JSON.stringify({ method: method, arguments: args }),
                dataType: 'json',
                timeout: 10000,
                success: resolve,
                error: function(xhr, status, error) {
                    if (xhr.status === 409 && retry) {
                        const newSid = xhr.getResponseHeader('X-Transmission-Session-Id');
                        if (newSid) {
                            transmissionSessionId = newSid;
                            transmissionRequest(method, args, false).then(resolve).catch(reject);
                        } else {
                            reject(new Error('Session ID error'));
                        }
                    } else {
                        reject(new Error(error || status));
                    }
                }
            });
        });
    }

    function torrServerAction(action, data = {}) {
        return new Promise((resolve, reject) => {
            const url = `${getTorrServerUrl()}/torrents`;
            const body = JSON.stringify({ action, ...data });
            
            $.ajax({
                url: url,
                method: 'POST',
                data: body,
                contentType: 'application/json',
                dataType: 'text',
                timeout: 15000,
                success: resolve,
                error: function(xhr, status, error) {
                    reject(new Error(error || status));
                }
            });
        });
    }

    function addToTorrServer(magnet, title) {
        return torrServerAction('add', {
            link: magnet,
            title: title || '',
            category: '',
            poster: '',
            save_to_db: true
        });
    }

    function getStreamUrl(hash) {
        return `${getTorrServerUrl()}/stream?link=${hash}&index=0&play=1`;
    }

    async function playByMagnet(magnet, title) {
        Lampa.Bell.push({ text: 'Добавление в TorrServer...' });

        try {
            await addToTorrServer(magnet, title);
            
            const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/);
            const hash = hashMatch ? hashMatch[1] : '';
            
            if (!hash) throw new Error('No hash');

            const streamUrl = getStreamUrl(hash);
            log('Stream:', streamUrl);

            const playerType = getPlayerType();
            
            if (playerType === 'external') {
                window.open(streamUrl, '_blank');
                Lampa.Bell.push({ text: 'Открыто во внешнем плеере' });
            } else {
                Lampa.Player.play({
                    url: streamUrl,
                    title: title || 'Torrent',
                    timeline: false
                });
            }
        } catch (e) {
            log('Play error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + e.message });
        }
    }

    async function findTorrent(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const label = `${method}/${id}`;
        const title = (movie.title || movie.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');

        try {
            const response = await transmissionRequest('torrent-get', {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'trackers']
            });

            const torrents = response?.arguments?.torrents || [];

            let found = torrents.find(t => (t.labels || []).includes(label));
            if (found) return found;

            found = torrents.find(t => {
                const name = (t.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
                return title && name.includes(title);
            });
            
            if (found) return found;

            const items = torrents.map(t => ({
                title: t.name,
                subtitle: Math.round((t.percentDone || 0) * 100) + '%',
                torrent: t
            }));

            return new Promise(resolve => {
                Lampa.Select.show({
                    title: 'Выберите торрент',
                    items: items,
                    onSelect: item => resolve(item.torrent),
                    onBack: () => resolve(null)
                });
            });
        } catch (e) {
            log('Search error:', e);
            return null;
        }
    }

    async function getFullMagnet(torrentId) {
        try {
            const response = await transmissionRequest('torrent-get', {
                ids: [torrentId],
                fields: ['hashString', 'name', 'trackers']
            });

            const torrent = response?.arguments?.torrents?.[0];
            if (!torrent) return null;

            let magnet = `magnet:?xt=urn:btih:${torrent.hashString}`;
            magnet += `&dn=${encodeURIComponent(torrent.name)}`;
            
            const trackers = torrent.trackers || [];
            trackers.forEach(tr => {
                if (tr.announce) {
                    magnet += `&tr=${encodeURIComponent(tr.announce)}`;
                }
            });

            return magnet;
        } catch (e) {
            return null;
        }
    }

    /**
     * Запуск торрента для текущего фильма
     */
    async function playCurrentMovie() {
        if (!currentMovie?.id) {
            Lampa.Bell.push({ text: 'Нет данных фильма' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Поиск торрента...' });

        try {
            const torrent = await findTorrent(currentMovie);
            if (!torrent?.hashString) {
                Lampa.Activity.loader(false);
                Lampa.Bell.push({ text: 'Торрент не найден в Transmission' });
                return;
            }

            Lampa.Bell.push({ text: 'Получение magnet-ссылки...' });
            
            const magnet = await getFullMagnet(torrent.id) || 
                `magnet:?xt=urn:btih:${torrent.hashString}&dn=${encodeURIComponent(torrent.name)}`;
            
            Lampa.Activity.loader(false);
            await playByMagnet(magnet, torrent.name);
        } catch (e) {
            Lampa.Activity.loader(false);
            log('Play error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + e.message });
        }
    }

    /**
     * Создание кнопки для основного контейнера в карточке фильма
     */
    function createMainButton() {
        return $(`
            <div class="full-start__button selector button--torrent_bridge">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>TorrentBridge</span>
            </div>
        `).on('hover:enter', function() {
            playCurrentMovie();
        });
    }

    /**
     * Добавление кнопки в основной контейнер карточки
     */
    function addMainButton(movie) {
        currentMovie = movie;
        
        const container = $('.full-start-new__buttons');
        if (container.length) {
            container.find('.button--torrent_bridge').remove();
            container.append(createMainButton());
            log('Main button added');
        }
    }

    /**
     * Создание HTML для пункта меню "Смотреть"
     */
    function createWatchMenuItemHTML() {
        return `
            <div class="selectbox-item selectbox-item--icon selector torrentbridge-watch-item" data-action="torrentbridge_play">
                <div class="selectbox-item__icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                    </svg>
                </div>
                <div>
                    <div class="selectbox-item__title">TorrentBridge</div>
                    <div class="selectbox-item__subtitle">Воспроизвести с сервера</div>
                </div>
            </div>
        `;
    }

    /**
     * Добавление кнопки в меню "Смотреть"
     */
    function addWatchMenuItem() {
        if (!isEnabled()) return;
        if (bridgeAdded) return;

        // Ищем контейнер меню
        const scrollBody = document.querySelector('.selectbox__body .scroll__body');
        if (!scrollBody) {
            // Если меню еще не открыто, ждем
            return;
        }

        // Проверяем, есть ли уже наш пункт
        if (scrollBody.querySelector('.torrentbridge-watch-item')) {
            bridgeAdded = true;
            return;
        }

        // Ищем элементы "Торренты" и "Трейлеры"
        const items = scrollBody.querySelectorAll('.selectbox-item');
        let insertBefore = null;
        let hasTorrent = false;
        let hasOnline = false;

        items.forEach(item => {
            const title = item.querySelector('.selectbox-item__title');
            if (title) {
                const text = title.textContent.trim().toLowerCase();
                if (text === 'торренты' || text === 'torrents') {
                    hasTorrent = true;
                }
                if (text === 'онлайн' || text === 'online') {
                    hasOnline = true;
                }
                if (text === 'трейлеры' || text === 'trailers') {
                    insertBefore = item;
                }
            }
        });

        // Добавляем пункт только если есть "Торренты" и "Онлайн" (это точно меню "Смотреть")
        if (hasTorrent && hasOnline) {
            const html = createWatchMenuItemHTML();
            const $item = $(html);

            // Добавляем обработчик клика
            $item.on('click', function(e) {
                e.stopPropagation();
                log('TorrentBridge clicked in watch menu');
                // Закрываем меню
                Lampa.Controller.toggle('content');
                setTimeout(() => {
                    playCurrentMovie();
                }, 200);
            });

            // Вставляем перед "Трейлеры" или в конец
            if (insertBefore) {
                $(insertBefore).before($item);
            } else {
                $(scrollBody).append($item);
            }

            bridgeAdded = true;
            log('Watch menu item added');
        }
    }

    /**
     * Наблюдатель за появлением меню "Смотреть"
     */
    function setupWatchMenuObserver() {
        // Используем MutationObserver для отслеживания появления меню
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                // Проверяем, появился ли .selectbox__body
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    const selectBody = document.querySelector('.selectbox__body .scroll__body');
                    if (selectBody && !bridgeAdded) {
                        // Небольшая задержка, чтобы DOM успел обновиться
                        setTimeout(addWatchMenuItem, 100);
                    }
                }
            });
        });

        // Наблюдаем за изменениями в body
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false
        });

        log('Watch menu observer setup');
    }

    async function testConnection() {
        Lampa.Activity.loader(true);
        let results = [];

        try {
            const r = await $.ajax({
                url: `${getTorrServerUrl()}/echo`,
                method: 'GET',
                dataType: 'text',
                timeout: 5000
            });
            const status = r?.includes('MatriX') ? '✅' : '⚠️';
            results.push(`${status} TorrServer: ${getTorrServerUrl()}`);
        } catch (e) {
            results.push(`❌ TorrServer: ${e.message}`);
        }

        try {
            await transmissionRequest('session-get', {});
            const config = getTransmissionConfig();
            results.push(`✅ Transmission: ${config.url}${config.path}`);
        } catch (e) {
            results.push(`❌ Transmission: ${e.message}`);
        }

        Lampa.Activity.loader(false);
        
        const message = results.join('\n');
        Lampa.Bell.push({ text: message, time: 5000 });
        
        Lampa.Select.show({
            title: 'Результаты проверки подключений',
            items: results.map(r => ({ title: r })),
            onBack: () => {
                Lampa.Controller.toggle('content');
            }
        });
    }

    function createSettings() {
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
                values: Lampa.Storage.get(MANIFEST.component + '_enabled', false),
                default: false
            },
            field: { 
                name: 'Активировать плагин',
                description: 'Добавляет кнопку "TorrentBridge" в карточку фильма и меню "Смотреть"'
            },
            onChange: function(value) {
                const enabled = value === true || value === 'true';
                Lampa.Storage.set(MANIFEST.component + '_enabled', enabled === true);
                bridgeAdded = false; // Сбрасываем флаг, чтобы кнопка добавилась заново
                Lampa.Bell.push({ text: enabled ? 'TorrentBridge активирован' : 'TorrentBridge деактивирован' });
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_player_type',
                type: 'select',
                values: {
                    'internal': 'Встроенный плеер Lampa',
                    'external': 'Внешний плеер (браузер)'
                },
                default: 'internal'
            },
            field: { 
                name: 'Выбор плеера',
                description: 'Встроенный - воспроизведение внутри Lampa, Внешний - открытие в новой вкладке'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_player_type', value);
                const names = {
                    'internal': 'Встроенный плеер Lampa',
                    'external': 'Внешний плеер (браузер)'
                };
                Lampa.Bell.push({ text: 'Плеер: ' + (names[value] || value) });
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_torrserver_url',
                type: 'input',
                values: Lampa.Storage.get(MANIFEST.component + '_torrserver_url', 'http://192.168.1.101:8090'),
                default: 'http://192.168.1.101:8090'
            },
            field: { 
                name: 'TorrServer URL',
                description: 'Адрес вашего TorrServer (например, http://192.168.1.101:8090)'
            },
            onChange: function(value) {
                Lampa.Storage.set(MANIFEST.component + '_torrserver_url', value);
                Lampa.Settings.update();
            }
        });

        const transParams = [
            { key: '_transmission_url', name: 'Transmission URL', def: 'http://192.168.1.112:9091', desc: 'Адрес Transmission (например, http://192.168.1.112:9091)' },
            { key: '_transmission_user', name: 'Transmission Login', def: 'admin', desc: 'Имя пользователя для доступа к Transmission' },
            { key: '_transmission_pass', name: 'Transmission Password', def: 'admin', desc: 'Пароль для доступа к Transmission' },
            { key: '_transmission_path', name: 'Transmission Path', def: '/transmission/rpc', desc: 'Путь к RPC API (обычно /transmission/rpc)' }
        ];

        transParams.forEach(p => {
            Lampa.SettingsApi.addParam({
                component: MANIFEST.component,
                param: {
                    name: MANIFEST.component + p.key,
                    type: 'input',
                    values: Lampa.Storage.get(MANIFEST.component + p.key, p.def),
                    default: p.def
                },
                field: { 
                    name: p.name,
                    description: p.desc
                },
                onChange: function(value) {
                    Lampa.Storage.set(MANIFEST.component + p.key, value);
                    Lampa.Settings.update();
                }
            });
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: { 
                name: MANIFEST.component + '_test', 
                type: 'button',
                default: false
            },
            field: { 
                name: '🔌 Проверить подключения',
                description: 'Тестирует связь с TorrServer и Transmission'
            },
            onChange: function() {
                testConnection();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_info',
                type: 'string',
                default: ''
            },
            field: {
                name: 'Текущие настройки',
                description: function() {
                    const tsUrl = getTorrServerUrl();
                    const trConfig = getTransmissionConfig();
                    const player = getPlayerType();
                    const playerNames = {
                        'internal': 'Встроенный',
                        'external': 'Внешний'
                    };
                    return `TorrServer: ${tsUrl}\nTransmission: ${trConfig.url}${trConfig.path}\nПлеер: ${playerNames[player] || player}`;
                }
            }
        });
    }

    function init() {
        log('Init v4.7.0');
        createSettings();
        Lampa.Manifest.plugins = MANIFEST;
        
        // Настраиваем наблюдатель за меню "Смотреть"
        setupWatchMenuObserver();
        
        // Слушаем открытие карточки фильма
        Lampa.Listener.follow('full', function(e) {
            if (e.type === 'complite') {
                setTimeout(() => {
                    const render = e.object.activity.render();
                    const movie = render.model || e.object.movie || e.object;
                    if (movie?.id) {
                        currentMovie = movie;
                        addMainButton(movie);
                    }
                }, 1000);
            }
        });
        
        log('TorrentBridge v4.7.0 initialized');
    }

    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        if (window.appready) init();
        else Lampa.Listener.follow('app', e => { if (e.type === 'ready') setTimeout(init, 500); });
    }
})();
