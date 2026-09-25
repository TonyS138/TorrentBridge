/**
 * Torrent Bridge - v6.7.0
 * Кнопка в общем стиле Lampa, всегда развёрнута, обводка прогресса по периметру
 */

(function () {
    'use strict';

    const MANIFEST = {
        type: 'other',
        version: '6.7.0',
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
            /* === Кнопка в стиле Lampa === */
            .full-start__button.button--torrent_bridge {
                position: relative;
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
                height: auto !important;
                padding: 0.75em 1.2em !important;
                margin: 0 !important;
                border-radius: 6px !important;
                background: rgba(255, 255, 255, 0.08) !important;
                background-image: none !important;
                color: inherit !important;
                box-shadow: none !important;
                transform: none !important;
                transition: background 0.2s ease !important;
                overflow: visible !important;
                white-space: nowrap !important;
                /* Переменные прогресса */
                --tb-progress: 0;
                --tb-color: #4ade80;
            }

            /* Убираем ЛЮБЫЕ изменения размера при focus/hover */
            .full-start__button.button--torrent_bridge.focus,
            .full-start__button.button--torrent_bridge:hover,
            .full-start__button.button--torrent_bridge.selector.focus,
            .full-start__button.button--torrent_bridge.selector:hover {
                background: rgba(255, 255, 255, 0.14) !important;
                color: inherit !important;
                transform: none !important;
                box-shadow: none !important;
                width: auto !important;
                min-width: 0 !important;
                padding: 0.75em 1.2em !important;
            }

            /* Принудительно показываем содержимое — Lampa не должна его скрывать */
            .full-start__button.button--torrent_bridge > * {
                display: inline-flex !important;
                opacity: 1 !important;
                visibility: visible !important;
            }

            .button--torrent_bridge .tb-content {
                position: relative;
                z-index: 1;
                display: inline-flex;
                align-items: center;
                gap: 8px;
            }

            .button--torrent_bridge .tb-icon {
                width: 18px;
                height: 18px;
                fill: currentColor;
                flex-shrink: 0;
            }

            .button--torrent_bridge .tb-label {
                display: inline-flex;
                align-items: baseline;
                gap: 6px;
                white-space: nowrap;
            }

            .button--torrent_bridge .tb-title {
                font-weight: 500;
            }

            .button--torrent_bridge .tb-percent {
                font-size: 0.85em;
                opacity: 0.8;
                font-variant-numeric: tabular-nums;
            }

            /* Тонкая обводка прогресса — ВСЕГДА видна */
            .button--torrent_bridge::after {
                content: '';
                position: absolute;
                inset: 0;
                border-radius: 6px;
                pointer-events: none;
                z-index: 2;
                padding: 2px;
                background:
                    conic-gradient(
                        var(--tb-color) calc(var(--tb-progress) * 1%),
                        rgba(255, 255, 255, 0.12) 0
                    );
                -webkit-mask:
                    linear-gradient(#000 0 0) content-box,
                    linear-gradient(#000 0 0);
                -webkit-mask-composite: xor;
                        mask-composite: exclude;
                transition: none;
            }

            .button--torrent_bridge.is-low  { --tb-color: #f87171; }
            .button--torrent_bridge.is-mid  { --tb-color: #fbbf24; }
            .button--torrent_bridge.is-high { --tb-color: #4ade80; }

            /* Пульсация только иконки во время загрузки */
            .button--torrent_bridge.is-active .tb-icon {
                animation: tb-icon-pulse 1.8s ease-in-out infinite;
            }

            @keyframes tb-icon-pulse {
                0%, 100% { transform: scale(1); opacity: 1; }
                50%      { transform: scale(1.12); opacity: 0.85; }
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
                '<span class="tb-content">' +
                    '<svg class="tb-icon" viewBox="0 0 24 24">' +
                        '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>' +
                    '</svg>' +
                    '<span class="tb-label">' +
                        '<span class="tb-title">TorrentBridge</span>' +
                        '<span class="tb-percent"></span>' +
                    '</span>' +
                '</span>' +
            '</div>'
        );
    }

    function updateButtonVisual($btn, torrent) {
        if (!$btn || !$btn.length) return;

        var $percent = $btn.find('.tb-percent');
        var $title = $btn.find('.tb-title');

        if (!torrent) {
            $btn.removeClass('is-active is-low is-mid is-high');
            $btn.css('--tb-progress', 0);
            $percent.text('').removeClass('is-downloading is-seeding is-paused');
            $title.text('TorrentBridge');
            return;
        }

        var percent = Math.round((torrent.completed || 0) * 100);
        var stateLower = String(torrent.state || '').toLowerCase();
        var cls = progressClass(percent);

        $percent.text(percent + '%').removeClass('is-downloading is-seeding is-paused');
        $btn.css('--tb-progress', percent);

        var isDownloading = stateLower.indexOf('download') !== -1 || stateLower.indexOf('check') !== -1 || stateLower.indexOf('verif') !== -1;
        var isSeeding = stateLower.indexOf('seed') !== -1 || stateLower.indexOf('upload') !== -1;
        var isPaused = stateLower.indexOf('paus') !== -1 || stateLower.indexOf('stop') !== -1;

        $btn.removeClass('is-low is-mid is-high').addClass(cls);

        if (isSeeding || percent >= 100) {
            $percent.addClass('is-seeding');
            $title.text('TorrentBridge');
            $btn.removeClass('is-active');
        } else if (isDownloading) {
            $percent.addClass('is-downloading');
            $title.text('TorrentBridge');
            $btn.addClass('is-active');
        } else if (isPaused) {
            $percent.addClass('is-paused');
            $title.text('TorrentBridge');
            $btn.removeClass('is-active');
        } else {
            $title.text('TorrentBridge');
            $btn.removeClass('is-active');
        }
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

        log('Bridge button added');
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

        Lampa.S
