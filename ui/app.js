(function () {
  'use strict';
  if (!NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;
  var categories = [{ id: 'all', label: '全部' }, { id: 'hot', label: '热门' }, { id: '1', label: '足球' }, { id: '2', label: '篮球' }, { id: '3', label: '网球' }, { id: '19', label: '台球' }];
  var sources = [{ id: 'all', label: '全部来源' }, { id: 'doubao', label: '豆包直播' }, { id: 'kafei', label: '咖啡直播' }];
  var pages = { home: ['首页', '首页'], live: ['全部直播', '全部直播'], schedule: ['赛程', '赛程'], replay: ['录像回放', '录像回放'], support: ['打赏', '打赏'], settings: ['设置', '设置'] };
  var PAGE_SIZE = 12;
  var state = { page: 'home', category: 'all', source: 'doubao', request: 0, cards: [], room: null, focused: null, hls: null, feeds: {}, loadingMore: false, supportModal: false, supportPrevious: null, appVersion: '', appVersionCode: 0, update: null };
  var content = document.getElementById('page-content');
  var mainArea = document.querySelector('.main-area');
  var layer = document.getElementById('room-layer');
  var pageTitle = document.getElementById('page-title');
  var categorySlot = document.getElementById('category-slot');
  var toast = document.getElementById('toast');
  var navButtons = document.querySelectorAll('.nav-item');
  var hlsScriptRequested = false;
  var signalHideTimer = null;
  var controlsHideTimer = null;
  var roomStatusTimer = null;
  var nativeUpdateTimer = null;
  var frameRevealTimer = null;
  var frameRevealToken = 0;
  var activeFeedRequest = null;
  var activeMoreRequest = null;
  var activeAllPager = null;
  var coreRecoveryPending = false;
  if (window.KafeiTVApp) document.documentElement.classList.add('android-app');
  var paginationObserver = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting && nearFeedEnd()) loadMore(); });
  }, { root: mainArea, rootMargin: '0px 0px 280px 0px', threshold: 0 }) : null;

  function escapeHTML(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; }); }
  function api(path, callback, timeout) {
    var xhr = new XMLHttpRequest(); var finished = false; xhr.open('GET', path, true); xhr.timeout = timeout || 45000;
    function finish(error, value) { if (finished) return; finished = true; callback(error, value); }
    function failure(message, status, retryable) { var error = new Error(message); error.status = status; error.retryable = !!retryable; return error; }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      // Status 0 is also emitted before timeout/abort. Let the specific event
      // classify it so a slow upstream is not mistaken for a dead local core.
      if (xhr.status === 0) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        var value; try { value = JSON.parse(xhr.responseText); } catch (e) { finish(failure('响应格式无效', xhr.status, true)); return; }
        finish(null, value);
      }
      else {
        var message = 'HTTP ' + xhr.status;
        try { var response = JSON.parse(xhr.responseText); if (response && response.message) message = response.message; } catch (ignore) {}
        finish(failure(message, xhr.status));
      }
    };
    xhr.ontimeout = function () { finish(failure('请求超时', 408)); }; xhr.onerror = function () { finish(failure('网络连接失败', 0)); };
    xhr.onabort = function () { var error = failure('请求已取消', 0); error.canceled = true; finish(error); };
    xhr.send(); return xhr;
  }
  function setVideoPlaceholder(message, loading) {
    var placeholder = document.getElementById('video-placeholder'); if (!placeholder) return;
    layer.classList.toggle('is-loading', !!loading);
    placeholder.classList.remove('has-retry');
    placeholder.innerHTML = (loading ? '<span class="state-spinner player-loading-spinner" aria-hidden="true"></span>' : '') + '<span>' + escapeHTML(message) + '</span>';
    placeholder.hidden = false;
  }
  function setPlaybackError(message, error) {
    if (state.room) state.room.lastError = error || message;
    if (state.room && state.room.native) setNativePlaybackActive(false);
    var placeholder = document.getElementById('video-placeholder'); if (!placeholder) return;
    layer.classList.remove('is-loading', 'is-buffering');
    layer.classList.add('is-playback-error');
    setVideoPlaceholder(message, false);
    placeholder.classList.add('has-retry');
    placeholder.insertAdjacentHTML('beforeend', '<button class="player-retry focusable" data-action="retry-playback" data-focus="player-retry">重试线路</button>');
    var retry = placeholder.querySelector('[data-action="retry-playback"]');
    if (retry) retry.addEventListener('click', retryPlayback);
  }
  function setNativePlaybackActive(active) {
    document.documentElement.classList.toggle('native-playback-active', !!active);
  }
  function handleNativePlaybackEvent(event, detail) {
    if (!state.room || !state.room.native) return;
    if (event === 'buffering') {
      state.room.playing = false;
      layer.classList.add('is-buffering');
      setVideoPlaceholder('正在缓冲…', true);
      showPlayerControls();
    } else if (event === 'first-frame') {
      // Media3 may report playWhenReady before a decoded frame is visible.
      // Keep the WebView loading layer until the first frame is rendered.
      layer.classList.remove('is-loading', 'is-buffering', 'is-playback-error');
      var firstFramePlaceholder = document.getElementById('video-placeholder');
      if (firstFramePlaceholder) firstFramePlaceholder.hidden = true;
      if (state.room.restorePaused && window.KafeiTVPlayer && typeof window.KafeiTVPlayer.pause === 'function') { state.room.restorePaused = false; window.KafeiTVPlayer.pause(); }
      updatePlayerControl();
      showPlayerControls();
    } else if (event === 'playing') {
      state.room.playing = true;
      layer.classList.remove('is-playback-error');
      updatePlayerControl();
      showPlayerControls();
    } else if (event === 'paused') {
      state.room.playing = false;
      layer.classList.remove('is-buffering');
      updatePlayerControl();
      showPlayerControls();
    } else if (event === 'ended') {
      showPlaybackEnded(state.room.kind === 'live' ? '直播已结束' : '播放已结束');
    } else if (event === 'error') {
      state.room.playing = false;
      setNativePlaybackActive(false);
      setPlaybackError(state.room.kind === 'replay' ? '回放加载失败，请尝试其他线路' : '直播流中断，请尝试其他线路', detail || '原生播放器错误');
      focusById('player-retry');
    }
  }
  function retryPlayback() {
    if (!state.room) return;
    var error = String(state.room.lastError || '');
    if (/HTTP 0|网络连接失败|请求超时/.test(error) && window.KafeiTVApp && typeof window.KafeiTVApp.restartCore === 'function') {
      if (requestCoreRecovery()) setVideoPlaceholder('连接中断，正在重新连接…', true);
      else window.KafeiTVApp.restartCore();
      return;
    }
    var index = state.room.signalIndex == null ? 0 : state.room.signalIndex;
    var signals = state.room.signals || [];
    if (!signals.length) { requestRoomDetails(state.room); return; }
    selectSignal(index, signals);
  }
  function cancelFrameReveal() {
    frameRevealToken += 1;
    if (frameRevealTimer) window.clearTimeout(frameRevealTimer);
    frameRevealTimer = null;
  }
  function revealVideoFrame(video, placeholder) {
    cancelFrameReveal();
    var token = frameRevealToken;
    var deadline = Date.now() + 5000;
    function valid() { return !!state.room && token === frameRevealToken && video === document.getElementById('room-video'); }
    function reveal() {
      if (!valid()) return;
      if (video.readyState < 2 || !video.videoWidth) {
        if (Date.now() < deadline) frameRevealTimer = window.setTimeout(reveal, 50);
        return;
      }
      frameRevealTimer = null;
      function commit() {
        if (!valid()) return;
        layer.classList.remove('is-loading', 'is-buffering', 'is-playback-error');
        placeholder.hidden = true;
        if (state.room.restorePaused) { state.room.restorePaused = false; video.pause(); }
        updatePlayerControl();
        focusTarget(video);
        showPlayerControls();
      }
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(function () { commit(); });
      else if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(commit);
      else frameRevealTimer = window.setTimeout(commit, 100);
    }
    reveal();
  }
  function rows(response) { var data = response && response.data; return Array.isArray(data) ? data : data && Array.isArray(data.list) ? data.list : data && Array.isArray(data.rows) ? data.rows : []; }
  function totalCount(response) { var value = response && response.total; if (value == null && response && response.data && !Array.isArray(response.data)) value = response.data.total; if (value == null) return null; value = Number(value); return isFinite(value) && value >= 0 ? value : null; }
  function get(path, params, callback, timeout) { var query = []; Object.keys(params).forEach(function (key) { query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key])); }); return api(path + (query.length ? '?' + query.join('&') : ''), callback, timeout); }
  function imageURL(value, source) { if (!value) return ''; if (/^https?:\/\//i.test(value)) return value; var base = source === 'doubao' ? 'https://www.doubaozhibo.com' : 'https://kafeizhibo.cc'; return base + (value.charAt(0) === '/' ? value : '/' + value); }
  function text(item, key, fallback) { return item && item[key] != null ? item[key] : fallback || ''; }
  function homeTeam(item) { return text(item, 'home_team', item.homeTeam && item.homeTeam.name || '主队'); }
  function awayTeam(item) { return text(item, 'away_team', item.awayTeam && item.awayTeam.name || '客队'); }
  function teamLogo(item, side, source) {
    var details = item.match_info || item.matchInfo || item.match || item.schedule || {};
    var value = item[side + '_team_logo'] || item[side + 'TeamLogo'] || item[side + 'Logo'] || details[side + '_team_logo'] || details[side + 'Logo'];
    return imageURL(value, source);
  }
  function teamRow(name, logo, score) {
    var image = logo ? '<img class="team-logo" src="' + escapeHTML(logo) + '" alt="" aria-hidden="true" loading="lazy">' : '';
    return '<div class="team-row"><span class="team-name">' + image + '<span class="team-name-text">' + escapeHTML(name) + '</span></span><span class="score">' + escapeHTML(score) + '</span></div>';
  }
  function formatLocalMatchTime(value) {
    if (!value) return '';
    var raw = String(value);
    function pad(number) { return number < 10 ? '0' + number : String(number); }
    var chineseDate = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?/);
    if (chineseDate) return chineseDate[1] + '-' + pad(chineseDate[2]) + '-' + pad(chineseDate[3]) + (chineseDate[4] ? ' ' + pad(chineseDate[4]) + ':' + chineseDate[5] : '');
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return raw.replace('T', ' ').slice(0, 16);
    var date = new Date(raw);
    if (isNaN(date.getTime())) return raw;
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function watchTeamLogos(root) {
    root.querySelectorAll('.team-logo').forEach(function (image) { image.addEventListener('error', function () { image.style.display = 'none'; }); });
  }
  function normalizeMatchTitle(value) { return String(value == null ? '' : value).replace(/\s+vs\s+/gi, ' VS '); }
  function cardsFor(page, category, pageNumber, done, cursor, source) {
    var params = { view: page, source: source || state.source, category: category, page: pageNumber, size: PAGE_SIZE, cursor: cursor || '' };
    return window.TVFeedRequest.start({ request: function (complete, timeout) { return get('/api/v2/feed', params, complete, timeout); }, done: function (err, result) {
      if (err) return done(err);
      var data = result && result.data || {};
      done(null, { items: Array.isArray(data.items) ? data.items : [], total: data.total == null ? null : Number(data.total), hasMore: !!data.hasMore, nextCursor: data.nextCursor || '', sources: result.sources || {} });
    } });
  }
  function renderState(title, message, retry) { content.innerHTML = '<div class="state-panel">' + (title === '正在加载' ? '<div class="state-spinner" role="progressbar" aria-label="正在加载"></div>' : '') + '<div class="state-title">' + escapeHTML(title) + '</div><div>' + escapeHTML(message) + '</div>' + (retry ? '<button class="retry-button focusable" data-action="retry" data-focus="retry">重试</button>' : '') + '</div>'; if (retry) { var button = content.querySelector('[data-action="retry"]'); button.addEventListener('click', function () { loadPage(); }); focusById('retry'); } }
  function renderCoreError(message) {
    var automatic = window.KafeiTVApp && typeof window.KafeiTVApp.recoverCore === 'function';
    content.innerHTML = '<div class="state-panel">' + (automatic ? '<div class="state-spinner" role="progressbar" aria-label="正在重新连接"></div>' : '') + '<div class="state-title">连接中断</div><div>' + escapeHTML(automatic ? '正在重新连接…' : message || '请按确认重新连接。') + '</div><button class="retry-button focusable" data-action="core-retry" data-focus="core-retry">重新连接</button></div>';
    var button = content.querySelector('[data-action="core-retry"]');
    if (button) button.addEventListener('click', function () { if (window.KafeiTVApp && typeof window.KafeiTVApp.restartCore === 'function') window.KafeiTVApp.restartCore(); else window.location.reload(); });
    focusById('core-retry');
    if (automatic) requestCoreRecovery();
  }
  function requestCoreRecovery() {
    if (!window.KafeiTVApp || typeof window.KafeiTVApp.recoverCore !== 'function') return false;
    if (!coreRecoveryPending) {
      coreRecoveryPending = true;
      try { window.KafeiTVApp.recoverCore(); }
      catch (ignore) { coreRecoveryPending = false; return false; }
    }
    return true;
  }
  function renderCategories() { return '<div class="filter-groups"><div class="category-row source-row" role="group" aria-label="直播来源">' + sources.map(function (source) { return '<button class="category-chip filter-chip source-chip focusable ' + (state.source === source.id ? 'is-selected' : '') + '" data-filter="source" data-source="' + source.id + '" data-focus="source-' + source.id + '">' + source.label + '</button>'; }).join('') + '</div><div class="category-row" role="group" aria-label="赛事分类">' + categories.map(function (c) { return '<button class="category-chip filter-chip category-chip focusable ' + (state.category === c.id ? 'is-selected' : '') + '" data-filter="category" data-category="' + c.id + '" data-focus="cat-' + c.id + '">' + c.label + '</button>'; }).join('') + '</div></div>'; }
  function bindFilters() {
    categorySlot.querySelectorAll('.filter-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (chip.getAttribute('data-filter') === 'source') state.source = chip.getAttribute('data-source');
        else state.category = chip.getAttribute('data-category');
        state.focused = chip.getAttribute('data-focus'); loadPage(state.focused);
      });
    });
  }
  function setSourceHealth(states) {
    var failed = []; var stale = [];
    Object.keys(states || {}).forEach(function (name) { var stateInfo = states[name] || {}; if (stateInfo.status === 'error') failed.push(name === 'doubao' ? '豆包直播' : '咖啡直播'); if (stateInfo.status === 'stale') stale.push(name === 'doubao' ? '豆包直播' : '咖啡直播'); });
    var holder = categorySlot.querySelector('[data-source-health]');
    if (!holder) { holder = document.createElement('div'); holder.setAttribute('data-source-health', '1'); holder.className = 'source-health'; categorySlot.appendChild(holder); }
    holder.classList.toggle('is-multi', state.source === 'all');
    if (state.source === 'all') holder.textContent = ['doubao', 'kafei'].map(function (name) {
      var info = states[name] || {}; var label = name === 'doubao' ? '豆包直播' : '咖啡直播';
      return label + (info.status === 'loading' ? (info.page > 0 ? '加载更多…' : '加载中…') : info.status === 'error' ? '暂不可用' : info.status === 'stale' ? '显示最近数据' : '已加载');
    }).join(' · ');
    else if (failed.length) holder.textContent = failed.join('、') + '暂时不可用';
    else if (stale.length) holder.textContent = stale.join('、') + '显示最近数据';
    else holder.textContent = '';
    holder.classList.toggle('is-visible', !!holder.textContent);
  }
  function supportMarkup() {
    return '<section class="support-page" aria-labelledby="support-title"><div class="support-intro"><h2 id="support-title">喜欢这里？请我喝杯咖啡</h2><p>如果这里让你少花一点找直播的时间，多一点观看赛事的快乐，欢迎请我喝杯咖啡。你的支持，会成为继续打磨体验、保持更新的一份动力。</p><p class="support-thanks">一杯咖啡，一份鼓励。谢谢你，让这里变得更好。</p></div><div class="support-grid"><button class="support-card focusable" data-focus="support-wechat" aria-label="放大微信打赏二维码"><div class="support-card-head"><span class="support-method-dot support-method-wechat"></span><h3>微信打赏</h3><span>确认键放大</span></div><div class="support-qr-frame"><img src="/ui/support-wechat.png" alt="微信打赏二维码" draggable="false"></div><p>打开微信，扫一扫</p></button><button class="support-card focusable" data-focus="support-alipay" aria-label="放大支付宝打赏二维码"><div class="support-card-head"><span class="support-method-dot support-method-alipay"></span><h3>支付宝打赏</h3><span>确认键放大</span></div><div class="support-qr-frame"><img src="/ui/support-alipay.png" alt="支付宝打赏二维码" draggable="false"></div><p>打开支付宝，扫一扫</p></button></div><div id="support-modal" class="support-modal" hidden role="dialog" aria-modal="true" aria-labelledby="support-modal-title"><div class="support-modal-panel"><div class="support-modal-heading"><h2 id="support-modal-title">扫码打赏</h2><button class="support-close focusable" data-focus="support-close" aria-label="关闭">关闭</button></div><img id="support-large-qr" alt="打赏二维码"><p>用手机扫一扫 · 按返回键关闭</p></div></div></section>';
  }
  function renderSupportPage(previousFocus) {
    if (paginationObserver) paginationObserver.disconnect();
    categorySlot.innerHTML = '';
    content.innerHTML = supportMarkup();
    content.querySelectorAll('.support-card').forEach(function (card) { card.addEventListener('click', function () { openSupportModal(card); }); });
    var modal = document.getElementById('support-modal');
    modal.querySelector('[data-focus="support-close"]').addEventListener('click', closeSupportModal);
    if (!focusById(previousFocus || 'support-wechat')) focusById('support-wechat');
  }
  function settingsMarkup() {
    return '<section class="settings-page" aria-labelledby="settings-title"><div class="settings-card"><h2 id="settings-title">应用设置</h2><div class="settings-row"><span>当前版本</span><strong id="settings-version">' + escapeHTML(state.appVersion || '读取中…') + '</strong></div><button class="settings-action focusable" data-action="check-update" data-focus="settings-check">检查版本更新</button><div id="settings-status" class="settings-status" aria-live="polite">可手动检查新版本</div><button id="settings-download" class="settings-download focusable" data-action="download-update" data-focus="settings-download">安装新版本</button></div></section>';
  }
  function setSettingsStatus(message, kind) {
    var status = document.getElementById('settings-status'); if (!status) return;
    status.className = 'settings-status' + (kind ? ' is-' + kind : '');
    status.textContent = message;
  }
  function renderSettingsPage(previousFocus) {
    if (paginationObserver) paginationObserver.disconnect();
    categorySlot.innerHTML = '';
    content.innerHTML = settingsMarkup();
    var check = content.querySelector('[data-action="check-update"]');
    var download = content.querySelector('[data-action="download-update"]');
    if (check) check.addEventListener('click', checkForUpdate);
    if (download) download.addEventListener('click', openUpdateDownload);
    if (!focusById(previousFocus && previousFocus.indexOf('settings-') === 0 ? previousFocus : 'settings-check')) focusById('settings-check');
    readNativeUpdateStatus();
    api('/health', function (err, health) {
      if (err || !health) return;
      state.appVersion = String(health.version || state.appVersion || '');
      state.appVersionCode = Number(health.versionCode || state.appVersionCode || 0);
      var version = document.getElementById('settings-version'); if (version) version.textContent = state.appVersion || '未知';
    });
  }
  function readNativeUpdateStatus() {
    if (!window.KafeiUpdate || typeof window.KafeiUpdate.getStatus !== 'function') return;
    try {
      var raw = window.KafeiUpdate.getStatus(); var status = raw ? JSON.parse(raw) : null;
      if (!status) return;
      var check = document.querySelector('[data-action="check-update"]');
      if (check && status.state !== 'checking') { check.disabled = false; check.textContent = '重新检查'; }
      if (status.message) setSettingsStatus(status.message, status.state === 'error' ? 'error' : status.state === 'available' ? 'update' : '');
      var download = document.getElementById('settings-download');
      if (download) {
        download.classList.toggle('is-visible', status.state === 'available' || status.state === 'ready' || status.state === 'downloading');
        download.textContent = status.state === 'downloading' ? '取消下载' : status.state === 'ready' ? '安装更新' : '下载并安装';
      }
      if (nativeUpdateTimer) { window.clearTimeout(nativeUpdateTimer); nativeUpdateTimer = null; }
      if (status.state === 'checking' || status.state === 'downloading') nativeUpdateTimer = window.setTimeout(readNativeUpdateStatus, 800);
    } catch (ignore) {}
  }
  function checkForUpdate() {
    var button = document.querySelector('[data-action="check-update"]');
    var download = document.querySelector('[data-action="download-update"]');
    if (button) { button.disabled = true; button.textContent = '正在检查…'; }
    if (download) { download.classList.remove('is-visible'); state.update = null; }
    setSettingsStatus('正在检查版本信息…', '');
    if (window.KafeiUpdate && typeof window.KafeiUpdate.check === 'function') { window.KafeiUpdate.check(); window.setTimeout(readNativeUpdateStatus, 250); return; }
    api('/api/v2/update', function (err, response) {
      if (button) { button.disabled = false; button.textContent = '重新检查'; }
      if (err || !response || !response.data) { setSettingsStatus('检查失败，请稍后重试。', 'error'); return; }
      var manifest = response.data;
      var latestCode = Number(manifest.version_code || 0); var currentCode = Number(state.appVersionCode || 0);
      if (manifest.package_name && manifest.package_name !== 'cc.kafeizhibo.tv') { setSettingsStatus('更新包与当前应用不匹配。', 'error'); return; }
      if (latestCode <= currentCode) { setSettingsStatus('当前已是最新版本（' + (state.appVersion || manifest.version_name || '未知') + '）。', 'success'); return; }
      state.update = manifest;
      var note = manifest.release_notes ? '\n' + manifest.release_notes : '';
      setSettingsStatus('发现新版本 ' + (manifest.version_name || latestCode) + note, 'update');
      if (download && manifest.download_url) download.classList.add('is-visible');
    });
  }
  function openUpdateDownload() {
    if (window.KafeiUpdate && typeof window.KafeiUpdate.getStatus === 'function') {
      try {
        var status = JSON.parse(window.KafeiUpdate.getStatus() || '{}');
        if (status.state === 'downloading' && typeof window.KafeiUpdate.cancel === 'function') window.KafeiUpdate.cancel();
        else if (status.state === 'ready' && typeof window.KafeiUpdate.install === 'function') window.KafeiUpdate.install();
        else if (typeof window.KafeiUpdate.download === 'function') window.KafeiUpdate.download();
      } catch (ignore) {}
      window.setTimeout(readNativeUpdateStatus, 500);
      return;
    }
    var manifest = state.update; var url = manifest && manifest.download_url;
    if (!url) return;
    if (window.KafeiTVApp && typeof window.KafeiTVApp.openUrl === 'function') window.KafeiTVApp.openUrl(url);
    else window.open(url, '_blank');
  }
  function openSupportModal(card) {
    var modal = document.getElementById('support-modal'); if (!modal) return;
    state.supportPrevious = card.getAttribute('data-focus'); state.supportModal = true;
    var image = card.querySelector('img'); var large = document.getElementById('support-large-qr'); var title = card.querySelector('h3');
    large.src = image.getAttribute('src'); large.alt = image.alt; document.getElementById('support-modal-title').textContent = title ? title.textContent : '扫码打赏';
    modal.hidden = false; focusById('support-close');
  }
  function closeSupportModal() {
    var modal = document.getElementById('support-modal'); if (!modal) return;
    modal.hidden = true; state.supportModal = false; var large = document.getElementById('support-large-qr'); if (large) large.removeAttribute('src'); focusById(state.supportPrevious || 'support-wechat');
  }
  function matchCard(item, kind) {
    var source = item.source || 'kafei';
    var room = item.room_id || item.roomId || item.play_id || item.replay_id || item.archor && item.archor.room_id || item.archors && item.archors[0] && item.archors[0].room_id || '';
    var id = item.match_id || item.matchId || item.id || item.archor_id || '';
    var title = normalizeMatchTitle(item.title || (homeTeam(item) + ' VS ' + awayTeam(item)));
    var status = item.status || '';
    var badge = kind === 'replay' ? '录像' : status === 'finished' ? '已结束' : (status === 'live' || status === 'online' || status === '直播中') ? '直播中' : '即将开始';
    var image = imageURL(item.cover || item.screenshot || item.cover_image || item.match_info && item.match_info.screenshot, source);
    var cardId = 'card-' + source + '-' + String(room || id || Math.random()).replace(/[^a-zA-Z0-9_-]/g, '');
    var time = formatLocalMatchTime(item.start_time || item.match_time || item.time || '');
    var heat = item.heat ? '热度 ' + item.heat : '';
    var sport = item.sport || ({ '1': '足球', '2': '篮球', '3': '网球', '19': '台球' }[String(item.category || item.type)] || '足球');
    var artStyle = image ? ' style="background-image:url(\'' + escapeHTML(image) + '\')"' : '';
    var homeScore = item.home_score == null || status === 'upcoming' ? '' : item.home_score;
    var awayScore = item.away_score == null || status === 'upcoming' ? '' : item.away_score;
    var teams = '<div class="teams">' + teamRow(homeTeam(item), teamLogo(item, 'home', source), homeScore) + teamRow(awayTeam(item), teamLogo(item, 'away', source), awayScore) + '</div>';
    var timeLine = time ? '<div class="card-caption"><strong>' + escapeHTML(time) + '</strong></div>' : '';
    return '<button class="match-card focusable" data-focus="' + cardId + '" data-source="' + escapeHTML(source) + '" data-room="' + escapeHTML(room) + '" data-match="' + escapeHTML(id) + '" data-kind="' + kind + '" data-title="' + escapeHTML(title) + '" data-team-home="' + escapeHTML(homeTeam(item)) + '" data-team-away="' + escapeHTML(awayTeam(item)) + '" data-league="' + escapeHTML(item.league_name || '') + '"><div class="card-art" data-sport="' + escapeHTML(sport) + '"' + artStyle + '><span class="card-badge ' + (badge === '即将开始' ? 'upcoming' : badge === '已结束' ? 'finished' : kind === 'replay' ? 'replay' : '') + '">' + badge + '</span><span class="card-source source-' + escapeHTML(source) + '">' + escapeHTML(item.source_label || (source === 'doubao' ? '豆包直播' : '咖啡直播')) + '</span><div class="art-meta"><span>' + escapeHTML(item.league_name || '') + '</span><span class="heat">' + escapeHTML(heat) + '</span></div></div><div class="card-info">' + teams + timeLine + '</div></button>';
  }
  function section(title, items, kind) { if (!items || !items.length) return title ? '<section class="feed-section" data-section-kind="' + kind + '"><div class="section-head"><h2 class="section-title">' + title + '</h2><span class="section-note">暂无内容</span></div><div class="card-grid" data-grid-kind="' + kind + '"></div></section>' : '<div class="state-panel"><div>暂无内容</div></div>'; var head = title ? '<div class="section-head"><h2 class="section-title">' + title + '</h2><span class="section-note">' + items.length + ' 场</span></div>' : ''; return '<section class="feed-section" data-section-kind="' + kind + '">' + head + '<div class="card-grid" data-grid-kind="' + kind + '">' + items.map(function (item) { return matchCard(item, kind); }).join('') + '</div></section>'; }
  function loadPage(restore) {
    var request = ++state.request; var previousFocus = restore || state.focused; var feedKey = state.page + ':' + state.category + ':' + state.source;
    if (activeAllPager) { activeAllPager.abort(); activeAllPager = null; }
    if (activeFeedRequest) { activeFeedRequest.abort(); activeFeedRequest = null; }
    if (activeMoreRequest) { activeMoreRequest.abort(); activeMoreRequest = null; }
    if (paginationObserver) paginationObserver.disconnect();
    state.feeds[feedKey] = { page: 1, hasMore: false, total: null, loading: false, local: null, cursor: '' };
    pageTitle.textContent = pages[state.page][1];
    categorySlot.innerHTML = renderCategories();
    bindFilters();
    navButtons.forEach(function (button) { button.classList.toggle('is-active', button.getAttribute('data-page') === state.page); });
    if (state.page === 'support') {
      renderSupportPage(previousFocus);
      return;
    }
    if (state.page === 'settings') {
      renderSettingsPage(previousFocus);
      return;
    }
    if (state.source === 'all') { loadAllSources(feedKey, request, previousFocus); return; }
    renderState('正在加载', '正在获取赛事信息…', false);
    activeFeedRequest = cardsFor(state.page, state.category, 1, function (err, data) {
      if (request !== state.request) return;
      activeFeedRequest = null;
      if (err) { setConnection(false); if (/HTTP 0|网络连接失败/.test(String(err.message || '')) && window.KafeiTVApp) renderCoreError('本地服务连接已断开，请重新连接。'); else renderState('内容加载失败', err.message || '请检查网络连接后重试。', true); return; }
      var sourceStates = data.sources || {}; var sourceNames = Object.keys(sourceStates); var sourceOK = sourceNames.some(function (name) { return sourceStates[name].status === 'ok' || sourceStates[name].status === 'stale'; });
      setConnection(sourceOK); setSourceHealth(sourceStates);
      var feed = state.feeds[feedKey];
      feed.total = data.total; feed.hasMore = !!data.hasMore; feed.cursor = data.nextCursor || '';
      if (state.page === 'home') {
        feed.local = feed.hasMore ? null : { matches: [], live: data.items || [] };
        content.innerHTML = section('正在直播', (data.items || []).slice(0, PAGE_SIZE), 'live');
      }
      else if (state.page === 'live') {
        feed.local = feed.hasMore ? null : (data.items || []); feed.hasMore = !!data.hasMore;
        content.innerHTML = section('', (data.items || []).slice(0, PAGE_SIZE), 'live');
      }
      else if (state.page === 'schedule') {
        content.innerHTML = section('', data.items || [], 'match');
      }
      else {
        content.innerHTML = section('', data.items || [], 'replay');
      }
      watchTeamLogos(content);
      content.querySelectorAll('.match-card').forEach(function (card) { card.addEventListener('click', function () { openRoom(card); }); });
      var retry = content.querySelector('[data-action="retry"]'); if (retry) retry.addEventListener('click', function () { loadPage(); });
      restoreFeedFocus(previousFocus);
      updatePagination(feedKey);
    });
  }
  function loadAllSources(feedKey, request, previousFocus) {
    var feed = state.feeds[feedKey]; feed.multi = true;
    var page = state.page; var category = state.category;
    var kind = page === 'schedule' ? 'match' : page === 'replay' ? 'replay' : 'live';
    var heading = page === 'home' ? '<div class="section-head"><h2 class="section-title">正在直播</h2><span class="section-note" data-multi-count></span></div>' : '';
    content.innerHTML = '<div class="state-panel multi-state" data-multi-state><div class="state-spinner" role="progressbar" aria-label="正在加载"></div><div class="state-title">正在加载</div><div>正在获取赛事信息…</div></div><section class="feed-section multi-feed" hidden>' + heading + '<div class="card-grid" data-grid-kind="' + kind + '"></div></section><div id="pagination-loader" class="pagination-loader multi-pagination"></div>';
    feed.pager = window.TVFeedPager.create({
      sources: ['doubao', 'kafei'],
      request: function (source, pageNumber, cursor, done) { return cardsFor(page, category, pageNumber, done, cursor, source); },
      onChange: function (event) {
        if (request !== state.request || state.feeds[feedKey] !== feed) return;
        var summary = event.snapshot; feed.hasMore = summary.hasMore; feed.loading = summary.loading;
        setSourceHealth(summary.states);
        setConnection(Object.keys(summary.states).some(function (name) { var status = summary.states[name].status; return status === 'ok' || status === 'stale'; }));
        var grid = content.querySelector('.card-grid');
        if (event.items.length) appendItems(event.items, kind, grid);
        var count = grid.querySelectorAll('.match-card').length;
        if (!count && !summary.loading && window.KafeiTVApp && Object.keys(summary.states).every(function (name) { return /HTTP 0|网络连接失败/.test(summary.states[name].message); })) {
          feed.pager.abort(); renderCoreError('本地服务连接已断开，请重新连接。'); return;
        }
        content.querySelector('.multi-feed').hidden = !count;
        var panel = content.querySelector('[data-multi-state]'); panel.hidden = !!count;
        if (!count && summary.loading) panel.innerHTML = '<div class="state-spinner" role="progressbar" aria-label="正在加载"></div><div class="state-title">正在加载</div><div>正在获取赛事信息…</div>';
        if (!count && !summary.loading) panel.innerHTML = '<div class="state-title">' + (summary.failed ? '内容加载失败' : '暂无内容') + '</div><div>' + (summary.failed ? '可在下方重试暂时不可用的来源' : '当前分类暂无赛事') + '</div>';
        var countLabel = content.querySelector('[data-multi-count]'); if (countLabel) countLabel.textContent = count + ' 场';
        updateAllPagination(feed, summary);
        if (count && !feed.focusApplied) { feed.focusApplied = true; if (!state.room) restoreFeedFocus(previousFocus); }
      }
    });
    activeAllPager = feed.pager; feed.pager.start();
  }
  function updateAllPagination(feed, summary) {
    var footer = document.getElementById('pagination-loader'); if (!footer) return;
    var focused = footer.contains(document.activeElement) && document.activeElement.getAttribute('data-focus');
    footer.innerHTML = ['doubao', 'kafei'].map(function (source) {
      var info = summary.states[source]; var label = source === 'doubao' ? '豆包直播' : '咖啡直播';
      if (info.status === 'error' || info.retrying) return '<button class="source-retry focusable" data-multi-retry="' + source + '" data-focus="source-retry-' + source + '" aria-disabled="' + (!!info.retrying) + '">' + (info.retrying ? '正在重试' : '重试') + label + '</button>';
      if (info.loading) return '<span class="source-loading"><span class="state-spinner" aria-hidden="true"></span><span>' + label + (info.page > 0 ? '加载更多…' : '加载中…') + '</span></span>';
      return '';
    }).join('') + (summary.hasMore && !summary.loading ? '<span class="pagination-note">下滑加载更多</span>' : '');
    footer.hidden = !summary.hasMore && !summary.loading && !summary.failed;
    footer.querySelectorAll('[data-multi-retry]').forEach(function (button) { button.addEventListener('click', function () { feed.pager.retry(button.getAttribute('data-multi-retry')); }); });
    if (focused && !focusById(focused)) {
      var cards = content.querySelectorAll('.match-card'); if (cards.length) focusTarget(cards[cards.length - 1]);
    }
    if (paginationObserver) { paginationObserver.unobserve(footer); if (summary.hasMore) paginationObserver.observe(footer); }
    else if (summary.hasMore) scheduleLoadCheck();
  }
  function restoreFeedFocus(previousFocus) {
    if (state.room) return;
    var navigationFocus = 'nav-' + state.page;
    var navigationFocusUnchanged = previousFocus === navigationFocus && (!state.focused || state.focused === previousFocus);
    if (navigationFocusUnchanged) {
      var firstCard = content.querySelector('.match-card');
      if (firstCard) { focusTarget(firstCard); state.focused = firstCard.getAttribute('data-focus'); }
      else focusById('source-' + state.source);
    } else {
      var restoreTarget = state.focused && state.focused !== previousFocus ? state.focused : previousFocus;
      var restored = restoreTarget && focusById(restoreTarget);
      if (!restored && (state.page === 'live' || state.page === 'schedule' || state.page === 'replay')) focusById('cat-' + state.category);
      else if (!restored) focusById(firstCardId());
    }
  }
  function updatePagination(feedKey) {
    var feed = state.feeds[feedKey]; if (!feed) return;
    var footer = document.getElementById('pagination-loader');
    if (!feed.hasMore && !feed.loading) { if (footer) footer.remove(); return; }
    if (!footer) { footer = document.createElement('div'); footer.id = 'pagination-loader'; footer.className = 'pagination-loader'; content.appendChild(footer); }
    footer.innerHTML = feed.loading ? '<span class="state-spinner" aria-hidden="true"></span><span>正在加载更多…</span>' : feed.failed ? '<button class="pagination-retry focusable" data-focus="pagination-retry">加载失败，按确认重试</button>' : '<span>下滑加载更多</span>' ;
    var retry = footer.querySelector('[data-focus="pagination-retry"]');
    if (retry) retry.addEventListener('click', function () { var feedKey = state.page + ':' + state.category + ':' + state.source; var feed = state.feeds[feedKey]; if (feed) feed.failed = false; loadMore(); });
    if (paginationObserver) { paginationObserver.unobserve(footer); paginationObserver.observe(footer); }
    else scheduleLoadCheck();
  }
  function scheduleLoadCheck() {
    var requestFrame = window.requestAnimationFrame || function (callback) { return window.setTimeout(callback, 16); };
    requestFrame(function () { if (mainArea.scrollTop + mainArea.clientHeight >= mainArea.scrollHeight - 280) loadMore(); });
  }
  function nearFeedEnd() { return mainArea.scrollTop + mainArea.clientHeight >= mainArea.scrollHeight - 280; }
  function appendItems(items, kind, targetGrid) {
    if (!items || !items.length || !targetGrid) return;
    var holder = document.createElement('div'); holder.innerHTML = items.map(function (item) { return matchCard(item, kind); }).join('');
    while (holder.firstChild) { var card = holder.firstChild; card.addEventListener('click', function () { openRoom(this); }); watchTeamLogos(card); targetGrid.appendChild(card); }
  }
  function loadMore() {
    var feedKey = state.page + ':' + state.category + ':' + state.source; var feed = state.feeds[feedKey];
    if (feed && feed.multi) { if (!state.room && activeAllPager && nearFeedEnd()) activeAllPager.loadMore(); return; }
    if (!feed || !feed.hasMore || feed.loading || feed.failed || state.room) return;
    feed.loading = true; updatePagination(feedKey);
    if (feed.local) {
      if (state.page === 'home') {
        var matchGrid = content.querySelector('[data-grid-kind="match"]');
        var liveGrid = content.querySelector('[data-grid-kind="live"]');
        var shownMatches = matchGrid ? matchGrid.querySelectorAll('.match-card').length : 0; var shownLive = liveGrid ? liveGrid.querySelectorAll('.match-card').length : 0;
        appendItems(feed.local.matches.slice(shownMatches, shownMatches + PAGE_SIZE), 'match', matchGrid);
        appendItems(feed.local.live.slice(shownLive, shownLive + PAGE_SIZE), 'live', liveGrid);
        feed.hasMore = shownMatches + PAGE_SIZE < feed.local.matches.length || shownLive + PAGE_SIZE < feed.local.live.length;
      } else {
        var grid = content.querySelector('[data-grid-kind="live"]'); var shown = grid ? grid.querySelectorAll('.match-card').length : 0;
        appendItems(feed.local.slice(shown, shown + PAGE_SIZE), 'live', grid); feed.hasMore = shown + PAGE_SIZE < feed.local.length;
      }
      feed.loading = false; updatePagination(feedKey); return;
    }
    var nextPage = feed.page + 1;
    var request = state.request;
    activeMoreRequest = cardsFor(state.page, state.category, nextPage, function (err, data) {
      if (request !== state.request || state.page + ':' + state.category + ':' + state.source !== feedKey || state.feeds[feedKey] !== feed) return;
      activeMoreRequest = null;
      feed.loading = false; feed.failed = false;
      if (err) { feed.hasMore = true; feed.failed = true; updatePagination(feedKey); showToast('加载失败，请按确认重试'); return; }
      setSourceHealth(data.sources || {});
      var kind = state.page === 'schedule' ? 'match' : state.page === 'replay' ? 'replay' : 'live'; var items = data.items || []; var grid = content.querySelector('[data-grid-kind="' + kind + '"]');
      appendItems(items, kind, grid);
      feed.page = nextPage; feed.total = data.total == null ? feed.total : data.total;
      var loaded = grid ? grid.querySelectorAll('.match-card').length : 0;
      feed.cursor = data.nextCursor || '';
      feed.hasMore = !!data.hasMore;
      if (!items.length) feed.hasMore = false;
      updatePagination(feedKey);
    }, feed.cursor);
  }
  function setConnection(online) { document.documentElement.setAttribute('data-connection', online ? 'connected' : 'error'); }
  function firstCardId() { var card = content.querySelector('.match-card') || content.querySelector('[data-multi-retry]'); return card ? card.getAttribute('data-focus') : 'nav-' + state.page; }
  function focusTarget(target) {
    if (!target || !target.focus) return false;
    var scrollParents = []; var node = target.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      var style = window.getComputedStyle ? window.getComputedStyle(node) : null;
      var canScrollX = !!style && /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      var canScrollY = !!style && /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (canScrollX || canScrollY) scrollParents.push({ element: node, x: canScrollX, y: canScrollY, left: node.scrollLeft, top: node.scrollTop });
      node = node.parentElement;
    }
    var pageX = window.pageXOffset || document.documentElement.scrollLeft || 0;
    var pageY = window.pageYOffset || document.documentElement.scrollTop || 0;
    try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
    scrollParents.forEach(function (parent) { parent.element.scrollLeft = parent.left; parent.element.scrollTop = parent.top; });
    if ((window.pageXOffset || document.documentElement.scrollLeft || 0) !== pageX || (window.pageYOffset || document.documentElement.scrollTop || 0) !== pageY) window.scrollTo(pageX, pageY);
    scrollParents.forEach(function (parent) {
      var container = parent.element; var bounds = container.getBoundingClientRect(); var rect = target.getBoundingClientRect(); var inset = 8;
      var top = bounds.top + container.clientTop + inset; var bottom = bounds.top + container.clientTop + container.clientHeight - inset;
      var left = bounds.left + container.clientLeft + inset; var right = bounds.left + container.clientLeft + container.clientWidth - inset;
      if (parent.y && rect.height <= bottom - top) {
        if (rect.top < top) container.scrollTop += rect.top - top;
        else if (rect.bottom > bottom) container.scrollTop += rect.bottom - bottom;
      }
      if (parent.x && rect.width <= right - left) {
        if (rect.left < left) container.scrollLeft += rect.left - left;
        else if (rect.right > right) container.scrollLeft += rect.right - right;
      }
    });
    return true;
  }
  function focusById(id) { if (!id) return false; var target = document.querySelector('[data-focus="' + id.replace(/"/g, '') + '"]'); if (!target || !focusTarget(target)) return false; state.focused = id; return true; }
  function visibleFocusables(root) { return Array.prototype.slice.call(root.querySelectorAll('.focusable, .nav-item')).filter(function (item) { var rect = item.getBoundingClientRect(); var style = window.getComputedStyle ? window.getComputedStyle(item) : null; return rect.width > 0 && rect.height > 0 && !item.disabled && (!style || (style.visibility !== 'hidden' && style.opacity !== '0')); }); }
  function spatialTarget(current, candidates, direction) {
    if (!current) return candidates[0] || null;
    var a = current.getBoundingClientRect(); var ax = a.left + a.width / 2; var ay = a.top + a.height / 2; var best = null; var bestScore = Infinity;
    candidates.forEach(function (item) {
      if (item === current) return;
      var b = item.getBoundingClientRect(); var bx = b.left + b.width / 2; var by = b.top + b.height / 2; var primary; var cross;
      if (direction === 'ArrowLeft' && bx < ax - 2) { primary = Math.max(0, a.left - b.right); cross = Math.abs(by - ay); }
      else if (direction === 'ArrowRight' && bx > ax + 2) { primary = Math.max(0, b.left - a.right); cross = Math.abs(by - ay); }
      else if (direction === 'ArrowUp' && by < ay - 2) { primary = Math.max(0, a.top - b.bottom); cross = Math.abs(bx - ax); }
      else if (direction === 'ArrowDown' && by > ay + 2) { primary = Math.max(0, b.top - a.bottom); cross = Math.abs(bx - ax); }
      else return;
      var score = primary + cross * 1.65;
      if (score < bestScore) { bestScore = score; best = item; }
    });
    return best;
  }
  function moveFocus(direction) {
    var current = document.activeElement;
    if (state.room) {
      showPlayerControls();
      var playerTargets = visibleFocusables(layer); var playerNext = spatialTarget(current, playerTargets, direction);
      if (playerNext) { focusTarget(playerNext); if (playerNext.classList.contains('signal-button')) showSignalPanel(); }
      return;
    }
    if (current.classList.contains('nav-item')) {
      var navIndex = Array.prototype.indexOf.call(navButtons, current);
      if (direction === 'ArrowUp' && navIndex > 0) focusTarget(navButtons[navIndex - 1]);
      else if (direction === 'ArrowDown' && navIndex < navButtons.length - 1) focusTarget(navButtons[navIndex + 1]);
      else if (direction === 'ArrowRight') {
        if (state.page === 'support') { focusById('support-wechat'); return; }
        if (state.page === 'settings') { focusById('settings-check'); return; }
        var firstCard = content.querySelector('.match-card');
        if (firstCard) { focusTarget(firstCard); state.focused = firstCard.getAttribute('data-focus'); return; }
        if (focusById('source-' + state.source)) return;
        focusById('cat-' + state.category);
      }
      return;
    }
    if (current.classList.contains('settings-action') || current.classList.contains('settings-download')) {
      var settingsTargets = Array.prototype.slice.call(content.querySelectorAll('.settings-action, .settings-download.is-visible'));
      var settingsNext = spatialTarget(current, settingsTargets, direction);
      if (settingsNext) { focusTarget(settingsNext); return; }
      if (direction === 'ArrowLeft' || direction === 'ArrowUp') focusById('nav-settings');
      return;
    }
    if (current.classList.contains('support-card')) {
      var supportCards = Array.prototype.slice.call(content.querySelectorAll('.support-card')); var supportIndex = supportCards.indexOf(current);
      if (direction === 'ArrowLeft' && supportIndex > 0) focusTarget(supportCards[supportIndex - 1]);
      else if (direction === 'ArrowLeft') focusById('nav-support');
      else if (direction === 'ArrowRight' && supportIndex < supportCards.length - 1) focusTarget(supportCards[supportIndex + 1]);
      else if (direction === 'ArrowUp') focusById('nav-support');
      return;
    }
    if (current.classList.contains('filter-chip')) {
      var filterKind = current.getAttribute('data-filter'); var filterSelector = filterKind === 'source' ? '.source-chip' : '.category-chip:not(.source-chip)'; var chips = Array.prototype.slice.call(categorySlot.querySelectorAll(filterSelector)); var chipIndex = chips.indexOf(current);
      if (direction === 'ArrowLeft' && chipIndex > 0) focusTarget(chips[chipIndex - 1]);
      else if (direction === 'ArrowLeft') focusById('nav-' + state.page);
      else if (direction === 'ArrowRight' && chipIndex < chips.length - 1) focusTarget(chips[chipIndex + 1]);
      else if (direction === 'ArrowRight' && filterKind === 'source') focusById('cat-' + state.category);
      else if (direction === 'ArrowRight') focusById(firstCardId());
      else if (direction === 'ArrowDown' && filterKind === 'source') focusById('cat-' + state.category);
      else if (direction === 'ArrowDown') focusById(firstCardId());
      else if (direction === 'ArrowUp' && filterKind === 'category') focusById('source-' + state.source);
      else if (direction === 'ArrowUp') focusById('nav-' + state.page);
      return;
    }
    if (current.classList.contains('source-retry') || current.classList.contains('pagination-retry')) {
      var footer = document.getElementById('pagination-loader'); var actions = footer ? visibleFocusables(footer) : []; var actionIndex = actions.indexOf(current);
      if (direction === 'ArrowLeft' && actionIndex > 0) focusTarget(actions[actionIndex - 1]);
      else if (direction === 'ArrowLeft') focusById('nav-' + state.page);
      else if (direction === 'ArrowRight' && actionIndex < actions.length - 1) focusTarget(actions[actionIndex + 1]);
      else if (direction === 'ArrowUp') { var aboveCard = spatialTarget(current, Array.prototype.slice.call(content.querySelectorAll('.match-card')), 'ArrowUp'); if (aboveCard) focusTarget(aboveCard); else focusById('cat-' + state.category); }
      return;
    }
    if (current.classList.contains('match-card')) {
      var cards = Array.prototype.slice.call(content.querySelectorAll('.match-card')); var nextCard = spatialTarget(current, cards, direction);
      if (nextCard) { focusTarget(nextCard); return; }
      if (direction === 'ArrowLeft') {
        var rowCards = cards.filter(function (card) { return Math.abs(card.getBoundingClientRect().top - current.getBoundingClientRect().top) < 8; });
        if (rowCards.length && rowCards[0] === current) focusById('nav-' + state.page);
      } else if (direction === 'ArrowUp') {
        var above = spatialTarget(current, cards, 'ArrowUp');
        if (!above) focusById('cat-' + state.category);
      } else if (direction === 'ArrowDown') {
        var pagination = document.getElementById('pagination-loader'); var retryTargets = pagination ? visibleFocusables(pagination) : [];
        if (retryTargets.length) focusTarget(retryTargets[0]);
      }
      return;
    }
    var pageTargets = visibleFocusables(document.querySelector('.app-shell')); var pageNext = spatialTarget(current, pageTargets, direction);
    if (pageNext) focusTarget(pageNext);
  }
  function showToast(message) { toast.textContent = message; toast.classList.add('visible'); window.setTimeout(function () { toast.classList.remove('visible'); }, 2300); }
  function openRoom(card) {
    var room = card.getAttribute('data-room'); var match = card.getAttribute('data-match'); var source = card.getAttribute('data-source') || 'kafei'; var title = card.getAttribute('data-title'); var kind = card.getAttribute('data-kind');
    var roomLabel = kind === 'replay' ? '回放' : '直播';
    state.focused = card.getAttribute('data-focus'); state.room = { title: title, previous: state.focused, card: card, roomId: room || match, matchId: match, source: source, kind: kind, signals: [], signalIndex: 0, lastError: '', playing: false, native: false, ended: false };
    layer.hidden = false;
    layer.classList.remove('is-controls-hidden', 'is-fullscreen', 'is-ended', 'is-buffering', 'is-playback-error');
    layer.classList.add('is-loading');
  layer.innerHTML = '<section class="room-panel" role="dialog" aria-modal="true"><div class="player-area"><div class="video-wrap"><video id="room-video" class="player-surface focusable" data-focus="room-video" tabindex="-1" aria-label="' + roomLabel + '视频" playsinline></video><div id="video-placeholder" class="player-placeholder"><span class="state-spinner player-loading-spinner" aria-hidden="true"></span><span>正在获取' + roomLabel + '线路…</span></div><div class="player-topbar"><div class="player-title"><span class="live-label">' + roomLabel + '</span><div class="player-title-text"><strong>' + escapeHTML(title) + '</strong></div></div><button class="close-button focusable" data-room-close="1" data-focus="room-close" aria-label="返回"><svg class="close-icon"><use xlink:href="#icon-back"></use></svg><span>返回</span></button></div><div id="signal-panel" class="signal-panel" aria-label="' + roomLabel + '线路" hidden><div class="signal-panel-title">选择线路</div><div id="signal-list" class="signal-list"><div class="section-note">正在获取…</div></div></div><div class="player-controls"><button id="player-toggle" class="player-control focusable" data-player-action="toggle" data-focus="player-toggle" aria-label="播放" title="播放"><svg id="player-icon" class="player-icon"><use xlink:href="#icon-play"></use></svg></button><button id="player-fullscreen" class="player-icon-button focusable" data-player-action="fullscreen" data-focus="player-fullscreen" aria-label="全屏" title="全屏"><svg id="fullscreen-icon" class="player-icon"><use xlink:href="#icon-fullscreen"></use></svg></button></div></div></div></section>';
    layer.querySelector('[data-room-close]').addEventListener('click', closeRoom);
    layer.onclick = function (e) { if (e.target === layer) closeRoom(); };
    layer.querySelector('[data-player-action="toggle"]').addEventListener('click', togglePlayback);
    layer.querySelector('[data-player-action="fullscreen"]').addEventListener('click', toggleFullscreen);
    requestRoomDetails(state.room);
    focusById('room-close');
  }
  function requestRoomDetails(roomState) {
    layer.classList.remove('is-playback-error');
    setVideoPlaceholder('正在获取' + (roomState.kind === 'replay' ? '回放' : '直播') + '线路…', true);
    get('/api/v2/room/' + encodeURIComponent(roomState.source) + '/' + encodeURIComponent(roomState.roomId), { kind: roomState.kind }, function (err, response) {
      if (state.room !== roomState) return;
      var data = response && response.data || {}; var signals = data.signals || data.streams || data.archors || [];
      if (!Array.isArray(signals)) signals = Object.keys(signals).map(function (key) { return signals[key]; });
      if (!signals.length && data.stream_url) signals = [{ name: '默认线路', url: data.stream_url }];
      renderSignals(signals, err, data);
      if (!err && roomState.kind !== 'replay' && !isRoomFinished(data)) startRoomStatusPolling(roomState);
    });
  }
  function renderSignals(signals, err, roomData) {
    var list = document.getElementById('signal-list'); var panel = document.getElementById('signal-panel'); if (!list || !panel) return;
    if (err) { panel.hidden = true; setPlaybackError(err.message || '直播线路请求失败', err.message); focusById('player-retry'); return; }
    if (state.room.kind !== 'replay' && isRoomFinished(roomData)) { panel.hidden = true; showPlaybackEnded('直播已结束'); return; }
    if (!signals.length) { panel.hidden = true; setPlaybackError('当前没有可用线路', 'no signal'); focusById('player-retry'); return; }
    state.room.signals = signals;
    var preferred = Math.floor(Number(state.room.preferredSignalIndex) || 0);
    var selected = preferred >= 0 && preferred < signals.length ? preferred : 0;
    delete state.room.preferredSignalIndex;
    list.innerHTML = signals.map(function (signal, index) { var label = signal.name || signal.title || signal.label || '线路 ' + (index + 1); return '<button class="signal-button focusable ' + (index === selected ? 'is-active' : '') + '" data-signal="' + index + '" data-focus="signal-' + index + '">' + escapeHTML(label) + '</button>'; }).join('');
    list.querySelectorAll('.signal-button').forEach(function (button) { button.addEventListener('click', function () { selectSignal(Number(button.getAttribute('data-signal')), signals); }); });
    panel.hidden = signals.length < 2;
    selectSignal(selected, signals);
    if (signals.length > 1) { focusById('signal-' + selected); showSignalPanel(); } else focusById('player-toggle');
  }
  function showSignalPanel() {
    var panel = document.getElementById('signal-panel'); if (!panel || panel.hidden) return;
    showPlayerControls();
    panel.classList.remove('is-auto-hidden');
    if (signalHideTimer) window.clearTimeout(signalHideTimer);
    signalHideTimer = null;
  }
  function scheduleControlsHide() {
    if (controlsHideTimer) window.clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
    if (!state.room || !state.room.playing) return;
    controlsHideTimer = window.setTimeout(function () {
      if (!state.room || !state.room.playing) return;
      var panel = document.getElementById('signal-panel');
      if (panel && !panel.hidden) panel.classList.add('is-auto-hidden');
      layer.classList.add('is-controls-hidden');
    }, 4000);
  }
  function showPlayerControls() {
    if (!state.room) return;
    layer.classList.remove('is-controls-hidden');
    var panel = document.getElementById('signal-panel');
    if (panel && !panel.hidden) panel.classList.remove('is-auto-hidden');
    scheduleControlsHide();
  }
  function fullscreenActive() { return document.fullscreenElement === layer || document.webkitFullscreenElement === layer; }
  function updateFullscreenControl() {
    var button = document.getElementById('player-fullscreen'); var icon = document.getElementById('fullscreen-icon');
    if (!button || !icon) return;
    var active = fullscreenActive();
    icon.innerHTML = '<use xlink:href="#icon-' + (active ? 'exit-fullscreen' : 'fullscreen') + '"></use>';
    button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    button.setAttribute('title', active ? '退出全屏' : '全屏');
  }
  function toggleFullscreen() {
    showPlayerControls();
    var request = layer.requestFullscreen || layer.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      var result;
      if (fullscreenActive() && exit) result = exit.call(document);
      else if (request) result = request.call(layer);
      else { showToast('当前浏览器不支持全屏'); return; }
      if (result && result.catch) result.catch(function () { showToast('浏览器未允许全屏'); });
    } catch (error) { showToast('浏览器未允许全屏'); }
  }
  function showPlaybackEnded(message) {
    if (!state.room) return;
    if (state.room.native) setNativePlaybackActive(false);
    cancelFrameReveal();
    state.room.playing = false; state.room.ended = true;
    if (roomStatusTimer) window.clearInterval(roomStatusTimer);
    roomStatusTimer = null;
    var video = document.getElementById('room-video');
    if (video && !video.paused) video.pause();
    if (state.hls && state.hls.stopLoad) state.hls.stopLoad();
    var panel = document.getElementById('signal-panel'); if (panel) panel.hidden = true;
    var liveLabel = layer.querySelector('.live-label'); if (liveLabel) liveLabel.textContent = '已结束';
    layer.classList.add('is-ended', 'is-playback-error');
    setVideoPlaceholder(message, false);
    updatePlayerControl();
    var active = document.activeElement;
    if (active && layer.contains(active) && active.id !== 'room-close') focusById('room-close');
  }
  function isRoomFinished(roomData) { return !!roomData && String(roomData.status || '').toLowerCase() === 'finished'; }
  function startRoomStatusPolling(roomState) {
    if (roomStatusTimer) window.clearInterval(roomStatusTimer);
    roomStatusTimer = window.setInterval(function () {
      if (state.room !== roomState || roomState.ended || document.hidden) return;
      get('/api/v2/room/' + encodeURIComponent(roomState.source) + '/' + encodeURIComponent(roomState.roomId), { kind: roomState.kind }, function (err, response) {
        if (err || state.room !== roomState) return;
        if (isRoomFinished(response && response.data)) showPlaybackEnded('直播已结束');
      });
    }, 30000);
  }
  function handlePlaybackFailure(video, error) {
    if (!state.room || video !== document.getElementById('room-video')) return;
    if (error && error.name === 'AbortError') return;
    cancelFrameReveal();
    if (video.ended) { showPlaybackEnded(state.room.kind === 'live' ? '直播已结束' : '播放已结束'); return; }
    state.room.playing = false; layer.classList.remove('is-loading', 'is-buffering'); layer.classList.add('is-playback-error'); updatePlayerControl(); showPlayerControls();
    if (error && error.name === 'NotAllowedError') setPlaybackError('自动播放受限，按播放键继续', error.name);
    else setPlaybackError(state.room.kind === 'replay' ? '回放加载失败，请尝试其他线路' : '直播流中断，请尝试其他线路', error && error.message || '播放失败');
    focusById('player-retry');
  }
  function requestVideoPlayback(video) {
    try {
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function (error) { handlePlaybackFailure(video, error); });
    } catch (error) { handlePlaybackFailure(video, error); }
  }
  function togglePlayback() {
    var video = document.getElementById('room-video'); if (!video || (state.room && state.room.ended)) return;
    if (state.room && state.room.native && window.KafeiTVPlayer && typeof window.KafeiTVPlayer.toggle === 'function') { window.KafeiTVPlayer.toggle(); return; }
    if (video.paused) requestVideoPlayback(video);
    else { video.pause(); showToast('已暂停'); }
    updatePlayerControl();
  }
  function updatePlayerControl() {
    var video = document.getElementById('room-video'); var button = document.getElementById('player-toggle'); if (!video || !button) return;
    var ended = !!(state.room && state.room.ended); var playing = !ended && (state.room && state.room.native ? state.room.playing : !video.paused && !video.ended);
    var icon = document.getElementById('player-icon');
    if (icon) icon.innerHTML = '<use xlink:href="#icon-' + (playing ? 'pause' : 'play') + '"></use>';
    button.setAttribute('aria-label', ended ? '直播已结束' : playing ? '暂停' : '播放');
    button.setAttribute('title', ended ? '直播已结束' : playing ? '暂停' : '播放');
  }
  function selectSignal(index, signals) {
    var signal = signals[index] || {}; var url = signal.url || signal.stream_url || signal.play_url || signal.m3u8 || '';
    if (state.room) { state.room.signalIndex = index; state.room.lastError = ''; }
    layer.querySelectorAll('.signal-button').forEach(function (button) { button.classList.toggle('is-active', Number(button.getAttribute('data-signal')) === index); });
    showSignalPanel();
    if (signal.resolve) {
      setVideoPlaceholder('正在获取直播源…', true);
      api(signal.resolve, function (resolveError, resolveResponse) {
        if (!state.room || !state.room.signals || state.room.signals[index] !== signal) return;
        if (resolveError) { setPlaybackError('直播源获取失败，请重试', resolveError.message || 'HTTP 0'); showPlayerControls(); focusById('player-retry'); return; }
        var resolved = resolveResponse && resolveResponse.data || {};
        if (resolved.status === 'finished' && state.room.kind !== 'replay') { showPlaybackEnded('直播已结束'); return; }
        selectResolvedSignal(index, signals, resolved.url || '');
      });
      return;
    }
    selectResolvedSignal(index, signals, url);
  }
  function selectResolvedSignal(index, signals, url) {
    var signal = signals[index] || {};
    if (!url) { setPlaybackError('该线路暂不可用', 'no signal'); focusById('player-retry'); return; }
    state.room.ended = false; layer.classList.remove('is-ended');
    var video = document.getElementById('room-video'); var placeholder = document.getElementById('video-placeholder');
    cancelFrameReveal(); layer.classList.remove('is-playback-error'); setVideoPlaceholder('正在连接直播源…', true);
    if (window.KafeiTVPlayer && typeof window.KafeiTVPlayer.open === 'function') { state.room.native = true; setNativePlaybackActive(true); window.KafeiTVPlayer.open(url, state.room.title); setVideoPlaceholder('正在电视播放器中打开…', true); return; }
    if (state.hls && state.hls.destroy) { state.hls.destroy(); state.hls = null; }
    video.pause(); video.removeAttribute('src'); video.load();
    video.onerror = function () { handlePlaybackFailure(video, video.error || null); };
    video.onplaying = function () { if (state.room) state.room.playing = true; revealVideoFrame(video, placeholder); };
    video.onpause = function () { if (state.room) state.room.playing = false; cancelFrameReveal(); layer.classList.remove('is-buffering'); updatePlayerControl(); showPlayerControls(); };
    video.onwaiting = function () { if (state.room) state.room.playing = false; layer.classList.add('is-buffering'); setVideoPlaceholder('正在缓冲…', true); showPlayerControls(); };
    video.onended = function () { showPlaybackEnded(state.room && state.room.kind === 'live' ? '直播已结束' : '播放已结束'); };
    if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; requestVideoPlayback(video); }
    else if (window.Hls && window.Hls.isSupported()) {
      state.hls = new window.Hls();
      state.hls.loadSource(url); state.hls.attachMedia(video);
      state.hls.on(window.Hls.Events.MANIFEST_PARSED, function () { requestVideoPlayback(video); });
      state.hls.on(window.Hls.Events.ERROR, function (event, detail) { if (detail && detail.fatal) handlePlaybackFailure(video, new Error('HLS playback error')); });
    }
    else { setPlaybackError('当前设备无法播放 HLS', 'HLS unsupported'); focusById('player-retry'); }
    if (!window.Hls && !hlsScriptRequested) { hlsScriptRequested = true; var script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'; script.onload = function () { selectSignal(index, signals); }; script.onerror = function () { setPlaybackError('播放器加载失败', 'HLS script'); focusById('player-retry'); }; document.head.appendChild(script); }
  }
  function closeRoom() { if (!state.room) return; cancelFrameReveal(); var previous = state.room.previous; var video = document.getElementById('room-video'); if (signalHideTimer) window.clearTimeout(signalHideTimer); if (controlsHideTimer) window.clearTimeout(controlsHideTimer); if (roomStatusTimer) window.clearInterval(roomStatusTimer); signalHideTimer = null; controlsHideTimer = null; roomStatusTimer = null; if (video) { video.pause(); video.removeAttribute('src'); video.load(); } if (state.hls && state.hls.destroy) state.hls.destroy(); state.hls = null; if (window.KafeiTVPlayer && window.KafeiTVPlayer.close) window.KafeiTVPlayer.close(); setNativePlaybackActive(false); var exit = document.exitFullscreen || document.webkitExitFullscreen; if (fullscreenActive() && exit) { var exitRequest = exit.call(document); if (exitRequest && exitRequest.catch) exitRequest.catch(function () {}); } state.room = null; layer.classList.remove('is-controls-hidden', 'is-ended', 'is-playback-error'); layer.hidden = true; layer.innerHTML = ''; if (!focusById(previous)) focusById(firstCardId()); }
  function enterPage(page) { if (!pages[page]) return; state.page = page; state.category = 'all'; state.focused = 'nav-' + page; loadPage(state.focused); }
  navButtons.forEach(function (button) { button.addEventListener('click', function () { enterPage(button.getAttribute('data-page')); }); });
  document.addEventListener('keydown', function (event) {
    var key = event.key; if (key === 'Escape' || key === 'Backspace') { if (state.room) { event.preventDefault(); closeRoom(); } else if (state.supportModal) { event.preventDefault(); closeSupportModal(); } return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(key) >= 0) { event.preventDefault(); if (state.room) showPlayerControls(); moveFocus(key); return; }
    if (key === 'Enter' || key === ' ') { if (state.room) showPlayerControls(); var active = document.activeElement; if (active && (active.classList.contains('focusable') || active.classList.contains('nav-item'))) { event.preventDefault(); active.click(); } }
  });
  mainArea.addEventListener('scroll', function () {
    var area = this; if (area.scrollTop + area.clientHeight >= area.scrollHeight - 180) loadMore();
  });
  document.addEventListener('mouseover', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('.nav-item, .focusable') : null;
    if (target && !state.room && document.activeElement !== target) focusTarget(target);
  });
  layer.addEventListener('mouseover', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('.focusable') : null;
    if (target && state.room && document.activeElement !== target) { focusTarget(target); if (target.classList.contains('signal-button')) showSignalPanel(); }
  });
  layer.addEventListener('mousemove', function () { if (state.room) showPlayerControls(); });
  document.addEventListener('focusin', function (event) { var target = event.target; if (target && target.getAttribute) { var id = target.getAttribute('data-focus'); if (id) state.focused = id; if (state.room && layer.contains(target) && target.id !== 'room-video' && target.classList.contains('focusable')) showPlayerControls(); } });
  document.addEventListener('fullscreenchange', updateFullscreenControl);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControl);
  window.MingmingTVKey = function (code) { var keys = { 19: 'ArrowUp', 20: 'ArrowDown', 21: 'ArrowLeft', 22: 'ArrowRight', 23: 'Enter', 66: 'Enter', 4: 'Escape' }; var key = keys[code]; if (!key) return; var event = document.createEvent('Event'); event.initEvent('keydown', true, true); Object.defineProperty(event, 'key', { value: key }); document.dispatchEvent(event); };
  window.MingmingTVBack = function () { if (state.room) { closeRoom(); return true; } if (state.supportModal) { closeSupportModal(); return true; } return false; };
  window.KafeiNativePlaybackEvent = handleNativePlaybackEvent;
  window.MingmingTVBackground = function () { var video = document.getElementById('room-video'); if (video) video.pause(); if (window.KafeiTVPlayer && typeof window.KafeiTVPlayer.pause === 'function') window.KafeiTVPlayer.pause(); };
  window.KafeiTVResume = function () { readNativeUpdateStatus(); };
  window.KafeiTVSaveState = function () {
    var room = state.room;
    return { page: state.page, source: state.source, category: state.category, focused: room ? room.previous : state.focused,
      room: room ? { source: room.source, roomId: room.roomId, matchId: room.matchId, kind: room.kind, title: room.title, signalIndex: room.signalIndex,
        paused: !room.playing && !room.lastError && !layer.classList.contains('is-loading') && !layer.classList.contains('is-buffering') } : null };
  };
  window.KafeiTVRestoreState = function (saved) {
    if (!saved || typeof saved !== 'object') return;
    coreRecoveryPending = false;
    if (Object.prototype.hasOwnProperty.call(pages, saved.page)) state.page = saved.page;
    if (sources.some(function (source) { return source.id === saved.source; })) state.source = saved.source;
    if (categories.some(function (category) { return category.id === saved.category; })) state.category = saved.category;
    state.focused = typeof saved.focused === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(saved.focused) ? saved.focused : 'nav-' + state.page;
    loadPage(state.focused);
    var room = saved.room;
    if (room && (room.source === 'doubao' || room.source === 'kafei') && /^(live|match|replay)$/.test(room.kind) && /^[a-zA-Z0-9_-]{1,160}$/.test(String(room.roomId))) {
      var card = document.createElement('button');
      card.setAttribute('data-source', room.source); card.setAttribute('data-room', room.roomId); card.setAttribute('data-match', String(room.matchId || ''));
      card.setAttribute('data-kind', room.kind); card.setAttribute('data-title', String(room.title || '').slice(0, 256)); card.setAttribute('data-focus', state.focused);
      openRoom(card);
      state.room.preferredSignalIndex = Math.max(0, Math.min(100, Number(room.signalIndex) || 0));
      state.room.restorePaused = !!room.paused;
    }
  };
  window.MingmingTVForeground = function () { };
  window.addEventListener('load', function () { api('/health', function (err, health) { setConnection(!err && health.ready); if (!err && health) { state.appVersion = String(health.version || ''); state.appVersionCode = Number(health.versionCode || 0); } }); loadPage('card-'); });
}());
