/**
 * Torrent Bridge v2.1 - Кнопка в карточке фильма для воспроизведения через TorrServer
 * Аналог кнопки "Раздача - 100%" из TorrentManager
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '2.1.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        description: 'Watch downloaded torrents via TorrServer',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;
    let isInitialized = false;
    let buttonCheckInterval = null;

    // ==================== ЛОГГИРОВАНИЕ ====================
    function log(...args) {
        console.log('[TorrentBridge]', ...args);
    }

    function error(...args) {
        console.error('[TorrentBridge ERROR]', ...args);
    }

    // ==================== РАБОТА С НАСТРОЙКАМИ ====================
    function getTorrServerUrl() {
        // Читаем из настроек Lampa (раздел TorrServer)
        let url = Lampa.Storage.get('torrserver_url', '');
        
        if (!url || !String(url).trim()) {
            // Пробуем другие возможные ключи
            url = Lampa.Storage.get('torrserver_url_custom', '');
        }
        
        if (!url || !String(url).trim()) {
            // Значение по умолчанию
            url = 'http://192.168.1.101:8090';
        }
        
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
        
        const finalUrl = String(url).trim() || 'http://192.168.1.112:9091';
        
        return {
            url: finalUrl.replace(/\/+$/, ''),
            user: String(user).trim(),
            pass: String(pass).trim(),
            path: path || '/transmission/rpc'
        };
    }

    function isPluginEnabled() {
        const value = Lampa.Storage.get(MANIFEST.component + '_enabled');
        return value === true || value === 'true';
    }

    function setPluginEnabled(value) {
        Lampa.Storage.set(MANIFEST.component + '_enabled', value === true);
    }

    // ==================== РАБОТА С TRANSMISSION ====================
    function transmissionRequest(method, args, retry = true) {
        return new Promise((resolve, reject) => {
            const config = getTransmissionConfig();
            
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
                    if (err && err.status === 409 && retry) {
                        const xhr = err.xhr || err;
                        const sessionId = xhr.getResponseHeader ? 
                            xhr.getResponseHeader('X-Transmission-Session-Id') : 
                            null;
                        
                        if (sessionId) {
                            transmissionSessionId = sessionId;
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

    // Получение всех торрентов
    async function getAllTorrents() {
        try {
            const response = await transmissionRequest('torrent-get', {
                fields: ['hashString', 'name', 'id', 'percentDone', 'status', 'leftUntilDone', 'totalSize']
            });

            if (response && response.arguments && response.arguments.torrents) {
                return response.arguments.torrents;
            }
            return [];
        } catch (e) {
            error('Error getting torrents:', e);
            return [];
        }
    }

    // Поиск торрента по хешу или имени
    async function findTorrent(hash, name) {
        try {
            const torrents = await getAllTorrents();
            if (!torrents || torrents.length === 0) return null;
            
            // Сначала ищем по хешу
            if (hash) {
                const hashLower = hash.toLowerCase();
                const found = torrents.find(t => 
                    t.hashString && t.hashString.toLowerCase() === hashLower
                );
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

    // Добавление торрента в TorrServer
    async function addToTorrServer(hash, title, poster = '') {
        log('Adding to TorrServer:', hash, title);
        
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        
        try {
            const response = await torrServerRequest('/torrents', 'POST', {
                link: magnet,
                title: title || 'Unknown',
                poster: poster || '',
                save_to: ''
            });
            log('TorrServer add response:', response);
            return response;
        } catch (e) {
            error('Error adding to TorrServer:', e);
            throw e;
        }
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
            let files = await getTorrServerFiles(hash);
            log('TorrServer files:', files);

            // Если файлов нет, добавляем торрент
            if (!files || files.length === 0) {
                Lampa.Bell.push({ text: 'Добавляем торрент в TorrServer...' });
                await addToTorrServer(hash, title, poster);
                
                // Ждем, пока TorrServer подготовит данные
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Пробуем получить файлы снова
                files = await getTorrServerFiles(hash);
            }

            if (files && files.length > 0) {
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
            } else {
                // Если не удалось получить файлы, пробуем стримить
                Lampa.Bell.push({ text: 'Запуск потока...' });
                const streamUrl = getStreamUrl(hash, 0);
                playStream(streamUrl, title, poster);
            }

        } catch (e) {
            error('Error playing torrent:', e);
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ 
                text: 'Ошибка: ' + (e.message || 'Не удалось запустить торрент') 
            });
        }
    }

    // ==================== КНОПКА В КАРТОЧКЕ ФИЛЬМА ====================
    function addWatchButtonToCard() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                const render = e.object.activity.render();
                const cardData = render.model;
                
                if (!cardData || !isPluginEnabled()) return;
                
                // Получаем хеш и название
                const hash = cardData.torrent_hash || cardData.hash || '';
                const title = cardData.title || cardData.name || '';
                
                if (!hash && !title) {
                    log('No torrent data in card');
                    return;
                }
                
                log('Card data:', { hash, title });
                
                // Создаем кнопку (аналог "Раздача - 100%")
                const watchButton = $(`
                    <div class="full-start__button view--torrserver-watch" style="display: none;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24px" height="24px">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" fill="currentColor"/>
                        </svg>
                        <span>Смотреть с сервера</span>
                    </div>
                `);

                // Добавляем кнопку в контейнер
                const container = render.find('.full-start__actions');
                if (container.length) {
                    // Проверяем, не добавлена ли уже
                    if (container.find('.view--torrserver-watch').length === 0) {
                        container.append(watchButton);
                    }
                }

                // Логика для кнопки
                watchButton.on('hover:enter', function() {
                    const torrentHash = cardData.torrent_hash || cardData.hash || hash;
                    const movieTitle = cardData.title || cardData.name || 'Фильм';
                    const poster = cardData.poster || cardData.img || '';
                    
                    if (torrentHash) {
                        playTorrentFromServer(torrentHash, movieTitle, poster);
                    } else {
                        Lampa.Bell.push({ text: '❌ Хеш торрента не найден' });
                    }
                });

                // Проверяем статус торрента и показываем кнопку
                const checkStatus = async () => {
                    try {
                        const torrent = await findTorrent(hash, title);
                        if (torrent) {
                            log('Found torrent:', torrent.name, 'status:', torrent.status);
                            // Статус 3 = seeding, 4 = completed
                            if (torrent.status === 3 || torrent.status === 4) {
                                watchButton.css('display', '');
                                watchButton.find('span').text('Смотреть с сервера');
                            } else if (torrent.status === 2) {
                                // Скачивается
                                const progress = torrent.percentDone ? Math.round(torrent.percentDone * 100) : 0;
                                watchButton.css('display', '');
                                watchButton.find('span').text(`Скачивается (${progress}%)`);
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
                };

                // Проверяем сразу
                checkStatus();
                
                // И периодически обновляем статус (каждые 30 секунд)
                if (buttonCheckInterval) {
                    clearInterval(buttonCheckInterval);
                }
                buttonCheckInterval = setInterval(checkStatus, 30000);
            }
        });
    }

    // ==================== ТЕСТИРОВАНИЕ ПОДКЛЮЧЕНИЯ ====================
    async function testAllConnections() {
        Lampa.Activity.loader(true);
        
        let results = [];
        let hasError = false;
        
        // Тестируем TorrServer
        try {
            const tsUrl = getTorrServerUrl();
            const response = await torrServerRequest('/echo', 'GET');
            if (response && String(response).includes('MatriX')) {
                results.push('✅ TorrServer доступен (' + tsUrl + ')');
            } else {
                results.push('⚠️ TorrServer ответил, но неожиданно: ' + String(response).substring(0, 50));
            }
        } catch (e) {
            hasError = true;
            results.push('❌ TorrServer недоступен: ' + (e.message || 'unknown'));
        }
        
        // Тестируем Transmission
        try {
            const config = getTransmissionConfig();
            const response = await transmissionRequest('session-get', {});
            if (response && response.result === 'success') {
                results.push('✅ Transmission доступен (' + config.url + ')');
            } else {
                results.push('⚠️ Transmission вернул ошибку');
            }
        } catch (e) {
            hasError = true;
            results.push('❌ Transmission недоступен: ' + (e.message || 'unknown'));
        }
        
        Lampa.Activity.loader(false);
        
        // Показываем результат
        const message = results.join('\n');
        Lampa.Bell.push({ 
            text: message,
            time: 5000
        });
        
        // Дополнительно показываем через Select для длинного текста
        Lampa.Select.show({
            title: hasError ? '⚠️ Есть проблемы с подключением' : '✅ Все подключения работают',
            items: results.map(r => ({ title: r })),
            onBack: () => {
                Lampa.Controller.toggle('content');
            }
        });
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
                description: 'Добавляет кнопку "Смотреть с сервера" в карточку фильма'
            },
            onChange: function(value) {
                const enabled = value === true || value === 'true';
                setPluginEnabled(enabled);
                log('Plugin ' + (enabled ? 'enabled' : 'disabled'));
                Lampa.Bell.push({ text: 'Torrent Bridge ' + (enabled ? 'активирован' : 'деактивирован') });
                Lampa.Settings.update();
                
                // Если отключаем, очищаем интервал
                if (!enabled && buttonCheckInterval) {
                    clearInterval(buttonCheckInterval);
                    buttonCheckInterval = null;
                }
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

        // Информация о настройках
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
        
        log('Initializing Torrent Bridge v2.1...');
        
        // Регистрируем манифест
        Lampa.Manifest.plugins = MANIFEST;
        
        // Создаем меню в настройках
        createSettingsMenu();
        
        // Добавляем кнопку в карточку фильма
        if (isPluginEnabled()) {
            addWatchButtonToCard();
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
