/**
 * Torrent Bridge v2.0 - интеграция с карточкой фильма
 * Позволяет скачивать торренты на сервер Transmission и смотреть их через TorrServer
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '2.0.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Download torrents to Transmission and watch via TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;
    let isInitialized = false;

    // ==================== ЛОГГИРОВАНИЕ ====================
    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function error(...args) {
        console.error('[TorrentBridge ERROR]', ...args);
    }

    // ==================== РАБОТА С НАСТРОЙКАМИ ====================
    function getTorrServerUrl() {
        // Пробуем получить из стандартного ключа Lampa
        let url = Lampa.Storage.get('torrserver_url', '');
        
        // Если пусто, пробуем другие возможные ключи
        if (!url || !String(url).trim()) {
            url = Lampa.Storage.get('torrserver_url_custom', '');
        }
        
        // Если все еще пусто, используем значение по умолчанию
        if (!url || !String(url).trim()) {
            url = 'http://192.168.1.101:8090';
            log('Using default TorrServer URL:', url);
        }
        
        // Нормализуем URL
        url = String(url).trim().replace(/\/+$/, '');
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }
        
        return url;
    }

    function getTransmissionConfig() {
        // Читаем настройки из TorrentManager
        const url = Lampa.Storage.get('lmetorrenttransmissionUrl', '');
        const user = Lampa.Storage.get('lmetorrenttransmissionUser', '');
        const pass = Lampa.Storage.get('lmetorrenttransmissionPass', '');
        const path = Lampa.Storage.get('lmetorrenttransmissionPath', '/transmission/rpc');
        
        // Если URL не задан, используем значение по умолчанию
        const finalUrl = String(url).trim() || 'http://192.168.1.112:9091';
        
        return {
            url: finalUrl.replace(/\/+$/, ''),
            user: String(user).trim(),
            pass: String(pass).trim(),
            path: path || '/transmission/rpc'
        };
    }

    function isPluginEnabled() {
        return Lampa.Storage.get(MANIFEST.component + '_enabled', true) === true;
    }

    function setPluginEnabled(value) {
        Lampa.Storage.set(MANIFEST.component + '_enabled', value === true);
    }

    // ==================== РАБОТА С TRANSMISSION ====================
    function transmissionRequest(method, args, retry = true) {
        return new Promise((resolve, reject) => {
            const config = getTransmissionConfig();
            
            log('Transmission request:', method, config.url + config.path);
            
            const headers = {
                'Content-Type': 'application/json'
            };

            if (config.user && config.pass) {
                headers['Authorization'] = 'Basic ' + btoa(config.user + ':' + config.pass);
            }

            if (transmissionSessionId) {
                headers['X-Transmission-Session-Id'] = transmissionSessionId;
            }

            const body = JSON.stringify({
                method: method,
                arguments: args
            });

            const network = new Lampa.Reguest();
            network.timeout(15000);

            network.quiet(
                config.url + config.path,
                (response) => {
                    try {
                        if (typeof response === 'string') {
                            response = JSON.parse(response);
                        }
                        if (response.result === 'success') {
                            resolve(response);
                        } else {
                            reject(new Error('Transmission error: ' + response.result));
                        }
                    } catch (e) {
                        reject(new Error('Invalid response from Transmission'));
                    }
                },
                (err) => {
                    // Обработка 409 - нужен Session ID
                    if (err && err.status === 409 && retry) {
                        // Пытаемся получить Session ID из заголовков
                        const xhr = err.xhr || err;
                        const sessionId = xhr.getResponseHeader ? 
                            xhr.getResponseHeader('X-Transmission-Session-Id') : 
                            null;
                        
                        if (sessionId) {
                            transmissionSessionId = sessionId;
                            log('Got Transmission Session ID:', sessionId);
                            // Повторяем запрос без retry
                            transmissionRequest(method, args, false)
                                .then(resolve)
                                .catch(reject);
                            return;
                        }
                    }
                    error('Transmission request failed:', err);
                    reject(err);
                },
                body,
                {
                    headers: headers,
                    type: 'POST'
                }
            );
        });
    }

    // Проверка подключения к Transmission
    async function testTransmissionConnection() {
        try {
            const response = await transmissionRequest('session-get', {});
            if (response && response.result === 'success') {
                return { success: true, message: 'Transmission доступен' };
            }
            return { success: false, message: 'Transmission вернул ошибку' };
        } catch (e) {
            return { success: false, message: 'Transmission недоступен: ' + (e.message || 'unknown') };
        }
    }

    // Получение всех торрентов
    async function getAllTorrents() {
        const response = await transmissionRequest('torrent-get', {
            fields: ['hashString', 'name', 'id', 'percentDone', 'status', 'leftUntilDone', 'totalSize']
        });

        if (response && response.arguments && response.arguments.torrents) {
            return response.arguments.torrents;
        }
        return [];
    }

    // Поиск торрента по хешу или имени
    async function findTorrent(hash, name) {
        try {
            const torrents = await getAllTorrents();
            if (!torrents || torrents.length === 0) return null;
            
            // Сначала ищем по хешу
            if (hash) {
                const found = torrents.find(t => t.hashString && t.hashString.toLowerCase() === hash.toLowerCase());
                if (found) return found;
            }
            
            // Затем по имени (частичное совпадение)
            if (name) {
                const nameLower = name.toLowerCase();
                const found = torrents.find(t => 
                    t.name && t.name.toLowerCase().includes(nameLower)
                );
                if (found) return found;
            }
            
            return null;
        } catch (e) {
            error('Error finding torrent:', e);
            return null;
        }
    }

    // Добавление торрента через Transmission
    async function addTorrent(magnetLink, downloadDir = null) {
        const args = {
            'filename': magnetLink
        };
        
        if (downloadDir) {
            args['download-dir'] = downloadDir;
        }
        
        const response = await transmissionRequest('torrent-add', args);
        return response;
    }

    // ==================== РАБОТА С TORRSERVER ====================
    function torrServerRequest(path, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = getTorrServerUrl() + path;
            log('TorrServer request:', method, url);

            const network = new Lampa.Reguest();
            network.timeout(10000);

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
                        // Пытаемся парсить как JSON
                        if (typeof response === 'string' && response.trim().startsWith('{')) {
                            response = JSON.parse(response);
                        }
                    } catch (e) {
                        // Оставляем как есть
                    }
                    resolve(response);
                },
                (err) => {
                    error('TorrServer error:', err);
                    reject(err);
                },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

    // Проверка подключения к TorrServer
    async function testTorrServerConnection() {
        try {
            const response = await torrServerRequest('/echo', 'GET');
            // TorrServer обычно отвечает чем-то вроде "MatriX"
            if (response && String(response).includes('MatriX')) {
                return { success: true, message: 'TorrServer доступен' };
            }
            return { success: true, message: 'TorrServer отвечает' };
        } catch (e) {
            return { success: false, message: 'TorrServer недоступен: ' + (e.message || 'unknown') };
        }
    }

    // Добавление торрента в TorrServer
    async function addToTorrServer(hash, title, poster = '') {
        log('Adding to TorrServer:', hash, title);
        
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        
        const response = await torrServerRequest('/torrents', 'POST', {
            link: magnet,
            title: title || 'Unknown',
            poster: poster || '',
            save_to: ''
        });

        log('TorrServer add response:', response);
        return response;
    }

    // Получение списка файлов из TorrServer
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
            log('Error getting files from TorrServer:', e);
            return [];
        }
    }

    // Получение URL для стрима
    function getStreamUrl(hash, fileIndex = 0) {
        const baseUrl = getTorrServerUrl();
        return `${baseUrl}/stream?link=${hash}&index=${fileIndex}&play=1`;
    }

    // Проверка, является ли файл медиа
    function isMediaFile(filename) {
        const mediaExtensions = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'm2ts', 'mts'];
        const ext = String(filename || '').split('.').pop().toLowerCase();
        return mediaExtensions.includes(ext);
    }

    // ==================== ВОСПРОИЗВЕДЕНИЕ ====================
    function playStream(streamUrl, title, poster = '') {
        log('Playing stream:', streamUrl);
        Lampa.Activity.loader(false);
        Lampa.Player.play({
            url: streamUrl,
            title: title || 'Video',
            poster: poster || '',
            timeline: false
        });
    }

    // Основная функция для запуска торрента с сервера
    async function playTorrentFromServer(hash, title, poster = '') {
        if (!hash) {
            Lampa.Bell.push({ text: 'Ошибка: нет хеша торрента' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

        try {
            // Проверяем, есть ли торрент в TorrServer
            const files = await getTorrServerFiles(hash);
            log('TorrServer files:', files);

            // Если файлов нет или ошибка, пытаемся добавить
            if (!files || files.length === 0) {
                Lampa.Bell.push({ text: 'Добавляем торрент в TorrServer...' });
                await addToTorrServer(hash, title, poster);
                
                // Ждем, пока TorrServer подготовит данные
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Пробуем получить файлы снова
                const filesRetry = await getTorrServerFiles(hash);
                if (filesRetry && filesRetry.length > 0) {
                    return playFilesFromTorrServer(hash, title, poster, filesRetry);
                }
            }

            if (files && files.length > 0) {
                return playFilesFromTorrServer(hash, title, poster, files);
            }

            // Если не удалось получить файлы, пробуем стримить первый файл
            Lampa.Bell.push({ text: 'Запуск потока...' });
            const streamUrl = getStreamUrl(hash, 0);
            playStream(streamUrl, title, poster);

        } catch (e) {
            error('Error playing torrent:', e);
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ 
                text: 'Ошибка: ' + (e.message || 'Не удалось запустить торрент') 
            });
        }
    }

    function playFilesFromTorrServer(hash, title, poster, files) {
        // Ищем медиа-файлы
        const mediaFiles = [];
        files.forEach((file, index) => {
            if (file && file.name && isMediaFile(file.name)) {
                mediaFiles.push({ ...file, _index: index });
            }
        });

        log('Media files found:', mediaFiles.length);

        if (mediaFiles.length === 0) {
            // Если медиа-файлов нет, пробуем первый файл
            Lampa.Bell.push({ text: 'Запуск потока...' });
            const streamUrl = getStreamUrl(hash, 0);
            playStream(streamUrl, title, poster);
            return;
        }

        if (mediaFiles.length === 1) {
            const streamUrl = getStreamUrl(hash, mediaFiles[0]._index);
            playStream(streamUrl, title, poster);
            return;
        }

        // Несколько медиа-файлов - показываем выбор
        Lampa.Activity.loader(false);
        
        const fileItems = mediaFiles.map((file) => ({
            title: String(file.name).split('/').pop() || 'File',
            file: file,
            index: file._index
        }));

        Lampa.Select.show({
            title: 'Выберите файл для просмотра',
            items: fileItems,
            onSelect: (item) => {
                const streamUrl = getStreamUrl(hash, item.index);
                playStream(streamUrl, title, poster);
            },
            onBack: () => {
                Lampa.Controller.toggle('content');
            }
        });
    }

    // ==================== ТЕСТИРОВАНИЕ ПОДКЛЮЧЕНИЯ ====================
    async function testAllConnections() {
        Lampa.Activity.loader(true);
        
        let results = [];
        
        // Тестируем TorrServer
        const tsResult = await testTorrServerConnection();
        results.push('TorrServer: ' + (tsResult.success ? '✅' : '❌') + ' ' + tsResult.message);
        
        // Тестируем Transmission
        const trResult = await testTransmissionConnection();
        results.push('Transmission: ' + (trResult.success ? '✅' : '❌') + ' ' + trResult.message);
        
        Lampa.Activity.loader(false);
        
        // Показываем результат
        const message = results.join('\n');
        Lampa.Bell.push({ 
            text: message,
            time: 5000
        });
        
        // Дополнительно показываем через Select для длинного текста
        Lampa.Select.show({
            title: 'Результаты проверки подключений',
            items: results.map(r => ({ title: r })),
            onBack: () => {
                Lampa.Controller.toggle('content');
            }
        });
    }

    // ==================== ДОБАВЛЕНИЕ КНОПОК В КАРТОЧКУ ====================
    function addButtonsToCard() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                const render = e.object.activity.render();
                const cardData = render.model;
                
                if (!cardData) return;
                
                // Проверяем, есть ли магнет-ссылка или хеш
                const magnet = cardData.magnet || cardData.torrent_magnet || cardData.torrent || '';
                const hash = cardData.torrent_hash || cardData.hash || '';
                
                // Если нет данных для торрента - не добавляем кнопки
                if (!magnet && !hash) {
                    log('No torrent data in card');
                    return;
                }
                
                log('Card data:', { magnet, hash, title: cardData.title });
                
                // --- Кнопка "Скачать на сервер" ---
                const downloadButton = $(`
                    <div class="full-start__button view--download-to-server" data-action="download">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24px" height="24px">
                            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
                        </svg>
                        <span>Скачать на сервер</span>
                    </div>
                `);

                // --- Кнопка "Смотреть с сервера" ---
                const watchButton = $(`
                    <div class="full-start__button view--watch-from-server" data-action="watch" style="display: none;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24px" height="24px">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" fill="currentColor"/>
                        </svg>
                        <span>Смотреть с сервера</span>
                    </div>
                `);

                // Добавляем кнопки в контейнер
                const container = render.find('.full-start__actions');
                if (container.length) {
                    // Проверяем, не добавлены ли уже
                    if (container.find('.view--download-to-server').length === 0) {
                        container.append(downloadButton);
                        container.append(watchButton);
                    }
                }

                // --- Логика для кнопки "Скачать на сервер" ---
                downloadButton.on('hover:enter', function() {
                    const magnetLink = cardData.magnet || cardData.torrent_magnet || cardData.torrent;
                    if (magnetLink) {
                        Lampa.Activity.loader(true);
                        addTorrent(magnetLink)
                            .then(() => {
                                Lampa.Activity.loader(false);
                                Lampa.Bell.push({ text: '✅ Торрент добавлен в Transmission' });
                                // Проверяем статус через 5 секунд
                                setTimeout(() => checkTorrentStatus(hash, cardData.title, watchButton), 5000);
                            })
                            .catch((err) => {
                                Lampa.Activity.loader(false);
                                error('Error adding torrent:', err);
                                Lampa.Bell.push({ text: '❌ Ошибка добавления: ' + (err.message || 'unknown') });
                            });
                    } else {
                        Lampa.Bell.push({ text: '❌ Магнет-ссылка не найдена' });
                    }
                });

                // --- Логика для кнопки "Смотреть с сервера" ---
                watchButton.on('hover:enter', function() {
                    const torrentHash = cardData.torrent_hash || cardData.hash || hash;
                    const title = cardData.title || cardData.name || 'Фильм';
                    const poster = cardData.poster || cardData.img || '';
                    
                    if (torrentHash) {
                        playTorrentFromServer(torrentHash, title, poster);
                    } else {
                        Lampa.Bell.push({ text: '❌ Хеш торрента не найден' });
                    }
                });

                // --- Проверка статуса при открытии карточки ---
                if (hash || magnet) {
                    const searchHash = hash || extractHashFromMagnet(magnet);
                    if (searchHash) {
                        checkTorrentStatus(searchHash, cardData.title, watchButton);
                    }
                }
            }
        });
    }

    // Вспомогательная функция для извлечения хеша из магнет-ссылки
    function extractHashFromMagnet(magnet) {
        if (!magnet) return null;
        const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
        return match ? match[1] : null;
    }

    // Проверка статуса торрента и отображение кнопки
    async function checkTorrentStatus(hash, title, watchButton) {
        if (!hash) return;
        
        try {
            const torrent = await findTorrent(hash, title);
            if (torrent) {
                log('Found torrent:', torrent.name, 'status:', torrent.status);
                // Статус 3 = seeding, 4 = completed
                if (torrent.status === 3 || torrent.status === 4) {
                    watchButton.css('display', '');
                    watchButton.data('torrent', torrent);
                } else if (torrent.status === 2) {
                    // Скачивается - показываем кнопку с прогрессом
                    const progress = torrent.percentDone ? Math.round(torrent.percentDone * 100) : 0;
                    watchButton.find('span').text(`Скачивается (${progress}%)`);
                    watchButton.css('display', '');
                    watchButton.data('torrent', torrent);
                } else {
                    watchButton.css('display', 'none');
                }
            } else {
                watchButton.css('display', 'none');
            }
        } catch (e) {
            error('Error checking torrent status:', e);
            watchButton.css('display', 'none');
        }
    }

    // ==================== НАСТРОЙКИ ====================
    function createSettingsMenu() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        // Включение/выключение плагина
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_enabled',
                type: 'trigger',
                default: true
            },
            field: {
                name: 'Активировать плагин',
                description: 'Добавляет кнопки в карточку фильма'
            },
            onChange: function(value) {
                const enabled = value === true || value === 'true';
                setPluginEnabled(enabled);
                log('Plugin ' + (enabled ? 'enabled' : 'disabled'));
                Lampa.Bell.push({ text: 'Torrent Bridge ' + (enabled ? 'активирован' : 'деактивирован') });
                Lampa.Settings.update();
            }
        });

        // Кнопка проверки подключения
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_test',
                type: 'button'
            },
            field: {
                name: '🔌 Проверить подключения',
                description: 'Тестирует связь с TorrServer и Transmission'
            },
            onChange: function() {
                testAllConnections();
            }
        });

        // Информация о текущих настройках
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: MANIFEST.component + '_info',
                type: 'string'
            },
            field: {
                name: 'Текущие настройки',
                description: function() {
                    const tsUrl = getTorrServerUrl();
                    const trConfig = getTransmissionConfig();
                    return `TorrServer: ${tsUrl}\nTransmission: ${trConfig.url}${trConfig.path}`;
                }
            }
        });
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================
    function init() {
        if (isInitialized) return;
        
        log('Initializing Torrent Bridge v2.0...');
        
        // Регистрируем манифест
        Lampa.Manifest.plugins = MANIFEST;
        
        // Создаем меню в настройках
        createSettingsMenu();
        
        // Добавляем кнопки в карточку фильма
        if (isPluginEnabled()) {
            addButtonsToCard();
        }
        
        isInitialized = true;
        log('Torrent Bridge initialized successfully');
    }

    // Запуск плагина
    if (!window.plugin_torrentbridge_v2_ready) {
        window.plugin_torrentbridge_v2_ready = true;
        
        if (window.appready) {
            setTimeout(init, 1000);
        } else {
            Lampa.Listener.follow('app', (e) => {
                if (e.type === 'ready') {
                    setTimeout(init, 1000);
                }
            });
        }
    }

})();
