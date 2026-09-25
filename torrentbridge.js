/**
 * Torrent Bridge - v6.0.0
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '6.0.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    const CONFIG_PREFIX = 'torrentbridge';
    let currentMovie = null;
    let originalSelectShow = null;

    // ==================== ЛОГИРОВАНИЕ ====================

    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function error(...args) {
        console.error('[TorrentBridge ERROR]', ...args);
    }

    // ==================== УТИЛИТЫ КОНФИГА ====================

    function isEnabled() {
        return Lampa.Storage.get(CONFIG_PREFIX + '_enabled', false) === true;
    }

    function getTorrServerUrl() {
        let url = Lampa.Storage.get(CONFIG_PREFIX + '_torrserver_url', 'http://192.168.1.101:8090');
        url = String(url).trim().replace(/\/+$/, '');
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }
        return url;
    }

    function getPlayerType() {
        return Lampa.Storage.get(CONFIG_PREFIX + '_player_type', 'internal');
    }

    function getTransmissionConfig() {
        let url = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_url', 'http://192.168.1.112:9091');
        url = String(url).trim().replace(/\/+$/, '');
        
        return {
            url: url,
            user: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_user', ''),
            pass: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_pass', ''),
            path: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_path', '/transmission/rpc')
        };
    }

    // ==================== TRANSMISSION API ====================

    function transmissionRequest(data, retry = true) {
        return new Promise((resolve, reject) => {
            const config = getTransmissionConfig();
            
            if (!config.url) {
                reject(new Error('Transmission URL не настроен'));
                return;
            }

            const url = config.url + config.path;
            const headers = {
                'Content-Type': 'application/json'
            };

            if (config.user || config.pass) {
                headers['Authorization'] = 'Basic ' + btoa(config.user + ':' + config.pass);
            }

            const sessionId = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_key');
            if (sessionId) {
                headers['X-Transmission-Session-Id'] = sessionId;
            }

            const network = new Lampa.Reguest();
            network.timeout(10000);

            network.quiet(
                url,
                (response) => {
                    if (typeof response === 'string') {
                        try {
                            response = JSON.parse(response);
                        } catch (e) {
                            reject(new Error('Ошибка парсинга ответа Transmission'));
                            return;
                        }
                    }
                    resolve(response);
                },
                (err) => {
                    if (err && err.status === 409 && retry) {
                        const newSessionId = err.getResponseHeader 
                            ? err.getResponseHeader('X-Transmission-Session-Id') 
                            : null;
                        
                        if (newSessionId) {
                            log('Got new Transmission session ID');
                            Lampa.Storage.set(CONFIG_PREFIX + '_transmission_key', newSessionId);
                            transmissionRequest(data, false).then(resolve).catch(reject);
                            return;
                        }
                    }
                    reject(err);
                },
                JSON.stringify(data),
                {
                    headers: headers,
                    type: 'POST',
                    dataType: 'json'
                }
            );
        });
    }

    async function transmissionAuth(showNotification = true) {
        try {
            await transmissionRequest({ method: 'session-get' });
            if (showNotification) {
                Lampa.Bell.push({ text: '✅ Transmission доступен' });
            }
            return true;
        } catch (e) {
            error('Transmission auth error:', e);
            if (showNotification) {
                Lampa.Bell.push({ text: '❌ Transmission: ' + (e.message || 'ошибка') });
            }
            throw e;
        }
    }

    async function transmissionGetData() {
        const statusMap = {
            0: 'Stopped',
            1: 'Queued to verify',
            2: 'Verifying',
            3: 'Queued to download',
            4: 'Downloading',
            5: 'Queued to seed',
            6: 'Seeding'
        };

        const response = await transmissionRequest({
            method: 'torrent-get',
            arguments: {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status', 'totalSize']
            }
        });

        if (response.result !== 'success') {
            throw new Error('Transmission error: ' + response.result);
        }

        return (response.arguments?.torrents || []).map(t => ({
            id: t.id,
            name: t.name,
            hash: t.hashString,
            labels: t.labels || [],
            completed: t.percentDone || 0,
            size: t.totalSize || 0,
            state: statusMap[t.status] || 'Unknown'
        }));
    }

    async function transmissionGetTorrent(hash) {
        const response = await transmissionRequest({
            method: 'torrent-get',
            arguments: {
                ids: [hash],
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status', 
                         'totalSize', 'downloadDir', 'files', 'trackers']
            }
        });

        if (response.result !== 'success') {
            throw new Error('Transmission error: ' + response.result);
        }

        return (response.arguments?.torrents || [])[0] || null;
    }

    async function transmissionSendTask(magnetUri, labels = [], downloadDir = '') {
        const args = {
            filename: magnetUri,
            labels: labels
        };
        
        if (downloadDir) {
            args['download-dir'] = downloadDir;
        }

        const response = await transmissionRequest({
            method: 'torrent-add',
            arguments: args
        });

        if (response.result !== 'success') {
            throw new Error('Transmission error: ' + response.result);
        }

        const added = response.arguments['torrent-added'] || response.arguments['torrent-duplicate'];
        
        if (added) {
            // Устанавливаем метки, если нужно
            if (labels.length > 0) {
                try {
                    await transmissionRequest({
                        method: 'torrent-set',
                        arguments: { ids: [added.id], labels: labels }
                    });
                } catch (e) {
                    log('Warning: could not set labels:', e);
                }
            }
            return added;
        }

        throw new Error('Торрент добавлен, но ID не получен');
    }

    async function transmissionSetLabels(torrentId, labels) {
        const labelList = Array.isArray(labels) ? labels : [labels];
        return transmissionRequest({
            method: 'torrent-set',
            arguments: { ids: [torrentId], labels: labelList }
        });
    }

    async function transmissionStart(hash) {
        return transmissionRequest({
            method: 'torrent-start',
            arguments: { ids: [hash] }
        });
    }

    // ==================== TORRSERVER API ====================

    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = getTorrServerUrl() + path;
            log('TorrServer request:', method, url);

            const network = new Lampa.Reguest();
            network.timeout(15000);

            const options = {
                type: method,
                dataType: 'text'
            };

            if (body && (method === 'POST' || method === 'PUT')) {
                options.headers = {
                    'Content-Type': 'application/json'
                };
            }

            network.quiet(
                url,
                (response) => {
                    try {
                        if (typeof response === 'string' && response.trim().startsWith('{')) {
                            response = JSON.parse(response);
                        }
                    } catch (e) {
                        // оставляем как есть
                    }
                    resolve(response);
                },
                (err) => {
                    reject(err);
                },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

    async function torrServerAdd(magnet, title) {
        return torrServerRequest('/torrents', 'POST', {
            action: 'add',
            link: magnet,
            title: title || '',
            poster: '',
            save_to_db: true
        });
    }

    async function torrServerGetFiles(hash) {
        try {
            const response = await torrServerRequest(`/torrents/${hash}/files`, 'GET');
            if (typeof response === 'string') {
                try { return JSON.parse(response); } catch (e) { return []; }
            }
            return response || [];
        } catch (e) {
            return [];
        }
    }

    function torrServerStreamUrl(hash, fileIndex = 0) {
        return `${getTorrServerUrl()}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    // ==================== TMDB ПАРСЕР ====================

    function cleanTorrentName(name) {
        if (!name) return { query: '', year: null };

        const regex = /^(.+?)(?:[.\s(](19\d{2}|20\d{2})[.\s)]|S\d{1,2}(?:E\d{1,2})?|[.\s](?:PPV.)?[HP]DTV|(?:HD)?TC|[cC]am|(?:HD)?CAM|B[rR]Rip|WEBRip|WEB-Rip|WEB-DL|WEB|TS|H[dD]Rip|DVDRip|[Bb]lu[Rr]ay|hdtv)/i;
        const match = name.match(regex);

        if (match && match[1]) {
            return {
                query: match[1].replace(/\./g, ' ').trim(),
                year: match[2] || null
            };
        }

        return { query: name.replace(/\./g, ' ').trim(), year: null };
    }

    async function searchTMDB(query) {
        const tmdbLang = Lampa.Storage.field('tmdb_lang') || 'ru';
        const url = Lampa.TMDB.api(
            `search/multi?include_adult=true&query=${encodeURIComponent(query)}&api_key=${Lampa.TMDB.key()}&language=${tmdbLang}`
        );

        return new Promise((resolve, reject) => {
            Lampa.Network.silent(url, resolve, reject, null, { timeout: 10000 });
        });
    }

    // ==================== ЛОГИКА ПЛАГИНА ====================

    function buildMetadataLabel(movie) {
        const mediaType = movie.first_air_date ? 'tv' : 'movie';
        return mediaType + '/' + movie.id;
    }

    function extractHashFromMagnet(magnet) {
        if (!magnet) return null;
        const match = magnet.match(/btih:([a-fA-F0-9]{40})/i);
        return match ? match[1].toLowerCase() : null;
    }

    /**
     * Поиск торрента в Transmission по метке фильма
     */
    async function findTorrentForMovie(movie) {
        if (!movie?.id) return null;

        const label = buildMetadataLabel(movie);
        const titleClean = (movie.title || movie.name || '')
            .toLowerCase()
            .replace(/[^a-zа-я0-9]/g, '');

        try {
            const torrents = await transmissionGetData();
            log('Total torrents in Transmission:', torrents.length);

            // 1. Ищем по метке
            let found = torrents.find(t => t.labels.includes(label));
            if (found) {
                log('Found by label:', found.name);
                return found;
            }

            // 2. Ищем по имени
            if (titleClean) {
                found = torrents.find(t => {
                    const name = (t.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
                    return name.includes(titleClean);
                });
                if (found) {
                    log('Found by name:', found.name);
                    return found;
                }
            }

            // 3. Показываем список для выбора
            if (torrents.length === 0) return null;

            return await new Promise((resolve) => {
                const items = torrents.map(t => ({
                    title: t.name,
                    subtitle: Math.round(t.completed * 100) + '% · ' + t.state,
                    torrent: t
                }));

                Lampa.Select.show({
                    title: 'Выберите торрент из Transmission',
                    items: items,
                    onSelect: (item) => resolve(item.torrent),
                    onBack: () => resolve(null)
                });
            });
        } catch (e) {
            error('findTorrentForMovie error:', e);
            return null;
        }
    }

    /**
     * Получение полной magnet-ссылки из Transmission торрента
     */
    async function getFullMagnet(torrent) {
        try {
            const full = await transmissionGetTorrent(torrent.hash);
            if (!full) {
                return `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(torrent.name)}`;
            }

            let magnet = `magnet:?xt=urn:btih:${full.hashString}`;
            magnet += `&dn=${encodeURIComponent(full.name)}`;

            const trackers = full.trackers || [];
            trackers.forEach(tr => {
                if (tr.announce) {
                    magnet += `&tr=${encodeURIComponent(tr.announce)}`;
                }
            });

            return magnet;
        } catch (e) {
            error('getFullMagnet error:', e);
            return `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(torrent.name)}`;
        }
    }

    // ==================== ВОСПРОИЗВЕДЕНИЕ ====================

    function playStream(url, title, poster = '') {
        log('Playing:', url);
        Lampa.Activity.loader(false);

        const playerType = getPlayerType();
        
        if (playerType === 'external') {
            window.open(url, '_blank');
            Lampa.Bell.push({ text: 'Открыто во внешнем плеере' });
        } else {
            Lampa.Player.play({
                url: url,
                title: title || 'Video',
                poster: poster || '',
                timeline: false
            });
        }
    }

    function isMediaFile(filename) {
        const exts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'm2ts', 'mts'];
        const ext = String(filename || '').split('.').pop().toLowerCase();
        return exts.includes(ext);
    }

    /**
     * Основная функция: воспроизведение торрента из Transmission через TorrServer
     */
    async function playFromTransmission(movie) {
        if (!movie?.id) {
            Lampa.Bell.push({ text: 'Нет данных фильма' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Поиск торрента в Transmission...' });

        try {
            // 1. Ищем торрент в Transmission
            const torrent = await findTorrentForMovie(movie);
            
            if (!torrent) {
                Lampa.Activity.loader(false);
                Lampa.Bell.push({ text: 'Торрент не найден. Сначала добавьте его в Transmission.' });
                return;
            }

            // 2. Проверяем, скачан ли он
            if (torrent.completed < 1) {
                Lampa.Activity.loader(false);
                const percent = Math.round(torrent.completed * 100);
                Lampa.Bell.push({ 
                    text: `Торрент скачан на ${percent}%. Дождитесь завершения или запустите TorrServer.` 
                });
                // Продолжаем — TorrServer может докачать
            }

            Lampa.Bell.push({ text: 'Получение magnet-ссылки...' });

            // 3. Получаем полную magnet-ссылку
            const magnet = await getFullMagnet(torrent);
            log('Magnet:', magnet.substring(0, 100) + '...');

            const hash = extractHashFromMagnet(magnet) || torrent.hash;
            if (!hash) {
                throw new Error('Не удалось извлечь хеш торрента');
            }

            // 4. Добавляем в TorrServer (он подключится к Transmission как пир через LPD/DHT)
            Lampa.Bell.push({ text: 'Подключение к TorrServer...' });
            try {
                await torrServerAdd(magnet, torrent.name);
            } catch (e) {
                log('TorrServer add warning (may already exist):', e);
            }

            // 5. Ждём метаданные
            Lampa.Bell.push({ text: 'Ожидание метаданных...' });
            
            let files = [];
            let attempts = 0;
            const maxAttempts = 10;
            
            while (attempts < maxAttempts && files.length === 0) {
                await new Promise(r => setTimeout(r, 1500));
                files = await torrServerGetFiles(hash);
                attempts++;
                log(`Attempt ${attempts}: files=${files.length}`);
            }

            const title = movie.title || movie.name || torrent.name;
            const poster = movie.poster || movie.img || '';

            // 6. Выбираем файл и запускаем
            if (!files || files.length === 0) {
                Lampa.Bell.push({ text: 'Запуск потока...' });
                playStream(torrServerStreamUrl(hash, 0), title, poster);
                return;
            }

            const mediaFiles = [];
            files.forEach((file, index) => {
                if (file && file.name && isMediaFile(file.name)) {
                    mediaFiles.push({ ...file, _index: index });
                }
            });

            if (mediaFiles.length === 0) {
                playStream(torrServerStreamUrl(hash, 0), title, poster);
                return;
            }

            if (mediaFiles.length === 1) {
                playStream(torrServerStreamUrl(hash, mediaFiles[0]._index), title, poster);
                return;
            }

            // Несколько файлов — показываем выбор
            Lampa.Activity.loader(false);
            
            const fileItems = mediaFiles.map(f => ({
                title: String(f.name).split('/').pop() || 'File',
                file: f,
                index: f._index
            }));

            Lampa.Select.show({
                title: 'Выберите файл',
                items: fileItems,
                onSelect: (item) => {
                    playStream(torrServerStreamUrl(hash, item.index), title, poster);
                },
                onBack: () => {
                    Lampa.Controller.toggle('content');
                }
            });

        } catch (e) {
            Lampa.Activity.loader(false);
            error('playFromTransmission error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + (e.message || 'не удалось запустить') });
        }
    }

    /**
     * Добавление торрента в Transmission через magnet
     * Используется, если у фильма есть magnet в данных
     */
    async function addMovieToTransmission(movie, magnetUri) {
        if (!magnetUri) {
            Lampa.Bell.push({ text: 'Magnet-ссылка не найдена' });
            return;
        }

        Lampa.Activity.loader(true);

        try {
            const label = buildMetadataLabel(movie);
            
            // Определяем путь сохранения
            const dtype = movie.first_air_date ? 'TV' : 'Movies';
            const downloadDir = Lampa.Storage.get(CONFIG_PREFIX + '_path_' + dtype, '');

            await transmissionSendTask(magnetUri, [label], downloadDir);
            
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ text: '✅ Торрент добавлен в Transmission' });

        } catch (e) {
            Lampa.Activity.loader(false);
            error('addMovieToTransmission error:', e);
            Lampa.Bell.push({ text: '❌ Ошибка: ' + (e.message || 'не удалось добавить') });
        }
    }

    // ==================== UI: КНОПКА В КАРТОЧКЕ ====================

    function createMainButton(label, onClick) {
        return $(`
            <div class="full-start__button selector button--torrent_bridge">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>${label}</span>
            </div>
        `).on('hover:enter', onClick);
    }

    function addMainButtons(movie) {
        currentMovie = movie;

        const container = $('.full-start-new__buttons');
        if (!container.length) return;

        // Удаляем старые кнопки
        container.find('.button--torrent_bridge, .button--torrent_bridge_add').remove();

        // Кнопка "Смотреть с сервера"
        const watchBtn = createMainButton('Смотреть с сервера', function () {
            playFromTransmission(movie);
        });

        // Кнопка "Скачать на сервер" — если есть magnet в данных фильма
        const magnet = movie.magnet || movie.torrent_magnet || movie.torrent || '';
        if (magnet) {
            const addBtn = createMainButton('Скачать на сервер', function () {
                addMovieToTransmission(movie, magnet);
            });
            container.append(addBtn);
        }

        container.append(watchBtn);
        log('Main buttons added');
    }

    // ==================== UI: ПУНКТ В МЕНЮ "СМОТРЕТЬ" ====================

    function hookSelectShow() {
        if (originalSelectShow) return;

        originalSelectShow = Lampa.Select.show;

        Lampa.Select.show = function (options) {
            const items = options.items ? [...options.items] : [];

            // Определяем меню "Смотреть"
            const hasTorrent = items.some(i => {
                const t = String(i.title || '').toLowerCase();
                return t.includes('торрент') || t.includes('torrent');
            });
            const hasOnline = items.some(i => {
                const t = String(i.title || '').toLowerCase();
                return t.includes('онлайн') || t.includes('online');
            });
            const hasTrailer = items.some(i => {
                const t = String(i.title || '').toLowerCase();
                return t.includes('трейлер') || t.includes('trailer');
            });

            const isWatchMenu = (hasTorrent && hasOnline) || (hasOnline && hasTrailer);
            const alreadyHas = items.some(i => i.action === 'torrentbridge_play');

            if (isWatchMenu && isEnabled() && !alreadyHas) {
                log('Watch menu detected, adding TorrentBridge');

                const bridgeItem = {
                    title: 'TorrentBridge',
                    subtitle: 'Воспроизвести из Transmission',
                    action: 'torrentbridge_play',
                    template: 'selectbox_icon',
                    separator: true,
                    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
                    onSelect: function () {
                        log('TorrentBridge selected from watch menu');
                        Lampa.Controller.toggle('content');
                        setTimeout(() => {
                            playFromTransmission(currentMovie);
                        }, 100);
                    }
                };

                // Вставляем перед "Трейлеры"
                const trailerIdx = items.findIndex(i => {
                    const t = String(i.title || '').toLowerCase();
                    return t.includes('трейлер') || t.includes('trailer');
                });

                if (trailerIdx !== -1) {
                    items.splice(trailerIdx, 0, bridgeItem);
                } else {
                    items.push(bridgeItem);
                }

                const originalOnSelect = options.onSelect;
                options.onSelect = function (item) {
                    if (item && item.action === 'torrentbridge_play') {
                        if (typeof item.onSelect === 'function') item.onSelect();
                        return;
                    }
                    if (typeof originalOnSelect === 'function') {
                        originalOnSelect(item);
                    }
                };

                options.items = items;
            }

            return originalSelectShow.call(this, options);
        };
    }

    // ==================== ТЕСТИРОВАНИЕ ====================

    async function testConnections() {
        Lampa.Activity.loader(true);
        const results = [];

        // TorrServer
        try {
            const r = await torrServerRequest('/echo', 'GET');
            const ok = r && String(r).includes('MatriX');
            results.push((ok ? '✅' : '⚠️') + ' TorrServer: ' + getTorrServerUrl());
        } catch (e) {
            results.push('❌ TorrServer: ' + (e.message || 'недоступен'));
        }

        // Transmission
        try {
            await transmissionAuth(false);
            const config = getTransmissionConfig();
            results.push('✅ Transmission: ' + config.url + config.path);
        } catch (e) {
            results.push('❌ Transmission: ' + (e.message || 'недоступен'));
        }

        Lampa.Activity.loader(false);

        Lampa.Select.show({
            title: 'Результаты проверки',
            items: results.map(r => ({ title: r })),
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    // ==================== НАСТРОЙКИ ====================

    function createSettings() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        // Включение
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_enabled',
                type: 'trigger',
                default: false,
                values: Lampa.Storage.get(CONFIG_PREFIX + '_enabled', false)
            },
            field: {
                name: 'Активировать плагин',
                description: 'Добавляет кнопки в карточку фильма и меню "Смотреть"'
            },
            onChange: (v) => {
                const enabled = v === true || v === 'true';
                Lampa.Storage.set(CONFIG_PREFIX + '_enabled', enabled);
                Lampa.Bell.push({ text: enabled ? '✅ TorrentBridge активирован' : '⛔ TorrentBridge деактивирован' });
                Lampa.Settings.update();
            }
        });

        // Плеер
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_player_type',
                type: 'select',
                default: 'internal',
                values: {
                    internal: 'Встроенный плеер Lampa',
                    external: 'Внешний (браузер)'
                }
            },
            field: { name: 'Выбор плеера' },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_player_type', v);
                Lampa.Settings.update();
            }
        });

        // === TorrServer ===
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_torrserver_url',
                type: 'input',
                default: 'http://192.168.1.101:8090',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_torrserver_url', 'http://192.168.1.101:8090')
            },
            field: {
                name: 'TorrServer URL',
                description: 'Адрес TorrServer (например http://192.168.1.101:8090)'
            },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_torrserver_url', String(v).trim());
                Lampa.Settings.update();
            }
        });

        // === Transmission ===
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_transmission_url',
                type: 'input',
                default: 'http://192.168.1.112:9091',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_url', 'http://192.168.1.112:9091')
            },
            field: {
                name: 'Transmission URL',
                description: 'Адрес Transmission (например http://192.168.1.112:9091)'
            },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_url', String(v).trim());
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_transmission_user',
                type: 'input',
                default: '',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_user', '')
            },
            field: { name: 'Transmission логин' },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_user', String(v || '').trim());
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_key', '');
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_transmission_pass',
                type: 'input',
                default: '',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_pass', '')
            },
            field: { name: 'Transmission пароль' },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_pass', String(v || ''));
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_key', '');
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_transmission_path',
                type: 'input',
                default: '/transmission/rpc',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_path', '/transmission/rpc')
            },
            field: {
                name: 'Transmission RPC путь',
                description: 'Обычно /transmission/rpc'
            },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_path', String(v || '/transmission/rpc').trim());
                Lampa.Settings.update();
            }
        });

        // Пути сохранения
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_path_Movies',
                type: 'input',
                default: '',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_path_Movies', '')
            },
            field: {
                name: 'Путь для фильмов',
                description: 'Путь на сервере Transmission для фильмов (опционально)'
            },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_path_Movies', String(v || '').trim());
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_path_TV',
                type: 'input',
                default: '',
                values: Lampa.Storage.get(CONFIG_PREFIX + '_path_TV', '')
            },
            field: {
                name: 'Путь для сериалов',
                description: 'Путь на сервере Transmission для сериалов (опционально)'
            },
            onChange: (v) => {
                Lampa.Storage.set(CONFIG_PREFIX + '_path_TV', String(v || '').trim());
                Lampa.Settings.update();
            }
        });

        // Кнопка проверки
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_test',
                type: 'button',
                default: false
            },
            field: {
                name: '🔌 Проверить подключения'
            },
            onChange: () => testConnections()
        });

        // Информация
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_info',
                type: 'static',
                default: ''
            },
            field: {
                name: 'Версия 6.0.0',
                description: 'Автономный плагин. Не требует TorrentManager.'
            }
        });
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================

    function init() {
        log('Init TorrentBridge v6.0.0');
        
        createSettings();
        Lampa.Manifest.plugins = MANIFEST;
        
        hookSelectShow();

        // Слушаем открытие карточки фильма
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                setTimeout(() => {
                    try {
                        const render = e.object.activity.render();
                        const movie = render.model || e.object.movie || e.object;
                        
                        if (movie?.id) {
                            if (isEnabled()) {
                                addMainButtons(movie);
                            }
                        }
                    } catch (err) {
                        error('Error in full handler:', err);
                    }
                }, 1000);
            }
        });

        log('TorrentBridge v6.0.0 initialized');
    }

    if (!window.plugin_torrentbridge_v6_ready) {
        window.plugin_torrentbridge_v6_ready = true;
        
        if (window.appready) {
            init();
        } else {
