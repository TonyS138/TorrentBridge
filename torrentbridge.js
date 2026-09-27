/**
 * Torrent Bridge - v6.3.4
 * + Расширенная диагностика Basic Auth и обход через URL credentials
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '6.3.4',
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

    function extractHostPort(url) {
        try {
            var m = String(url).match(/^https?:\/\/([^\/]+)/i);
            return m ? m[1] : url;
        } catch (e) {
            return url;
        }
    }

    /**
     * Универсальный XHR-тест с отдачей всех деталей.
     * Если options.includeAuthHeaders = true, отправляет заголовок Authorization.
     * Если options.urlCredentials задан — вставляет user:pass в URL.
     */
    function diagRawXHR(url, options) {
        options = options || {};
        var t0 = Date.now();

        return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            var timedOut = false;
            var timer = setTimeout(function () {
                timedOut = true;
                try { xhr.abort(); } catch (e) {}
                resolve({
                    ok: false,
                    time: Date.now() - t0,
                    message: 'timeout ' + (options.timeout || 8000) + 'ms'
                });
            }, options.timeout || 8000);

            try {
                xhr.open(options.method || 'GET', url, true);
            } catch (e) {
                clearTimeout(timer);
                resolve({
                    ok: false,
                    time: Date.now() - t0,
                    message: 'open() error: ' + (e.message || String(e))
                });
                return;
            }

            try {
                if (options.headers) {
                    Object.keys(options.headers).forEach(function (k) {
                        try {
                            xhr.setRequestHeader(k, options.headers[k]);
                        } catch (e) {
                            log('setRequestHeader failed for', k, e);
                        }
                    });
                }
            } catch (e) {
                log('setRequestHeader loop failed:', e);
            }

            // Пробуем узнать, реально ли ушёл Authorization
            var sentAuthHeader = '(неизвестно)';
            try {
                if (xhr.getRequestHeader) {
                    sentAuthHeader = xhr.getRequestHeader('Authorization') || '(не отправлен)';
                }
            } catch (e) {
                sentAuthHeader = 'ошибка чтения: ' + (e.message || String(e));
            }

            xhr.onload = function () {
                clearTimeout(timer);
                var respAuth = '(нет)';
                var respCors = '(нет)';
                try { respAuth = xhr.getResponseHeader('WWW-Authenticate') || '(нет)'; } catch (e) {}
                try { respCors = xhr.getResponseHeader('Access-Control-Allow-Origin') || '(нет)'; } catch (e) {}

                resolve({
                    ok: xhr.status >= 200 && xhr.status < 400,
                    time: Date.now() - t0,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    sentAuthHeader: sentAuthHeader,
                    wwwAuthenticate: respAuth,
                    cors: respCors,
                    response: String(xhr.responseText || '').substring(0, 200)
                });
            };

            xhr.onerror = function () {
                clearTimeout(timer);
                if (timedOut) return;
                resolve({
                    ok: false,
                    time: Date.now() - t0,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    sentAuthHeader: sentAuthHeader,
                    message: 'onerror (сеть / CORS / cleartext)'
                });
            };

            xhr.ontimeout = function () {
                clearTimeout(timer);
                resolve({
                    ok: false,
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
                    time: Date.now() - t0,
                    message: 'send() error: ' + (e.message || String(e))
                });
            }
        });
    }

    function diagImagePing(url) {
        var t0 = Date.now();
        return new Promise(function (resolve) {
            var img = new Image();
            var timer = setTimeout(function () {
                img.onload = img.onerror = null;
                img.src = '';
                resolve({
                    ok: false,
                    time: Date.now() - t0,
                    message: 'timeout'
                });
            }, 5000);

            img.onload = function () {
                clearTimeout(timer);
                resolve({ ok: true, time: Date.now() - t0, message: 'картинка загрузилась' });
            };

            img.onerror = function () {
                clearTimeout(timer);
                resolve({ ok: false, time: Date.now() - t0, message: 'сервер недоступен / нет картинки' });
            };

            var sep = url.indexOf('?') === -1 ? '?' : '&';
            img.src = url + sep + '_tb_ping=' + Date.now();
        });
    }

    /**
     * Полная диагностика Transmission с 5 тестами:
     *  1. Image ping — сеть
     *  2. XHR без авторизации — видим 401
     *  3. XHR с Basic Auth в заголовке — проверяем, уходит ли заголовок
     *  4. XHR с user:pass в URL — обходной путь для WebView
     *  5. Lampa.Reguest — как в основном коде
     */
    function diagnoseTransmission() {
        var config = getTransmissionConfig();
        var fullUrl = config.url + config.path;
        var report = {
            name: 'Transmission',
            testUrl: fullUrl,
            host: extractHostPort(config.url),
            protocol: config.url.indexOf('https://') === 0 ? 'HTTPS' : 'HTTP',
            hasCredentials: Boolean(config.user || config.pass),
            tests: []
        };

        var authHeader = null;
        if (config.user || config.pass) {
            authHeader = 'Basic ' + btoa(config.user + ':' + config.pass);
        }

        var headersWithAuth = { 'Content-Type': 'application/json' };
        if (authHeader) headersWithAuth['Authorization'] = authHeader;
        var sessionId = Lampa.Storage.get(CONFIG_PREFIX + '_transmission_key');
        if (sessionId) headersWithAuth['X-Transmission-Session-Id'] = sessionId;

        var headersWithoutAuth = { 'Content-Type': 'application/json' };

        var body = JSON.stringify({ method: 'session-get' });

        // URL с user:pass — обходной путь
        var urlWithCreds = null;
        if (config.user || config.pass) {
            try {
                var m = config.url.match(/^(https?:\/\/)(.*)$/i);
                if (m) {
                    urlWithCreds = m[1] + encodeURIComponent(config.user) + ':' + encodeURIComponent(config.pass) + '@' + m[2] + config.path;
                }
            } catch (e) {}
        }

        return diagImagePing(config.url + '/').then(function (r) {
            report.tests.push({ label: '1. Image ping (сеть без CORS)', result: r });
            return diagRawXHR(fullUrl, { method: 'POST', headers: headersWithoutAuth, body: body });
        }).then(function (r) {
            report.tests.push({ label: '2. POST без Auth (ожидаем 401)', result: r });
            return diagRawXHR(fullUrl, { method: 'POST', headers: headersWithAuth, body: body });
        }).then(function (r) {
            report.tests.push({ label: '3. POST + Basic Auth (заголовок)', result: r });
            if (urlWithCreds) {
                return diagRawXHR(urlWithCreds, { method: 'POST', headers: headersWithoutAuth, body: body });
            }
            return { ok: false, time: 0, message: 'пропущено (логин/пароль не заданы)' };
        }).then(function (r) {
            report.tests.push({ label: '4. POST + user:pass в URL (обход)', result: r });
            return diagRawXHR(fullUrl, {
                method: 'POST',
                headers: headersWithAuth,
                body: body
            });
        }).then(function (r) {
            report.tests.push({ label: '5. Финальный POST с Auth', result: r });
            return report;
        });
    }

    function diagnoseTorrServer() {
        var tsUrl = getTorrServerUrl();
        var fullUrl = tsUrl + '/echo';
        var report = {
            name: 'TorrServer',
            testUrl: fullUrl,
            host: extractHostPort(tsUrl),
            protocol: tsUrl.indexOf('https://') === 0 ? 'HTTPS' : 'HTTP',
            hasCredentials: false,
            tests: []
        };

        return diagImagePing(tsUrl + '/').then(function (r) {
            report.tests.push({ label: '1. Image ping (сеть без CORS)', result: r });
            return diagRawXHR(fullUrl, { method: 'GET' });
        }).then(function (r) {
            report.tests.push({ label: '2. GET /echo', result: r });
            return report;
        });
    }

    function buildReportLine(prefix, r) {
        var line = prefix + ' ';
        if (r.ok) {
            line += 'OK (' + r.time + 'ms)';
            if (r.status) line += ', HTTP ' + r.status;
        } else {
            if (r.status) line += 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '') + ' — ';
            if (r.message) line += r.message + ' ';
            if (r.time) line += '(' + r.time + 'ms)';
        }
        return line;
    }

    function runDiagnostics() {
        showLoader();

        Promise.all([
            diagnoseTorrServer(),
            diagnoseTransmission()
        ]).then(function (reports) {
            hideLoader();

            var lines = [];

            reports.forEach(function (report) {
                lines.push('━━━ ' + report.name + ' ━━━');
                lines.push('Адрес: ' + report.testUrl);
                lines.push('Хост: ' + report.host);
                lines.push('Протокол: ' + report.protocol);
                if (report.hasCredentials) lines.push('Логин/пароль: заданы');
                lines.push(' ');

                report.tests.forEach(function (t) {
                    var r = t.result;
                    var prefix = r.ok ? '✅' : '❌';
                    lines.push(prefix + ' ' + t.label);
                    lines.push('   ' + buildReportLine('', r));

                    if (r.sentAuthHeader) {
                        var authShort = String(r.sentAuthHeader).substring(0, 30);
                        lines.push('   → отправлен Authorization: ' + authShort);
                    }
                    if (r.wwwAuthenticate && r.wwwAuthenticate !== '(нет)') {
                        lines.push('   → WWW-Authenticate: ' + r.wwwAuthenticate);
                    }
                    if (r.cors && r.cors !== '(нет)') {
                        lines.push('   → CORS: ' + r.cors);
                    }
                    lines.push(' ');
                });

                // Итоговый вердикт
                var t2 = report.tests[1] && report.tests[1].result;
                var t3 = report.tests[2] && report.tests[2].result;
                var t4 = report.tests[3] && report.tests[3].result;

                if (report.name === 'Transmission') {
                    if (t2 && t2.status === 401 && t3 && t3.status === 401) {
                        lines.push('⚠ Auth в заголовке не проходит. Проверьте логин/пароль.');
                    } else if (t3 && t3.ok) {
                        lines.push('✅ Basic Auth в заголовке работает.');
                    } else if (t4 && t4.ok) {
                        lines.push('✅ Работает URL-обход (user:pass в URL).');
                        lines.push('→ Измените Transmission URL в настройках на:');
                        lines.push('   ' + (function () {
                            try {
                                var c = getTransmissionConfig();
                                var m = c.url.match(/^(https?:\/\/)(.*)$/i);
                                if (m) return m[1] + encodeURIComponent(c.user) + ':' + encodeURIComponent(c.pass) + '@' + m[2];
                            } catch (e) {}
                            return '(не удалось построить)';
                        })());
                    }
                }
                lines.push(' ');
            });

            Lampa.Select.show({
                title: '🔍 Диагностика подключений',
                items: lines.map(function (line) {
                    return { title: line || ' ' };
                }),
                onBack: function () {
                    Lampa.Controller.toggle('settings');
                }
            });

            // Полный отчёт в консоль
            console.log('%c[TorrentBridge] === ДИАГНОСТИКА v6.3.4 ===', 'color: #4ade80; font-weight: bold');
            reports.forEach(function (report) {
                console.group(report.name + ' (' + report.testUrl + ')');
                console.log('Хост:', report.host);
                console.log('Протокол:', report.protocol);
                console.log('Credentials заданы:', report.hasCredentials);
                report.tests.forEach(function (t) {
                    console.log((t.result.ok ? '✅' : '❌') + ' ' + t.label + ':', t.result);
                });
                console.groupEnd();
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
                            play
