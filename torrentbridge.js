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

    // ==================== УТИЛИТЫ КОНФИГА ====================

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
            var headers = {
                'Content-Type': 'application/json'
            };

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
                        try {
                            response = JSON.parse(response);
                        } catch (e) {
                            reject(new Error('Ошибка парсинга ответа Transmission'));
                            return;
                        }
                    }
                    resolve(response);
                },
                function (err) {
                    if (err && err.status === 409 && retry) {
                        var newSessionId = err.getResponseHeader
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

    function transmissionAuth(showNotification) {
        if (typeof showNotification === 'undefined') showNotification = true;

        return transmissionRequest({ method: 'session-get' }).then(function () {
            if (showNotification) {
                Lampa.Bell.push({ text: '✅ Transmission доступен' });
            }
            return true;
        }).catch(function (e) {
            error('Transmission auth error:', e);
            if (showNotification) {
                Lampa.Bell.push({ text: '❌ Transmission: ' + (e.message || 'ошибка') });
            }
            throw e;
        });
    }

    function transmissionGetData() {
        var statusMap = {
            0: 'Stopped',
            1: 'Queued to verify',
            2: 'Verifying',
            3: 'Queued to download',
            4: 'Downloading',
            5: 'Queued to seed',
            6: 'Seeding'
        };

        return transmissionRequest({
            method: 'torrent-get',
            arguments: {
                fields: ['id', 'name', 'hashString', 'labels', 'percentDone', 'status', 'totalSize']
            }
        }).then(function (response) {
            if (response.result !== 'success') {
                throw new Error('Transmission error: ' + response.result);
            }

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
            if (response.result !== 'success') {
                throw new Error('Transmission error: ' + response.result);
            }
            return (response.arguments && response.arguments.torrents || [])[0] || null;
        });
    }

    function transmissionSendTask(magnetUri, labels, downloadDir) {
        if (!labels) labels = [];
        if (!downloadDir) downloadDir = '';

        var args = {
            filename: magnetUri,
            labels: labels
        };

        if (downloadDir) {
            args['download-dir'] = downloadDir;
        }

        return transmissionRequest({
            method: 'torrent-add',
            arguments: args
        }).then(function (response) {
            if (response.result !== 'success') {
                throw new Error('Transmission error: ' + response.result);
            }

            var added = response.arguments['torrent-added'] || response.arguments['torrent-duplicate'];

            if (!added) {
                throw new Error('Торрент добавлен, но ID не получен');
            }

            if (labels.length > 0) {
                return transmissionRequest({
                    method: 'torrent-set',
                    arguments: { ids: [added.id], labels: labels }
                }).catch(function (e) {
                    log('Warning: could not set labels:', e);
                }).then(function () {
                    return added;
                });
            }

            return added;
        });
    }

    // ==================== TORRSERVER API ====================

    function torrServerRequest(path, method, body) {
        if (!method) method = 'GET';

        return new Promise(function (resolve, reject) {
            var url = getTorrServerUrl() + path;
            log('TorrServer request:', method, url);

            var network = new Lampa.Reguest();
            network.timeout(15000);

            var options = {
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
                function (response) {
                    try {
                        if (typeof response === 'string' && response.trim().startsWith('{')) {
                            response = JSON.parse(response);
                        }
                    } catch (e) {
                        // оставляем как есть
                    }
                    resolve(response);
                },
                function (err) {
                    reject(err);
                },
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
            .catch(function () {
                return [];
            });
    }

    function torrServerStreamUrl(hash, fileIndex) {
        if (!fileIndex) fileIndex = 0;
        return getTorrServerUrl() + '/stream?link=' + hash + '&index=' + fileIndex + '&play=1';
    }

    // ==================== ЛОГИКА ПЛАГИНА ====================

    function buildMetadataLabel(movie) {
        var mediaType = movie.first_air_date ? 'tv' : 'movie';
        return mediaType + '/' + movie.id;
    }

    function extractHashFromMagnet(magnet) {
        if (!magnet) return null;
        var match = magnet.match(/btih:([a-fA-F0-9]{40})/i);
        return match ? match[1].toLowerCase() : null;
    }

    function findTorrentForMovie(movie) {
        if (!movie || !movie.id) return Promise.resolve(null);

        var label = buildMetadataLabel(movie);
        var titleClean = (movie.title || movie.name || '')
            .toLowerCase()
            .replace(/[^a-zа-я0-9]/g, '');

        return transmissionGetData().then(function (torrents) {
            log('Total torrents in Transmission:', torrents.length);

            var found = torrents.find(function (t) {
                return t.labels.indexOf(label) !== -1;
            });

            if (found) {
                log('Found by label:', found.name);
                return found;
            }

            if (titleClean) {
                found = torrents.find(function (t) {
                    var name = (t.name || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
                    return name.indexOf(titleClean) !== -1;
                });

                if (found) {
                    log('Found by name:', found.name);
                    return found;
                }
            }

            if (torrents.length === 0) return null;

            return new Promise(function (resolve) {
                var items = torrents.map(function (t) {
                    return {
                        title: t.name,
                        subtitle: Math.round(t.completed * 100) + '% · ' + t.state,
                        torrent: t
                    };
                });

                Lampa.Select.show({
                    title: 'Выберите торрент из Transmission',
                    items: items,
                    onSelect: function (item) { resolve(item.torrent); },
                    onBack: function () { resolve(null); }
                });
            });
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
                if (tr.announce) {
                    magnet += '&tr=' + encodeURIComponent(tr.announce);
                }
            });

            return magnet;
        }).catch(function (e) {
            error('getFullMagnet error:', e);
            return 'magnet:?xt=urn:btih:' + torrent.hash + '&dn=' + encodeURIComponent(torrent.name);
        });
    }

    // ==================== ВОСПРОИЗВЕДЕНИЕ ====================

    function playStream(url, title, poster) {
        log('Playing:', url);
        Lampa.Activity.loader(false);

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

    function isMediaFile(filename) {
        var exts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'm2ts', 'mts'];
        var ext = String(filename || '').split('.').pop().toLowerCase();
        return exts.indexOf(ext) !== -1;
    }

    function playFromTransmission(movie) {
        if (!movie || !movie.id) {
            Lampa.Bell.push({ text: 'Нет данных фильма' });
            return;
        }

        Lampa.Activity.loader(true);
        Lampa.Bell.push({ text: 'Поиск торрента в Transmission...' });

        return findTorrentForMovie(movie).then(function (torrent) {
            if (!torrent) {
                Lampa.Activity.loader(false);
                Lampa.Bell.push({ text: 'Торрент не найден. Сначала добавьте его в Transmission.' });
                return;
            }

            if (torrent.completed < 1) {
                var percent = Math.round(torrent.completed * 100);
                Lampa.Bell.push({
                    text: 'Торрент скачан на ' + percent + '%. TorrServer попробует докачать.'
                });
            }

            Lampa.Bell.push({ text: 'Получение magnet-ссылки...' });

            return getFullMagnet(torrent).then(function (magnet) {
                log('Magnet:', magnet.substring(0, 100) + '...');

                var hash = extractHashFromMagnet(magnet) || torrent.hash;
                if (!hash) {
                    throw new Error('Не удалось извлечь хеш торрента');
                }

                Lampa.Bell.push({ text: 'Подключение к TorrServer...' });

                return torrServerAdd(magnet, torrent.name).catch(function (e) {
                    log('TorrServer add warning (may already exist):', e);
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
                            .then(function () {
                                return torrServerGetFiles(hash);
                            })
                            .then(function (f) {
                                files = f || [];
                                log('Attempt ' + attempts + ': files=' + files.length);
                                return checkFiles();
                            });
                    }

                    return checkFiles().then(function (files) {
                        var title = movie.title || movie.name || torrent.name;
                        var poster = movie.poster || movie.img || '';

                        if (!files || files.length === 0) {
                            Lampa.Bell.push({ text: 'Запуск потока...' });
                            playStream(torrServerStreamUrl(hash, 0), title, poster);
                            return;
                        }

                        var mediaFiles = [];
                        files.forEach(function (file, index) {
                            if (file && file.name && isMediaFile(file.name)) {
                                var f = Object.assign({}, file, { _index: index });
                                mediaFiles.push(f);
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

                        Lampa.Activity.loader(false);

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
                            onBack: function () {
                                Lampa.Controller.toggle('content');
                            }
                        });
                    });
                });
            });
        }).catch(function (e) {
            Lampa.Activity.loader(false);
            error('playFromTransmission error:', e);
            Lampa.Bell.push({ text: 'Ошибка: ' + (e.message || 'не удалось запустить') });
        });
    }

    function addMovieToTransmission(movie, magnetUri) {
        if (!magnetUri) {
            Lampa.Bell.push({ text: 'Magnet-ссылка не найдена' });
            return;
        }

        Lampa.Activity.loader(true);

        var label = buildMetadataLabel(movie);
        var dtype = movie.first_air_date ? 'TV' : 'Movies';
        var downloadDir = Lampa.Storage.get(CONFIG_PREFIX + '_path_' + dtype, '');

        return transmissionSendTask(magnetUri, [label], downloadDir).then(function () {
            Lampa.Activity.loader(false);
            Lampa.Bell.push({ text: '✅ Торрент добавлен в Transmission' });
        }).catch(function (e) {
            Lampa.Activity.loader(false);
            error('addMovieToTransmission error:', e);
            Lampa.Bell.push({ text: '❌ Ошибка: ' + (e.message || 'не удалось добавить') });
        });
    }

    // ==================== UI: КНОПКА В КАРТОЧКЕ ====================

    function createMainButton(label, onClick) {
        return $(
            '<div class="full-start__button selector button--torrent_bridge">' +
                '<svg viewBox="0 0 24 24" fill="currentColor" style="width:24px;height:24px">' +
                    '<path d="M8 5v14l11-7z"/>' +
                '</svg>' +
                '<span>' + label + '</span>' +
            '</div>'
        ).on('hover:enter', onClick);
    }

    function addMainButtons(movie) {
        currentMovie = movie;

        var container = $('.full-start-new__buttons');
        if (!container.length) return;

        container.find('.button--torrent_bridge, .button--torrent_bridge_add').remove();

        var watchBtn = createMainButton('Смотреть с сервера', function () {
            playFromTransmission(movie);
        });

        var magnet = movie.magnet || movie.torrent_magnet || movie.torrent || '';
        if (magnet) {
            var addBtn = createMainButton('Скачать на сервер', function () {
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
            var items = options.items ? options.items.slice() : [];

            var hasTorrent = items.some(function (i) {
                var t = String(i.title || '').toLowerCase();
                return t.indexOf('торрент') !== -1 || t.indexOf('torrent') !== -1;
            });
            var hasOnline = items.some(function (i) {
                var t = String(i.title || '').toLowerCase();
                return t.indexOf('онлайн') !== -1 || t.indexOf('online') !== -1;
            });
            var hasTrailer = items.some(function (i) {
                var t = String(i.title || '').toLowerCase();
                return t.indexOf('трейлер') !== -1 || t.indexOf('trailer') !== -1;
            });

            var isWatchMenu = (hasTorrent && hasOnline) || (hasOnline && hasTrailer);
            var alreadyHas = items.some(function (i) { return i.action === 'torrentbridge_play'; });

            if (isWatchMenu && isEnabled() && !alreadyHas) {
                log('Watch menu detected, adding TorrentBridge');

                var bridgeItem = {
                    title: 'TorrentBridge',
                    subtitle: 'Воспроизвести из Transmission',
                    action: 'torrentbridge_play',
                    template: 'selectbox_icon',
                    separator: true,
                    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
                    onSelect: function () {
                        log('TorrentBridge selected from watch menu');
                        Lampa.Controller.toggle('content');
                        setTimeout(function () {
                            playFromTransmission(currentMovie);
                        }, 100);
                    }
                };

                var trailerIdx = -1;
                for (var i = 0; i < items.length; i++) {
                    var t = String(items[i].title || '').toLowerCase();
                    if (t.indexOf('трейлер') !== -1 || t.indexOf('trailer') !== -1) {
                        trailerIdx = i;
                        break;
                    }
                }

                if (trailerIdx !== -1) {
                    items.splice(trailerIdx, 0, bridgeItem);
                } else {
                    items.push(bridgeItem);
                }

                var originalOnSelect = options.onSelect;
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

    function testConnections() {
        Lampa.Activity.loader(true);
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
            Lampa.Activity.loader(false);

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
                description: 'Добавляет кнопки в карточку фильма и меню "Смотреть"'
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
            field: {
                name: '🔌 Проверить подключения'
            },
            onChange: function () { testConnections(); }
        });

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

        log('TorrentBridge v6.0.0 initialized');
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
