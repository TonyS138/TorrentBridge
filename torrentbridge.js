/**
 * Torrent Bridge - финальная версия
 * Версия 4.1.0 - без ожидания, с локальным пиром
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '4.1.0',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    let transmissionSessionId = null;

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

    /**
     * Запрос к Transmission
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

    /**
     * API TorrServer
     */
    function torrServerAction(action, data = {}) {
        return new Promise((resolve, reject) => {
            const url = `${getTorrServerUrl()}/torrents`;
            const body = JSON.stringify({ action, ...data });
            
            log('TorrServer:', action);
            
            $.ajax({
                url: url,
                method: 'POST',
                data: body,
                contentType: 'application/json',
                dataType: 'text',
                timeout: 15000,
                success: resolve,
                error: function(xhr, status, error) {
                    log('TorrServer error:', status, error);
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

    /**
     * Запуск воспроизведения — БЕЗ ожидания
     */
    async function playByMagnet(magnet, title) {
        Lampa.Bell.push({ text: 'Добавление в TorrServer...' });

        try {
            await addToTorrServer(magnet, title);
            
            const hashMatch = magnet.match(/btih:([a-zA-Z0-9]+)/);
            const hash = hashMatch ? hashMatch[1] : '';
            
            if (!hash) throw new Error('No hash');

            const streamUrl = getStreamUrl(hash);
            log('Stream URL:', streamUrl);

            // Сразу запускаем — TorrServer сам начнёт буферизацию
            Lampa.Player.play({
                url: streamUrl,
                title: title || 'Torrent',
                timeline: false
            });
        } catch (e) {
            log('Play error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + e.message });
        }
    }

    /**
     * Поиск торрента в Transmission с полным magnet
     */
    async function findTorrent(movie) {
        const method = movie.first_air_date ? 'tv' : 'movie';
        const id = movie.id;
        const label = `${method}/${id}`;
        const title = (movie.title || movie.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');

        log('Search:', label, '|', title);

        try {
            const response = await transmissionRequest('torrent-get', {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status', 'trackers']
            });

            const torrents = response?.arguments?.torrents || [];
            log('Total:', torrents.length);

            // По метке
            let found = torrents.find(t => (t.labels || []).includes(label));
            if (found) {
                log('Found by label:', found.name);
                return found;
            }

            // По названию
            found = torrents.find(t => {
                const name = (t.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
                return title && name.includes(title);
            });
            
            if (found) {
                log('Found by name:', found.name);
                return found;
            }

            // Ручной выбор
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

    /**
     * Получение полного magnet из Transmission (с трекерами)
     */
    async function getFullMagnet(torrentId) {
        try {
            const response = await transmissionRequest('torrent-get', {
                ids: [torrentId],
                fields: ['hashString', 'name', 'trackers']
            });

            const torrent = response?.arguments?.torrents?.[0];
            if (!torrent) return null;

            // Формируем magnet с трекерами
            let magnet = `magnet:?xt=urn:btih:${torrent.hashString}`;
            magnet += `&dn=${encodeURIComponent(torrent.name)}`;
            
            // Добавляем трекеры
            const trackers = torrent.trackers || [];
            trackers.forEach(tr => {
                if (tr.announce) {
                    magnet += `&tr=${encodeURIComponent(tr.announce)}`;
                }
            });

            return magnet;
        } catch (e) {
            log('Get magnet error:', e);
            return null;
        }
    }

    /**
     * Добавление кнопки
     */
    async function addButton(movieData) {
        if (!isEnabled()) return;

        const movie = movieData.movie || movieData;
        if (!movie?.id) return;

        const $btn = $(`
            <div class="full-start__button selector button--torrent_bridge">
                <svg viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px">
                    <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Смотреть через TorrServer</span>
            </div>
        `);

        $btn.on('hover:enter', async function() {
            const torrent = await findTorrent(movie);
            if (!torrent?.hashString) {
                Lampa.Bell.push({ text: 'Торрент не найден' });
                return;
            }

            // Получаем полный magnet с трекерами
            const magnet = await getFullMagnet(torrent.id) || 
                `magnet:?xt=urn:btih:${torrent.hashString}&dn=${encodeURIComponent(torrent.name)}`;
            
            log('Magnet:', magnet.substring(0, 100) + '...');
            await playByMagnet(magnet, torrent.name);
        });

        const container = $('.full-start-new__buttons');
        if (container.length) {
            container.find('.button--torrent_bridge').remove();
            container.append($btn);
        }
    }

    async function testConnection() {
        try {
            const r = await $.ajax({
                url: `${getTorrServerUrl()}/echo`,
                method: 'GET',
                dataType: 'text',
                timeout: 5000
            });
            Lampa.Bell.push({ text: r?.includes('MatriX') ? '✅ TorrServer доступен' : '⚠️ TorrServer: ' + r });
        } catch (e) {
            Lampa.Bell.push({ text: '❌ TorrServer: ' + e.message });
        }

        try {
            await transmissionRequest('session-get', {});
            Lampa.Bell.push({ text: '✅ Transmission доступен' });
        } catch (e) {
            Lampa.Bell.push({ text: '❌ Transmission: ' + e.message });
        }
    }

    function createSettings() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

        const params = [
            { key: '_enabled', name: 'Активировать', type: 'trigger', def: false },
            { key: '_torrserver_url', name: 'TorrServer URL', type: 'input', def: 'http://192.168.1.101:8090' },
            { key: '_transmission_url', name: 'Transmission URL', type: 'input', def: 'http://192.168.1.112:9091' },
            { key: '_transmission_user', name: 'Transmission Login', type: 'input', def: 'admin' },
            { key: '_transmission_pass', name: 'Transmission Password', type: 'input', def: 'admin' },
            { key: '_transmission_path', name: 'Transmission Path', type: 'input', def: '/transmission/rpc' }
        ];

        params.forEach(p => {
            Lampa.SettingsApi.addParam({
                component: MANIFEST.component,
                param: {
                    name: MANIFEST.component + p.key,
                    type: p.type,
                    values: Lampa.Storage.get(MANIFEST.component + p.key, p.def),
                    default: false
                },
                field: { name: p.name },
                onChange: function(value) {
                    if (p.type === 'trigger') {
                        const enabled = value === true || value === 'true';
                        Lampa.Storage.set(MANIFEST.component + p.key, enabled === true);
                        Lampa.Bell.push({ text: enabled ? 'Активирован' : 'Деактивирован' });
                    } else {
                        Lampa.Storage.set(MANIFEST.component + p.key, value);
                    }
                    Lampa.Settings.update();
                }
            });
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: { name: MANIFEST.component + '_test', type: 'button' },
            field: { name: 'Проверить подключение' },
            onChange: testConnection
        });
    }

    function init() {
        log('Init v4.1');
        createSettings();
        Lampa.Manifest.plugins = MANIFEST;
        
        Lampa.Listener.follow('full', function(e) {
            if (e.type === 'complite') {
                setTimeout(() => addButton(e.object), 1000);
            }
        });
    }

    if (!window.plugin_torrentbridge_ready) {
        window.plugin_torrentbridge_ready = true;
        if (window.appready) init();
        else Lampa.Listener.follow('app', e => { if (e.type === 'ready') setTimeout(init, 500); });
    }
})();
