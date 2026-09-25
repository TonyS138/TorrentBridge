/**
 * Torrent Bridge - v6.3.2
 * + Диагностика подключений (для отладки на Android)
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '6.3.2',
        author: 'Torrent Bridge',
        name: 'Torrent Bridge',
        component: 'torrentbridge',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    const CONFIG_PREFIX = 'torrentbridge';
    let currentMovie = null;
    let statusCheckTimer = null;

    // ==================== СТИЛИ ====================

    const STYLES = `
        <style id="torrentbridge-styles">
            .button--torrent_bridge {
                position: relative;
                overflow: visible !important;
            }

            .button--torrent_bridge .tb-icon-wrap {
                position: relative;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .button--torrent_bridge .tb-ring {
                position: absolute;
                top: 0;
                left: 0;
                width: 32px;
                height: 32px;
                transform: rotate(-90deg);
                pointer-events: none;
            }

            .button--torrent_bridge .tb-ring circle {
                fill: none;
                stroke-width: 2.5;
                stroke-linecap: round;
            }

            .button--torrent_bridge .tb-ring .tb-ring-bg {
                stroke: rgba(255,255,255,0.15);
            }

            .button--torrent_bridge .tb-ring .tb-ring-fill {
                stroke: #4ade80;
                stroke-dasharray: 88;
                stroke-dashoffset: 88;
                transition: stroke-dashoffset 0.6s ease, stroke 0.3s ease;
            }

            .button--torrent_bridge .tb-ring-fill.is-low    { stroke: #f87171; }
            .button--torrent_bridge .tb-ring-fill.is-mid    { stroke: #fbbf24; }
            .button--torrent_bridge .tb-ring-fill.is-high   { stroke: #4ade80; }

            .button--torrent_bridge .tb-icon {
                width: 18px;
                height: 18px;
                fill: currentColor;
                z-index: 1;
            }

            .button--torrent_bridge .tb-label {
                display: inline-flex;
                align-items: baseline;
                gap: 6px;
            }

            .button--torrent_bridge .tb-percent {
                font-size: 0.85em;
                opacity: 0.75;
                font-variant-numeric: tabular-nums;
                transition: color 0.3s ease, opacity 0.3s ease;
            }

            .button--torrent_bridge .tb-percent.is-downloading { opacity: 1; color: #fbbf24; }
            .button--torrent_bridge .tb-percent.is-seeding     { opacity: 1; color: #4ade80; }
            .button--torrent_bridge .tb-percent.is-paused      { opacity: 0.7; color: #94a3b8; }

            .button--torrent_bridge.is-active .tb-icon-wrap {
                animation: tb-pulse 2s ease-in-out infinite;
            }

            @keyframes tb-pulse {
                0%, 100% { transform: scale(1); }
                50%      { transform: scale(1.08); }
            }

            /* Диагностический отчёт */
            .tb-diag {
                padding: 1.2em;
                font-family: monospace;
                font-size: 0.9em;
                line-height: 1.5;
                max-height: 60vh;
                overflow-y: auto;
                background: rgba(0,0,0,0.3);
                border-radius: 6px;
            }

            .tb-diag__section {
                margin-bottom: 1.2em;
                padding-bottom: 1em;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }

            .tb-diag__section:last-child {
                border-bottom: none;
                margin-bottom: 0;
            }

            .tb-diag__title {
                font-weight: bold;
                font-size: 1.05em;
                margin-bottom: 0.6em;
                color: #fff;
            }

            .tb-diag__row {
                display: flex;
                gap: 0.6em;
                margin-bottom: 0.35em;
                flex-wrap: wrap;
            }

            .tb-diag__key {
                opacity: 0.65;
                min-width: 9em;
            }

            .tb-diag__value {
                flex: 1;
                word-break: break-all;
            }

            .tb-diag__ok    { color: #4ade80; }
            .tb-diag__warn  { color: #fbbf24; }
            .tb-diag__err   { color: #f87171; }
            .tb-diag__info  { color: #93c5fd; }

            .tb-diag__hint {
                margin-top: 0.8em;
                padding: 0.8em;
                background: rgba(147, 197, 253, 0.1);
                border-left: 3px solid #93c5fd;
                border-radius: 4px;
                line-height: 1.5;
            }
        </style>
    `;

    // ==================== ЛОГИРОВАНИЕ ====================

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[TorrentBridge]');
        console.log.apply(console, args);
    }

    function error() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[TorrentBridge ERROR]');
        console.error.apply(console, args);
    }

    // ==================== ЛОАДЕР ====================

    function showLoader() {
        try {
            if (Lampa.Loading && typeof Lampa.Loading.start === 'function') {
                Lampa.Loading.start(function () {});
                return;
            }
        } catch (e) {}
        try {
            if (Lampa.Activity && typeof Lampa.Activity.loader === 'function') {
                Lampa.Activity.loader(true);
                return;
            }
        } catch (e) {}
        try { $('.activity__loader').addClass('active'); } catch (e) {}
    }

    function hideLoader() {
        try {
            if (Lampa.Loading && typeof Lampa.Loading.stop === 'function') {
                Lampa.Loading.stop();
                return;
            }
        } catch (e) {}
        try {
            if (Lampa.Activity && typeof Lampa.Activity.loader === 'function') {
                Lampa.Activity.loader(false);
                return;
            }
        } catch (e) {}
        try { $('.activity__loader').removeClass('active'); } catch (e) {}
    }

    // ==================== КОНФИГ ====================

    function isEnabled() {
        return Lampa.Storage.get(CONFIG_PREFIX + '_enabled', false) === true;
    }

    function getTorrServerUrl() {
        var url = Lampa.Storage.get(CONFIG_PREFIX + '_torrserver_url', 'http://192.168.1.101:8090');
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
        var url = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_url', 'http://192.168.1.112:9091');
        url = String(url).trim().replace(/\/+$/, '');
        return {
            url: url,
            user: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_user', ''),
            pass: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_pass', ''),
            path: Lampa.Storage.get(CONFIG_PREFIX + '_transmission_path', '/transmission/rpc')
        };
    }

    // ==================== TRANSMISSION API ====================

    function transmissionRequest(data, retry) {
        if (typeof retry === 'undefined') retry = true;

        return new Promise(function (resolve, reject) {
            var config = getTransmissionConfig();
            if (!config.url) {
                reject(new Error('Transmission URL не настроен'));
                return;
            }

            var url = config.url + config.path;
            var headers = { 'Content-Type': 'application/json' };

            if (config.user || config.pass) {
                headers['Authorization'] = 'Basic ' + btoa(config.user + ':' + config.pass);
            }

            var sessionId = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_key');
            if (sessionId) {
                headers['X-Transmission-Session-Id'] = sessionId;
            }

            var network = new Lampa.Reguest();
            network.timeout(10000);

            network.quiet(
                url,
                function (response) {
                    if (typeof response === 'string') {
                        try { response = JSON.parse(response); }
                        catch (e) { reject(new Error('Ошибка парсинга ответа Transmission')); return; }
                    }
                    resolve(response);
                },
                function (err) {
                    if (err && err.status === 409 && retry) {
                        var newSessionId = err.getResponseHeader
                            ? err.getResponseHeader('X-Transmission-Session-Id')
                            : null;
                        if (newSessionId) {
                            Lampa.Storage.set(CONFIG_PREFIX + '_transmission_key', newSessionId);
                            transmissionRequest(data, false).then(resolve).catch(reject);
                            return;
                        }
                    }
                    reject(err);
                },
                JSON.stringify(data),
                { headers: headers, type: 'POST', dataType: 'json' }
            );
        });
    }

    function transmissionAuth(showNotification) {
        if (typeof showNotification === 'undefined') showNotification = true;
        return transmissionRequest({ method: 'session-get' }).then(function () {
            if (showNotification) Lampa.Bell.push({ text: '✅ Transmission доступен' });
            return true;
        }).catch(function (e) {
            error('Transmission auth error:', e);
            if (showNotification) Lampa.Bell.push({ text: '❌ Transmission: ' + (e.message || 'ошибка') });
            throw e;
        });
    }

    function transmissionGetData() {
        var statusMap = {
            0: 'Stopped', 1: 'Queued to verify', 2: 'Verifying',
            3: 'Queued to download', 4: 'Downloading',
            5: 'Queued to seed', 6: 'Seeding'
        };

        return transmissionRequest({
            method: 'torrent-get',
            arguments: {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status', 'totalSize']
            }
        }).then(function (response) {
            if (response.result !== 'success') throw new Error('Transmission error: ' + response.result);
            return (response.arguments && response.arguments.torrents || []).map(function (t) {
                return {
                    id: t.id,
                    name: t.name,
                    hash: t.hashString,
                    labels: t.labels || [],
                    completed: t.percentDone || 0,
                    size: t.totalSize || 0,
                    state: statusMap[t.status] || 'Unknown'
                };
            });
        });
    }

    function transmissionGetTorrent(hash) {
        return transmissionRequest({
            method: 'torrent-get',
            arguments: {
                ids: [hash],
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status',
                    'totalSize', 'downloadDir', 'files', 'trackers']
            }
        }).then(function (response) {
            if (response.result !== 'success') throw new Error('Transmission error: ' + response.result);
            return (response.arguments && response.arguments.torrents || [])[0] || null;
        });
    }

    function transmissionSendTask(magnetUri, labels, downloadDir) {
        if (!labels) labels = [];
        if (!downloadDir) downloadDir = '';

        var args = { filename: magnetUri, labels: labels };
        if (downloadDir) args['download-dir'] = downloadDir;

        return transmissionRequest({
            method: 'torrent-add',
            arguments: args
        }).then(function (response) {
            if (response.result !== 'success') throw new Error('Transmission error: ' + response.result);

            var added = response.arguments['torrent-added'] || response.arguments['torrent-duplicate'];
            if (!added) throw new Error('Торрент добавлен, но ID не получен');

            if (labels.length > 0) {
                return transmissionRequest({
                    method: 'torrent-set',
                    arguments: { ids: [added.id], labels: labels }
                }).catch(function (e) {
                    log('Warning: could not set labels:', e);
                }).then(function () { return added; });
            }
            return added;
        });
    }

    // ==================== TORRSERVER API ====================

    function torrServerRequest(path, method, body) {
        if (!method) method = 'GET';
        return new Promise(function (resolve, reject) {
            var url = getTorrServerUrl() + path;
            var network = new Lampa.Reguest();
            network.timeout(15000);

            var options = { type: method, dataType: 'text' };
            if (body && (method === 'POST' || method === 'PUT')) {
                options.headers = { 'Content-Type': 'application/json' };
            }

            network.quiet(
                url,
                function (response) {
                    try {
                        if (typeof response === 'string' && response.trim().startsWith('{')) {
                            response = JSON.parse(response);
                        }
                    } catch (e) {}
                    resolve(response);
                },
                function (err) { reject(err); },
                body ? JSON.stringify(body) : null,
                options
            );
        });
    }

    function torrServerAdd(magnet, title) {
        return torrServerRequest('/torrents', 'POST', {
            action: 'add',
            link: magnet,
            title: title || '',
            poster: '',
            save_to_db: true
        });
    }

    function torrServerGetFiles(hash) {
        return torrServerRequest('/torrents/' + hash + '/files', 'GET')
            .then(function (response) {
                if (typeof response === 'string') {
                    try { return JSON.parse(response); } catch (e) { return []; }
                }
                return response || [];
            })
            .catch(function () { return []; });
    }

    function torrServerStreamUrl(hash, fileIndex) {
        if (!fileIndex) fileIndex = 0;
        return getTorrServerUrl() + '/stream?link=' + hash + '&index=' + fileIndex + '&play=1';
    }

    // ==================== УТИЛИТЫ ====================

    function buildMetadataLabel(movie) {
        if (!movie || !movie.id) return null;
        var mediaType = movie.first_air_date ? 'tv' : 'movie';
        return mediaType + '/' + movie.id;
    }

    function extractHashFromMagnet(magnet) {
        if (!magnet) return null;
        var match = magnet.match(/btih:([a-fA-F0-9]{40})/i);
        return match ? match[1].toLowerCase() : null;
    }

    function isMediaFile(filename) {
        var exts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'm2ts', 'mts'];
        var ext = String(filename || '').split('.').pop().toLowerCase();
        return exts.indexOf(ext) !== -1;
    }

    function progressClass(percent) {
        if (percent >= 100) return 'is-high';
        if (percent >= 50) return 'is-mid';
        return 'is-low';
    }

    // ==================== ДИАГНОСТИКА ====================

    /**
     * Извлекает host:port из URL
     */
    function extractHostPort(url) {
        try {
            var m = String(url).match(/^https?:\/\/([^\/]+)/i);
            return m ? m[1] : url;
        } catch (e) {
            return url;
        }
    }

    /**
     * Тест 1: обычный запрос через Lampa.Reguest (тот же, что в основном коде)
     */
    function diagLampaRequest(url, options) {
        options = options || {};
        return new Promise(function (resolve) {
            var t0 = Date.now();
            var network = new Lampa.Reguest();
            network.timeout(options.timeout || 8000);

            network.quiet(
                url,
                function (response) {
                    resolve({
                        ok: true,
                        method: 'Lampa.Reguest',
                        time: Date.now() - t0,
                        status: 200,
                        response: typeof response === 'string' ? response.substring(0, 200) : response
                    });
                },
                function (err) {
                    resolve({
                        ok: false,
                        method: 'Lampa.Reguest',
                        time: Date.now() - t0,
                        status: err && err.status ? err.status : 0,
                        statusText: err && err.statusText ? err.statusText : '',
                        message: err && err.message ? err.message : String(err),
                        raw: (function () {
                            try { return JSON.stringify(err).substring(0, 300); } catch (e) { return ''; }
                        })()
                    });
                },
                options.body || null,
                {
                    headers: options.headers || {},
                    type: options.method || 'GET',
                    dataType: 'text'
                }
            );
        });
    }

    /**
     * Тест 2: fetch с явным таймаутом через AbortController
     */
    function diagFetch(url, options) {
        options = options || {};
        var t0 = Date.now();
        var timeout = options.timeout || 8000;

        if (typeof fetch !== 'function') {
            return Promise.resolve({
                ok: false,
                method: 'fetch',
                message: 'fetch не поддерживается в этом окружении',
                time: 0
            });
        }

        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = null;

        var fetchPromise = fetch(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body || undefined,
            signal: controller ? controller.signal : undefined
        });

        var timeoutPromise = new Promise(function (_, reject) {
            timer = setTimeout(function () {
                if (controller) controller.abort();
                reject(new Error('timeout ' + timeout + 'ms'));
            }, timeout);
        });

        return Promise.race([fetchPromise, timeoutPromise]).then(function (res) {
            if (timer) clearTimeout(timer);
            return res.text().then(function (text) {
                return {
                    ok: res.ok,
                    method: 'fetch',
                    time: Date.now() - t0,
                    status: res.status,
                    statusText: res.statusText,
                    response: text.substring(0, 200),
                    cors: res.headers.get('access-control-allow-origin') || '(нет)'
                };
            }).catch(function () {
                return {
                    ok: res.ok,
                    method: 'fetch',
                    time: Date.now() - t0,
                    status: res.status,
                    statusText: res.statusText,
                    response: '(не удалось прочитать тело)'
                };
            });
        }).catch(function (err) {
            if (timer) clearTimeout(timer);
            return {
                ok: false,
                method: 'fetch',
                time: Date.now() - t0,
                message: err && err.message ? err.message : String(err),
                name: err && err.name ? err.name : ''
            };
        });
    }

    /**
     * Тест 3: XHR (низкоуровневый, показывает точную причину)
     */
    function diagXHR(url, options) {
        options = options || {};
        var t0 = Date.now();

        return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            var timer = setTimeout(function () {
                try { xhr.abort(); } catch (e) {}
                resolve({
                    ok: false,
                    method: 'XHR',
                    time: Date.now() - t0,
                    message: 'timeout'
                });
            }, options.timeout || 8000);

            xhr.open(options.method || 'GET', url, true);

            try {
                if (options.headers) {
                    Object.keys(options.headers).forEach(function (k) {
                        xhr.setRequestHeader(k, options.headers[k]);
                    });
                }
            } catch (e) {}

            xhr.onload = function () {
                clearTimeout(timer);
                resolve({
                    ok: xhr.status >= 200 && xhr.status < 400,
                    method: 'XHR',
                    time: Date.now() - t0,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    response: String(xhr.responseText || '').substring(0, 200),
                    cors: xhr.getResponseHeader('Access-Control-Allow-Origin') || '(нет)'
                });
            };

            xhr.onerror = function () {
                clearTimeout(timer);
                resolve({
                    ok: false,
                    method: 'XHR',
                    time: Date.now() - t0,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    message: 'onerror (сеть/CORS/cleartext)'
                });
            };

            xhr.ontimeout = function () {
                clearTimeout(timer);
                resolve({
                    ok: false,
                    method: 'XHR',
                    time: Date.now() - t0,
                    message: 'ontimeout'
                });
            };

            try {
                xhr.send(options.body || null);
            } catch (e) {
                clearTimeout(timer);
                resolve({
                    ok: false,
                    method: 'XHR',
                    time: Date.now() - t0,
                    message: 'send error: ' + (e.message || String(e))
                });
            }
        });
    }

    /**
     * Тест 4: HTTP ping через <img> — не подпадает под CORS
     * Если картинка грузится — значит сеть есть, но JS-запросы блокируются CORS
     */
    function diagImagePing(url) {
        var t0 = Date.now();
        return new Promise(function (resolve) {
            var img = new Image();
            var timer = setTimeout(function () {
                img.onload = img.onerror = null;
                img.src = '';
                resolve({
                    ok: false,
                    method: 'Image ping',
                    time: Date.now() - t0,
                    message: 'timeout'
                });
            }, 5000);

            img.onload = function () {
                clearTimeout(timer);
                resolve({
                    ok: true,
                    method: 'Image ping',
                    time: Date.now() - t0,
                    message: 'картинка загрузилась (сеть работает)'
                });
            };

            img.onerror = function () {
                clearTimeout(timer);
                resolve({
                    ok: false,
                    method: 'Image ping',
                    time: Date.now() - t0,
                    message: 'ошибка загрузки (сервер недоступен или отклонил запрос)'
                });
            };

            // Добавляем случайный параметр, чтобы браузер не использовал кэш
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            img.src = url + sep + '_tb_ping=' + Date.now();
        });
    }

    /**
     * Полная диагностика одного сервера
     */
    function diagnoseServer(name, baseUrl, testPath, options) {
        options = options || {};
        var fullUrl = baseUrl + testPath;
        var report = {
            name: name,
            baseUrl: baseUrl,
            testUrl: fullUrl,
            host: extractHostPort(baseUrl),
            protocol: baseUrl.indexOf('https://') === 0 ? 'HTTPS' : 'HTTP',
            tests: []
        };

        // Тест 1: Image ping (проверка сети до сервера без CORS)
        return diagImagePing(baseUrl + '/').then(function (r) {
            report.tests.push({ label: 'Image ping (без CORS)', result: r });
            return diagLampaRequest(fullUrl, options);
        }).then(function (r) {
            report.tests.push({ label: 'Lampa.Reguest', result: r });
            return diagFetch(fullUrl, options);
        }).then(function (r) {
            report.tests.push({ label: 'fetch()', result: r });
            return diagXHR(fullUrl, options);
        }).then(function (r) {
            report.tests.push({ label: 'XMLHttpRequest', result: r });
            return report;
        });
    }

    /**
     * Формирует HTML-отчёт по серверу
     */
    function buildReportHtml(report) {
        var html = '<div class="tb-diag__section">';
        html += '<div class="tb-diag__title">🌐 ' + report.name + '</div>';

        html += '<div class="tb-diag__row">' +
            '<span class="tb-diag__key">Адрес:</span>' +
            '<span class="tb-diag__value">' + report.testUrl + '</span>' +
            '</div>';

        html += '<div class="tb-diag__row">' +
            '<span class="tb-diag__key">Хост:</span>' +
            '<span class="tb-diag__value">' + report.host + '</span>' +
            '</div>';

        html += '<div class="tb-diag__row">' +
            '<span class="tb-diag__key">Протокол:</span>' +
            '<span class="tb-diag__value">' + report.protocol +
            (report.protocol === 'HTTP' ? ' <span class="tb-diag__warn">⚠ Android может блокировать cleartext</span>' : '') +
            '</span>' +
            '</div>';

        report.tests.forEach(function (t) {
            var r = t.result;
            var cls = r.ok ? 'tb-diag__ok' : 'tb-diag__err';
            var icon = r.ok ? '✅' : '❌';

            html += '<div class="tb-diag__row" style="margin-top:0.6em">' +
                '<span class="tb-diag__key">' + t.label + ':</span>' +
                '<span class="tb-diag__value ' + cls + '">' + icon + ' ';

            if (r.ok) {
                html += 'OK (' + r.time + 'ms)';
                if (r.status) html += ', HTTP ' + r.status;
            } else {
                if (r.message) html += r.message;
                if (r.status) html += ' [HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '') + ']';
                if (r.time) html += ' (' + r.time + 'ms)';
            }

            html += '</span></div>';

            if (r.cors && r.cors !== '(нет)') {
                html += '<div class="tb-diag__row"><span class="tb-diag__key"></span>' +
                    '<span class="tb-diag__value tb-diag__info">CORS: ' + r.cors + '</span></div>';
            }
        });

        // Подсказки
        var allFailed = report.tests.every(function (t) { return !t.result.ok; });
        var imgPingOk = report.tests[0] && report.tests[0].result.ok;
        var jsFailed = report.tests.slice(1).every(function (t) { return !t.result.ok; });

        if (allFailed) {
            html += '<div class="tb-diag__hint">' +
                '<b>Все проверки провалились.</b> Скорее всего:<br>' +
                '• Устройство в другой сети / подсети<br>' +
                '• Сервер не слушает внешний интерфейс (только localhost)<br>' +
                '• Файрвол блокирует порт<br>' +
                '• Android блокирует cleartext HTTP (см. ниже)' +
                '</div>';
        } else if (imgPingOk && jsFailed) {
            html += '<div class="tb-diag__hint">' +
                '<b>Сеть до сервера работает (картинка загрузилась), но JS-запросы блокируются.</b><br>' +
                'Это классический <b>CORS</b> или <b>cleartext</b> запрет на Android.<br><br>' +
                '<b>Что делать:</b><br>' +
                '1. На сервере Transmission/TorrServer разрешить CORS:<br>' +
                '&nbsp;&nbsp;<code>Access-Control-Allow-Origin: *</code><br>' +
                '2. Для Android — в манифесте приложения Lampa должно быть:<br>' +
                '&nbsp;&nbsp;<code>android:usesCleartextTraffic="true"</code><br>' +
                '3. Если сервер на Android-смартфоне — проверьте, что он слушает 0.0.0.0, а не 127.0.0.1' +
                '</div>';
        } else if (report.protocol === 'HTTP') {
            html += '<div class="tb-diag__hint">' +
                '<b>Используется HTTP (не HTTPS).</b> На Android это часто блокируется.<br>' +
                'Если сервер сам поднимает HTTPS — используйте его.<br>' +
                'Иначе — добавьте <code>android:usesCleartextTraffic="true"</code> в манифест Lampa.' +
                '</div>';
        }

        html += '</div>';
        return html;
    }

    /**
     * Запускает полную диагностику обоих серверов
     */
    function runDiagnostics() {
        showLoader();

        var tsUrl = getTorrServerUrl();
        var trConfig = getTransmissionConfig();
        var trUrl = trConfig.url + trConfig.path;

        var trHeaders = { 'Content-Type': 'application/json' };
        if (trConfig.user || trConfig.pass) {
            trHeaders['Authorization'] = 'Basic ' + btoa(trConfig.user + ':' + trConfig.pass);
        }
        var sessionId = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_key');
        if (sessionId) trHeaders['X-Transmission-Session-Id'] = sessionId;

        Promise.all([
            diagnoseServer('TorrServer', tsUrl, '/echo', {
                method: 'GET',
                timeout: 8000
            }),
            diagnoseServer('Transmission', trConfig.url, trConfig.path, {
                method: 'POST',
                headers: trHeaders,
                body: JSON.stringify({ method: 'session-get' }),
                timeout: 8000
            })
        ]).then(function (reports) {
            hideLoader();

            var html = '<div class="tb-diag">';
            reports.forEach(function (r) {
                html += buildReportHtml(r);
            });
            html += '</div>';

            Lampa.Modal.open({
                title: '🔍 Диагностика подключений',
                html: html,
                size: 'large',
                onBack: function () {
                    Lampa.Modal.close();
                    Lampa.Controller.toggle('settings');
                }
            });
        }).catch(function (e) {
            hideLoader();
            error('Diagnostics error:', e);
            Lampa.Bell.push({ text: 'Ошибка диагностики: ' + (e.message || e) });
        });
    }

    // ==================== ДОБАВЛЕНИЕ В TRANSMISSION ====================

    function addTorrentToTransmission(torrentElement, movie) {
        var magnet = torrentElement.MagnetUri || torrentElement.Link || torrentElement.magnet || '';
        
        if (!magnet) {
            Lampa.Bell.push({ text: '❌ Magnet-ссылка не найдена' });
            return;
        }

        showLoader();

        var label = '';
        if (movie && movie.id) {
            label = buildMetadataLabel(movie);
        }

        var dtype = (movie && movie.first_air_date) ? 'TV' : 'Movies';
        var downloadDir = Lampa.Storage.get(CONFIG_PREFIX + '_path_' + dtype, '');

        var labels = label ? [label] : [];

        transmissionSendTask(magnet, labels, downloadDir).then(function () {
            hideLoader();
            Lampa.Bell.push({ text: '✅ Добавлено в TorrentBridge' });
        }).catch(function (e) {
            hideLoader();
            error('addTorrentToTransmission error:', e);
            Lampa.Bell.push({ text: '❌ Ошибка: ' + (e.message || 'не удалось добавить') });
        });
    }

    function hookTorrentMenu() {
        Lampa.Listener.follow('torrent', function (e) {
            if (e.type !== 'onlong') return;
            if (!isEnabled()) return;

            var torrentElement = e.element;
            var activeMovie = null;
            
            try {
                var activity = Lampa.Activity.active();
                activeMovie = activity && activity.movie ? activity.movie : null;
            } catch (err) {}

            e.menu.push({
                title: 'Добавить в TorrentBridge',
                onSelect: function () {
                    addTorrentToTransmission(torrentElement, activeMovie);
                }
            });
        });
    }

    // ==================== ПОИСК И ВОСПРОИЗВЕДЕНИЕ ====================

    function findTorrentForMovie(movie) {
        if (!movie || !movie.id) return Promise.resolve(null);

        var label = buildMetadataLabel(movie);
        var titleClean = (movie.title || movie.name || '')
            .toLowerCase()
            .replace(/[^a-zа-я0-9]/g, '');

        return transmissionGetData().then(function (torrents) {
            var found = torrents.find(function (t) {
                return t.labels.indexOf(label) !== -1;
            });
            if (found) return found;

            if (titleClean) {
                found = torrents.find(function (t) {
                    var name = (t.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
                    return name.indexOf(titleClean) !== -1;
                });
                if (found) return found;
            }
            return null;
        }).catch(function (e) {
            error('findTorrentForMovie error:', e);
            return null;
        });
    }

    function getFullMagnet(torrent) {
        return transmissionGetTorrent(torrent.hash).then(function (full) {
            if (!full) {
                return 'magnet:?xt=urn:btih:' + torrent.hash + '&dn=' + encodeURIComponent(torrent.name);
            }
            var magnet = 'magnet:?xt=urn:btih:' + full.hashString;
            magnet += '&dn=' + encodeURIComponent(full.name);

            var trackers = full.trackers || [];
            trackers.forEach(function (tr) {
                if (tr.announce) magnet += '&tr=' + encodeURIComponent(tr.announce);
            });
            return magnet;
        }).catch(function (e) {
            return 'magnet:?xt=urn:btih:' + torrent.hash + '&dn=' + encodeURIComponent(torrent.name);
        });
    }

    function playStream(url, title, poster) {
        hideLoader();

        var playerType = getPlayerType();
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

    function playFromTransmission(movie) {
        if (!movie || !movie.id) {
            Lampa.Bell.push({ text: 'Нет данных фильма' });
            return;
        }

        showLoader();
        Lampa.Bell.push({ text: 'Поиск торрента в Transmission...' });

        return findTorrentForMovie(movie).then(function (torrent) {
            if (!torrent) {
                hideLoader();
                Lampa.Bell.push({ text: 'Торрент не найден. Добавьте его через контекстное меню.' });
                return;
            }

            if (torrent.completed < 1) {
                var percent = Math.round(torrent.completed * 100);
                Lampa.Bell.push({ text: 'Торрент скачан на ' + percent + '%. TorrServer попробует докачать.' });
            }

            return getFullMagnet(torrent).then(function (magnet) {
                var hash = extractHashFromMagnet(magnet) || torrent.hash;
                if (!hash) throw new Error('Не удалось извлечь хеш торрента');

                Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

                return torrServerAdd(magnet, torrent.name).catch(function (e) {
                    log('TorrServer add warning:', e);
                }).then(function () {
                    Lampa.Bell.push({ text: 'Ожидание метаданных...' });

                    var files = [];
                    var attempts = 0;
                    var maxAttempts = 10;

                    function checkFiles() {
                        if (attempts >= maxAttempts || files.length > 0) {
                            return Promise.resolve(files);
                        }
                        attempts++;
                        return new Promise(function (r) { setTimeout(r, 1500); })
                            .then(function () { return torrServerGetFiles(hash); })
                            .then(function (f) {
                                files = f || [];
                                return checkFiles();
                            });
                    }

                    return checkFiles().then(function (files) {
                        var title = movie.title || movie.name || torrent.name;
                        var poster = movie.poster || movie.img || '';

                        if (!files || files.length === 0) {
                            playStream(torrServerStreamUrl(hash, 0), title, poster);
                            return;
                        }

                        var mediaFiles = [];
                        files.forEach(function (file, index) {
                            if (file && file.name && isMediaFile(file.name)) {
                                mediaFiles.push(Object.assign({}, file, { _index: index }));
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

                        hideLoader();

                        var fileItems = mediaFiles.map(function (f) {
                            return {
                                title: String(f.name).split('/').pop() || 'File',
                                file: f,
                                index: f._index
                            };
                        });

                        Lampa.Select.show({
                            title: 'Выберите файл',
                            items: fileItems,
                            onSelect: function (item) {
                                playStream(torrServerStreamUrl(hash, item.index), title, poster);
                            },
                            onBack: function () { Lampa.Controller.toggle('content'); }
                        });
                    });
                });
            });
        }).catch(function (e) {
            hideLoader();
            error('playFromTransmission error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + (e.message || 'не удалось запустить') });
        });
    }

    // ==================== UI: КНОПКА ====================

    function buildBridgeButton() {
        return $(
            '<div class="full-start__button selector button--torrent_bridge">' +
                '<div class="tb-icon-wrap">' +
                    '<svg class="tb-ring" viewBox="0 0 32 32">' +
                        '<circle class="tb-ring-bg" cx="16" cy="16" r="14"></circle>' +
                        '<circle class="tb-ring-fill" cx="16" cy="16" r="14"></circle>' +
                    '</svg>' +
                    '<svg class="tb-icon" viewBox="0 0 24 24">' +
                        '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>' +
                    '</svg>' +
                '</div>' +
                '<span class="tb-label">' +
                    '<span class="tb-title">TorrentBridge</span>' +
                    '<span class="tb-percent">0%</span>' +
                '</span>' +
            '</div>'
        );
    }

    function updateButtonVisual($btn, torrent) {
        if (!$btn || !$btn.length) return;

        var $ring = $btn.find('.tb-ring-fill');
        var $percent = $btn.find('.tb-percent');
        var $title = $btn.find('.tb-title');

        if (!torrent) {
            $btn.removeClass('is-active');
            $percent.text('').removeClass('is-downloading is-seeding is-paused');
            $ring.css('stroke-dashoffset', 88).removeClass('is-low is-mid is-high');
            $title.text('TorrentBridge');
            return;
        }

        var percent = Math.round((torrent.completed || 0) * 100);
        var stateLower = String(torrent.state || '').toLowerCase();
        var cls = progressClass(percent);

        $percent.text(percent + '%').removeClass('is-downloading is-seeding is-paused');

        var isDownloading = stateLower.indexOf('download') !== -1 || stateLower.indexOf('check') !== -1 || stateLower.indexOf('verif') !== -1;
        var isSeeding = stateLower.indexOf('seed') !== -1 || stateLower.indexOf('upload') !== -1;
        var isPaused = stateLower.indexOf('paus') !== -1 || stateLower.indexOf('stop') !== -1;

        if (isSeeding || percent >= 100) {
            $percent.addClass('is-seeding');
            $title.text('TorrentBridge — готово');
            $btn.removeClass('is-active');
        } else if (isDownloading) {
            $percent.addClass('is-downloading');
            $title.text('TorrentBridge');
            $btn.addClass('is-active');
        } else if (isPaused) {
            $percent.addClass('is-paused');
            $title.text('TorrentBridge — пауза');
            $btn.removeClass('is-active');
        } else {
            $title.text('TorrentBridge');
            $btn.removeClass('is-active');
        }

        var circumference = 88;
        var offset = circumference - (percent / 100) * circumference;
        $ring
            .removeClass('is-low is-mid is-high')
            .addClass(cls)
            .css('stroke-dashoffset', offset);
    }

    function refreshButtonStatus(movie, $btn) {
        if (!$btn || !$btn.length) return;
        findTorrentForMovie(movie).then(function (torrent) {
            updateButtonVisual($btn, torrent);
        }).catch(function () {
            updateButtonVisual($btn, null);
        });
    }

    function addMainButtons(movie) {
        currentMovie = movie;

        var container = $('.full-start-new__buttons');
        if (!container.length) return;

        container.find('.button--torrent_bridge').remove();

        var $btn = buildBridgeButton();

        $btn.on('hover:enter', function () {
            playFromTransmission(movie);
        });

        container.append($btn);

        refreshButtonStatus(movie, $btn);

        if (statusCheckTimer) clearInterval(statusCheckTimer);
        statusCheckTimer = setInterval(function () {
            if ($btn.closest('body').length === 0) {
                clearInterval(statusCheckTimer);
                statusCheckTimer = null;
                return;
            }
            refreshButtonStatus(movie, $btn);
        }, 8000);

        log('Animated button added');
    }

    // ==================== ТЕСТИРОВАНИЕ ====================

    function testConnections() {
        showLoader();
        var results = [];

        return torrServerRequest('/echo', 'GET').then(function (r) {
            var ok = r && String(r).indexOf('MatriX') !== -1;
            results.push((ok ? '✅' : '⚠️') + ' TorrServer: ' + getTorrServerUrl());
        }).catch(function (e) {
            results.push('❌ TorrServer: ' + (e.message || 'недоступен'));
        }).then(function () {
            return transmissionAuth(false).then(function () {
                var config = getTransmissionConfig();
                results.push('✅ Transmission: ' + config.url + config.path);
            }).catch(function (e) {
                results.push('❌ Transmission: ' + (e.message || 'недоступен'));
            });
        }).then(function () {
            hideLoader();
            Lampa.Select.show({
                title: 'Результаты проверки',
                items: results.map(function (r) { return { title: r }; }),
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        });
    }

    // ==================== НАСТРОЙКИ ====================

    function createSettings() {
        Lampa.SettingsApi.addComponent({
            component: MANIFEST.component,
            name: MANIFEST.name,
            icon: MANIFEST.icon
        });

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
                description: 'Добавляет кнопки в карточку фильма и контекстное меню торрентов'
            },
            onChange: function (v) {
                var enabled = v === true || v === 'true';
                Lampa.Storage.set(CONFIG_PREFIX + '_enabled', enabled);
                Lampa.Bell.push({ text: enabled ? '✅ TorrentBridge активирован' : '⛔ TorrentBridge деактивирован' });
                Lampa.Settings.update();
            }
        });

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
            onChange: function (v) {
                Lampa.Storage.set(CONFIG_PREFIX + '_player_type', v);
                Lampa.Settings.update();
            }
        });

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
            onChange: function (v) {
                Lampa.Storage.set(CONFIG_PREFIX + '_torrserver_url', String(v || '').trim());
                Lampa.Settings.update();
            }
        });

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
            onChange: function (v) {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_url', String(v || '').trim());
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
            onChange: function (v) {
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
            onChange: function (v) {
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
            onChange: function (v) {
                Lampa.Storage.set(CONFIG_PREFIX + '_transmission_path', String(v || '/transmission/rpc').trim());
                Lampa.Settings.update();
            }
        });

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
            onChange: function (v) {
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
            onChange: function (v) {
                Lampa.Storage.set(CONFIG_PREFIX + '_path_TV', String(v || '').trim());
                Lampa.Settings.update();
            }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_test',
                type: 'button',
                default: false
            },
            field: { name: '🔌 Проверить подключения' },
            onChange: function () { testConnections(); }
        });

        // НОВЫЙ ПУНКТ — ДИАГНОСТИКА
        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_diagnostics',
                type: 'button',
                default: false
            },
            field: {
                name: '🔍 Диагностика подключения',
                description: 'Подробный отчёт: причины недоступности серверов, CORS, cleartext'
            },
            onChange: function () { runDiagnostics(); }
        });

        Lampa.SettingsApi.addParam({
            component: MANIFEST.component,
            param: {
                name: CONFIG_PREFIX + '_info',
                type: 'static',
                default: ''
            },
            field: {
                name: 'Версия 6.3.2',
                description: 'С диагностикой подключений.'
            }
        });
    }

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================

    function init() {
        log('Init TorrentBridge v6.3.2');

        if (!$('#torrentbridge-styles').length) {
            $('head').append(STYLES);
        }

        createSettings();
        Lampa.Manifest.plugins = MANIFEST;

        hookTorrentMenu();

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                setTimeout(function () {
                    try {
                        var render = e.object.activity.render();
                        var movie = render.model || e.object.movie || e.object;

                        if (movie && movie.id) {
                            if (isEnabled()) {
                                addMainButtons(movie);
                            } else {
                                currentMovie = movie;
                            }
                        }
                    } catch (err) {
                        error('Error in full handler:', err);
                    }
                }, 1000);
            }
        });

        log('TorrentBridge v6.3.2 initialized');
    }

    if (!window.plugin_torrentbridge_v6_ready) {
        window.plugin_torrentbridge_v6_ready = true;

        if (window.appready) {
            init();
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') {
                    setTimeout(init, 500);
                }
            });
        }
    }

})();
