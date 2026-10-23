(function () {
  'use strict';
  if (!NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;
  var categories = [{ id: 'all', label: '全部' }, { id: 'hot', label: '热门' }, { id: '1', label: '足球' }, { id: '2', label: '篮球' }, { id: '3', label: '网球' }, { id: '19', label: '台球' }];
  var sources = [{ id: 'all', label: '全部来源' }, { id: 'kafei', label: '咖啡直播' }, { id: 'doubao', label: '豆包直播' }];
  var pages = { home: ['首页', '首页'], live: ['全部直播', '全部直播'], schedule: ['赛程', '赛程'], replay: ['录像回放', '录像回放'], support: ['打赏', '打赏'] };
  var PAGE_SIZE = 12;
  var state = { page: 'home', category: 'all', source: 'all', request: 0, cards: [], room: null, focused: null, hls: null, feeds: {}, loadingMore: false, supportModal: false, supportPrevious: null };
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
  if (window.KafeiTVApp) document.documentElement.classList.add('android-app');
  var paginationObserver = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting) loadMore(); });
  }, { root: mainArea, rootMargin: '0px 0px 280px 0px', threshold: 0 }) : null;

  function escapeHTML(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]; }); }
  function api(path, callback) {
    var xhr = new XMLHttpRequest(); var finished = false; xhr.open('GET', path, true); xhr.timeout = 45000;
    function finish(error, value) { if (finished) return; finished = true; callback(error, value); }
    xhr.onreadystatechange = function () { if (xhr.readyState !== 4) return; if (xhr.status >= 200 && xhr.status < 300) { try { finish(null, JSON.parse(xhr.responseText)); } catch (e) { finish(e); } } else finish(new Error('HTTP ' + xhr.status)); };
    xhr.ontimeout = function () { finish(new Error('请求超时')); }; xhr.onerror = function () { finish(new Error('网络连接失败')); }; xhr.send(); return xhr;
  }
  function setVideoPlaceholder(message, loading) {
    var placeholder = document.getElementById('video-placeholder'); if (!placeholder) return;
    placeholder.innerHTML = (loading ? '<span class="state-spinner player-loading-spinner" aria-hidden="true"></span>' : '') + '<span>' + escapeHTML(message) + '</span>';
    placeholder.hidden = false;
  }
  function rows(response) { var data = response && response.data; return Array.isArray(data) ? data : data && Array.isArray(data.list) ? data.list : data && Array.isArray(data.rows) ? data.rows : []; }
  function totalCount(response) { var value = response && response.total; if (value == null && response && response.data && !Array.isArray(response.data)) value = response.data.total; if (value == null) return null; value = Number(value); return isFinite(value) && value >= 0 ? value : null; }
  function get(path, params, callback) { var query = []; Object.keys(params).forEach(function (key) { query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key])); }); api(path + (query.length ? '?' + query.join('&') : ''), callback); }
  function imageURL(value, source) { if (!value) return ''; if (/^https?:\/\//i.test(value)) return value; var base = source === 'doubao' ? 'https://www.doubaozhibo.com' : 'https://kafeizhibo.cc'; return base + (value.charAt(0) === '/' ? value : '/' + value); }
  function text(item, key, fallback) { return item && item[key] != null ? item[key] : fallback || ''; }
  function homeTeam(item) { return text(item, 'home_team', item.homeTeam && item.homeTeam.name || '主队'); }
  function awayTeam(item) { return text(item, 'away_team', item.awayTeam && item.awayTeam.name || '客队'); }
  function normalizeMatchTitle(value) { return String(value == null ? '' : value).replace(/\s+vs\s+/gi, ' VS '); }
  function cardsFor(page, category, pageNumber, done, cursor) {
    get('/api/v2/feed', { view: page, source: state.source, category: category, page: pageNumber, size: PAGE_SIZE, cursor: cursor || '' }, function (err, result) {
      if (err) return done(err);
      var data = result && result.data || {};
      done(null, { items: Array.isArray(data.items) ? data.items : [], total: data.total == null ? null : Number(data.total), hasMore: !!data.hasMore, nextCursor: data.nextCursor || '', sources: result.sources || {} });
    });
  }
  function renderState(title, message, retry) { content.innerHTML = '<div class="state-panel">' + (title === '正在加载' ? '<div class="state-spinner" role="progressbar" aria-label="正在加载"></div>' : '') + '<div class="state-title">' + escapeHTML(title) + '</div><div>' + escapeHTML(message) + '</div>' + (retry ? '<button class="retry-button focusable" data-action="retry" data-focus="retry">重试</button>' : '') + '</div>'; if (retry) { var button = content.querySelector('[data-action="retry"]'); button.addEventListener('click', function () { loadPage(); }); focusById('retry'); } }
  function renderCategories() { return '<div class="filter-groups"><div class="category-row source-row" role="group" aria-label="直播来源">' + sources.map(function (source) { return '<button class="category-chip filter-chip source-chip focusable ' + (state.source === source.id ? 'is-selected' : '') + '" data-filter="source" data-source="' + source.id + '" data-focus="source-' + source.id + '">' + source.label + '</button>'; }).join('') + '</div><div class="category-row" role="group" aria-label="赛事分类">' + categories.map(function (c) { return '<button class="category-chip filter-chip category-chip focusable ' + (state.category === c.id ? 'is-selected' : '') + '" data-filter="category" data-category="' + c.id + '" data-focus="cat-' + c.id + '">' + c.label + '</button>'; }).join('') + '</div></div>'; }
  function setSourceHealth(states) {
    var failed = []; var stale = [];
    Object.keys(states || {}).forEach(function (name) { var stateInfo = states[name] || {}; if (stateInfo.status === 'error') failed.push(name === 'doubao' ? '豆包直播' : '咖啡直播'); if (stateInfo.status === 'stale') stale.push(name === 'doubao' ? '豆包直播' : '咖啡直播'); });
    var holder = categorySlot.querySelector('[data-source-health]');
    if (!holder) { holder = document.createElement('div'); holder.setAttribute('data-source-health', '1'); holder.className = 'source-health'; categorySlot.appendChild(holder); }
    if (failed.length) holder.textContent = failed.join('、') + '暂时不可用';
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
    var cardId = 'card-' + String(room || id || Math.random()).replace(/[^a-zA-Z0-9_-]/g, '');
    var time = item.start_time || item.match_time || item.time || '';
    var heat = item.heat ? '热度 ' + item.heat : '';
    var routes = kind === 'replay' ? (item.recording_count || 1) + ' 路录像' : item.signal_count ? item.signal_count + ' 路直播' : '';
    var sport = item.sport || ({ '1': '足球', '2': '篮球', '3': '网球', '19': '台球' }[String(item.category || item.type)] || '足球');
    var artStyle = image ? ' style="background-image:url(\'' + escapeHTML(image) + '\')"' : '';
    var caption = time || (kind === 'replay' ? '完整录像' : '');
    return '<button class="match-card focusable" data-focus="' + cardId + '" data-source="' + escapeHTML(source) + '" data-room="' + escapeHTML(room) + '" data-match="' + escapeHTML(id) + '" data-kind="' + kind + '" data-title="' + escapeHTML(title) + '" data-team-home="' + escapeHTML(homeTeam(item)) + '" data-team-away="' + escapeHTML(awayTeam(item)) + '" data-league="' + escapeHTML(item.league_name || '') + '"><div class="card-art" data-sport="' + escapeHTML(sport) + '"' + artStyle + '><span class="card-badge ' + (badge === '即将开始' ? 'upcoming' : badge === '已结束' ? 'finished' : kind === 'replay' ? 'replay' : '') + '">' + badge + '</span><span class="card-source source-' + escapeHTML(source) + '">' + escapeHTML(item.source_label || (source === 'doubao' ? '豆包直播' : '咖啡直播')) + '</span><div class="art-meta"><span>' + escapeHTML(item.league_name || '') + '</span><span class="heat">' + escapeHTML(heat) + '</span></div></div><div class="card-info"><div class="teams"><span class="team-name">' + escapeHTML(homeTeam(item)) + '</span><span class="score">' + escapeHTML(item.home_score == null || status === 'upcoming' ? '' : item.home_score) + '</span><span class="vs">VS</span><span class="score">' + escapeHTML(item.away_score == null || status === 'upcoming' ? '' : item.away_score) + '</span><span class="team-name">' + escapeHTML(awayTeam(item)) + '</span></div><div class="card-caption">' + (caption ? '<strong>' + escapeHTML(caption) + '</strong>' : '') + '<span>' + escapeHTML(routes) + '</span></div></div></button>';
  }
  function section(title, items, kind) { if (!items || !items.length) return title ? '<section class="feed-section" data-section-kind="' + kind + '"><div class="section-head"><h2 class="section-title">' + title + '</h2><span class="section-note">暂无内容</span></div><div class="card-grid" data-grid-kind="' + kind + '"></div></section>' : '<div class="state-panel"><div>暂无内容</div></div>'; var head = title ? '<div class="section-head"><h2 class="section-title">' + title + '</h2><span class="section-note">' + items.length + ' 场</span></div>' : ''; return '<section class="feed-section" data-section-kind="' + kind + '">' + head + '<div class="card-grid" data-grid-kind="' + kind + '">' + items.map(function (item) { return matchCard(item, kind); }).join('') + '</div></section>'; }
  function loadPage(restore) {
    var request = ++state.request; var previousFocus = restore || state.focused; var feedKey = state.page + ':' + state.category + ':' + state.source;
    if (paginationObserver) paginationObserver.disconnect();
    state.feeds[feedKey] = { page: 1, hasMore: false, total: null, loading: false, local: null, cursor: '' };
    pageTitle.textContent = pages[state.page][1];
    categorySlot.innerHTML = renderCategories();
    navButtons.forEach(function (button) { button.classList.toggle('is-active', button.getAttribute('data-page') === state.page); });
    if (state.page === 'support') {
      renderSupportPage(previousFocus);
      return;
    }
    renderState('正在加载', '正在获取赛事信息…', false);
    cardsFor(state.page, state.category, 1, function (err, data) {
      if (request !== state.request) return;
      if (err) { setConnection(false); renderState('内容加载失败', err.message || '请检查网络连接后重试。', true); return; }
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
      content.querySelectorAll('.match-card').forEach(function (card) { card.addEventListener('click', function () { openRoom(card); }); });
      categorySlot.querySelectorAll('.filter-chip').forEach(function (chip) { chip.addEventListener('click', function () { if (chip.getAttribute('data-filter') === 'source') state.source = chip.getAttribute('data-source'); else state.category = chip.getAttribute('data-category'); state.focused = chip.getAttribute('data-focus'); loadPage(state.focused); }); });
      var retry = content.querySelector('[data-action="retry"]'); if (retry) retry.addEventListener('click', function () { loadPage(); });
      var restored = previousFocus && focusById(previousFocus);
      if (!restored && (state.page === 'live' || state.page === 'schedule' || state.page === 'replay')) focusById('cat-' + state.category);
      else if (!restored) focusById(firstCardId());
      updatePagination(feedKey);
    });
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
  function appendItems(items, kind, targetGrid) {
    if (!items || !items.length || !targetGrid) return;
    var holder = document.createElement('div'); holder.innerHTML = items.map(function (item) { return matchCard(item, kind); }).join('');
    while (holder.firstChild) { var card = holder.firstChild; card.addEventListener('click', function () { openRoom(this); }); targetGrid.appendChild(card); }
  }
  function loadMore() {
    var feedKey = state.page + ':' + state.category + ':' + state.source; var feed = state.feeds[feedKey];
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
    cardsFor(state.page, state.category, nextPage, function (err, data) {
      if (state.page + ':' + state.category + ':' + state.source !== feedKey || state.feeds[feedKey] !== feed) return;
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
  function firstCardId() { var card = content.querySelector('.match-card'); return card ? card.getAttribute('data-focus') : 'nav-' + state.page; }
  function focusById(id) { if (!id) return false; var target = document.querySelector('[data-focus="' + id.replace(/"/g, '') + '"]'); if (!target) return false; target.focus(); state.focused = id; target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; }
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
      if (playerNext) { playerNext.focus(); if (playerNext.classList.contains('signal-button')) showSignalPanel(); }
      return;
    }
    if (current.classList.contains('nav-item')) {
      var navIndex = Array.prototype.indexOf.call(navButtons, current);
      if (direction === 'ArrowUp' && navIndex > 0) navButtons[navIndex - 1].focus();
      else if (direction === 'ArrowDown' && navIndex < navButtons.length - 1) navButtons[navIndex + 1].focus();
      else if (direction === 'ArrowRight') {
        if (state.page === 'support') { focusById('support-wechat'); return; }
        if (focusById('source-' + state.source)) return;
        focusById(firstCardId());
      }
      return;
    }
    if (current.classList.contains('support-card')) {
      var supportCards = Array.prototype.slice.call(content.querySelectorAll('.support-card')); var supportIndex = supportCards.indexOf(current);
      if (direction === 'ArrowLeft' && supportIndex > 0) supportCards[supportIndex - 1].focus();
      else if (direction === 'ArrowLeft') focusById('nav-support');
      else if (direction === 'ArrowRight' && supportIndex < supportCards.length - 1) supportCards[supportIndex + 1].focus();
      else if (direction === 'ArrowUp') focusById('nav-support');
      return;
    }
    if (current.classList.contains('filter-chip')) {
      var filterKind = current.getAttribute('data-filter'); var filterSelector = filterKind === 'source' ? '.source-chip' : '.category-chip:not(.source-chip)'; var chips = Array.prototype.slice.call(categorySlot.querySelectorAll(filterSelector)); var chipIndex = chips.indexOf(current);
      if (direction === 'ArrowLeft' && chipIndex > 0) chips[chipIndex - 1].focus();
      else if (direction === 'ArrowLeft') focusById('nav-' + state.page);
      else if (direction === 'ArrowRight' && chipIndex < chips.length - 1) chips[chipIndex + 1].focus();
      else if (direction === 'ArrowRight' && filterKind === 'source') focusById('cat-' + state.category);
      else if (direction === 'ArrowRight') focusById(firstCardId());
      else if (direction === 'ArrowDown' && filterKind === 'source') focusById('cat-' + state.category);
      else if (direction === 'ArrowDown') focusById(firstCardId());
      else if (direction === 'ArrowUp' && filterKind === 'category') focusById('source-' + state.source);
      else if (direction === 'ArrowUp') focusById('nav-' + state.page);
      return;
    }
    if (current.classList.contains('match-card')) {
      var cards = Array.prototype.slice.call(content.querySelectorAll('.match-card')); var nextCard = spatialTarget(current, cards, direction);
      if (nextCard) { nextCard.focus(); nextCard.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return; }
      if (direction === 'ArrowLeft') {
        var rowCards = cards.filter(function (card) { return Math.abs(card.getBoundingClientRect().top - current.getBoundingClientRect().top) < 8; });
        if (rowCards.length && rowCards[0] === current) focusById('nav-' + state.page);
      } else if (direction === 'ArrowUp') {
        var above = spatialTarget(current, cards, 'ArrowUp');
        if (!above && state.page !== 'home') focusById('cat-' + state.category);
        else if (!above) focusById('nav-' + state.page);
      }
      return;
    }
    var pageTargets = visibleFocusables(document.querySelector('.app-shell')); var pageNext = spatialTarget(current, pageTargets, direction);
    if (pageNext) pageNext.focus();
  }
  function showToast(message) { toast.textContent = message; toast.classList.add('visible'); window.setTimeout(function () { toast.classList.remove('visible'); }, 2300); }
  function openRoom(card) {
    var room = card.getAttribute('data-room'); var match = card.getAttribute('data-match'); var source = card.getAttribute('data-source') || 'kafei'; var title = card.getAttribute('data-title'); var kind = card.getAttribute('data-kind');
    var roomLabel = kind === 'replay' ? '回放' : '直播';
    state.focused = card.getAttribute('data-focus'); state.room = { title: title, previous: state.focused, card: card, roomId: room || match, matchId: match, source: source, kind: kind, signals: [], playing: false, ended: false };
    layer.hidden = false;
    layer.classList.remove('is-controls-hidden', 'is-fullscreen', 'is-ended');
    layer.innerHTML = '<section class="room-panel" role="dialog" aria-modal="true"><div class="player-area"><div class="video-wrap"><video id="room-video" class="player-surface focusable" data-focus="room-video" tabindex="-1" aria-label="' + roomLabel + '视频" playsinline></video><div id="video-placeholder" class="player-placeholder"><span class="state-spinner player-loading-spinner" aria-hidden="true"></span><span>正在获取' + roomLabel + '线路…</span></div><div class="player-topbar"><div class="player-title"><span class="live-label">' + roomLabel + '</span><div class="player-title-text"><strong>' + escapeHTML(title) + '</strong><small>' + escapeHTML(card.getAttribute('data-league')) + '</small></div></div><button class="close-button focusable" data-room-close="1" data-focus="room-close" aria-label="返回"><svg class="close-icon"><use xlink:href="#icon-back"></use></svg><span>返回</span></button></div><div id="signal-panel" class="signal-panel" aria-label="' + roomLabel + '线路" hidden><div class="signal-panel-title">选择线路</div><div id="signal-list" class="signal-list"><div class="section-note">正在获取…</div></div></div><div class="player-controls"><button id="player-toggle" class="player-control focusable" data-player-action="toggle" data-focus="player-toggle" aria-label="播放" title="播放"><svg id="player-icon" class="player-icon"><use xlink:href="#icon-play"></use></svg></button><button id="player-fullscreen" class="player-icon-button focusable" data-player-action="fullscreen" data-focus="player-fullscreen" aria-label="全屏" title="全屏"><svg id="fullscreen-icon" class="player-icon"><use xlink:href="#icon-fullscreen"></use></svg></button></div></div></div></section>';
    layer.querySelector('[data-room-close]').addEventListener('click', closeRoom);
    layer.onclick = function (e) { if (e.target === layer) closeRoom(); };
    layer.querySelector('[data-player-action="toggle"]').addEventListener('click', togglePlayback);
    layer.querySelector('[data-player-action="fullscreen"]').addEventListener('click', toggleFullscreen);
    var roomState = state.room;
    get('/api/v2/room/' + encodeURIComponent(roomState.source) + '/' + encodeURIComponent(roomState.roomId), { kind: roomState.kind }, function (err, response) {
      if (state.room !== roomState) return;
      var data = response && response.data || {}; var signals = data.signals || data.streams || data.archors || [];
      if (!Array.isArray(signals)) signals = Object.keys(signals).map(function (key) { return signals[key]; });
      if (!signals.length && data.stream_url) signals = [{ name: '默认线路', url: data.stream_url }];
      renderSignals(signals, err, data);
      if (!err && roomState.kind !== 'replay' && !isRoomFinished(data)) startRoomStatusPolling(roomState);
    });
    focusById('room-close');
  }
  function renderSignals(signals, err, roomData) {
    var list = document.getElementById('signal-list'); var panel = document.getElementById('signal-panel'); if (!list || !panel) return;
    if (err) { panel.hidden = true; setVideoPlaceholder(err.message, false); return; }
    if (state.room.kind !== 'replay' && isRoomFinished(roomData)) { panel.hidden = true; showPlaybackEnded('直播已结束'); return; }
    if (!signals.length) { panel.hidden = true; setVideoPlaceholder('当前没有可用线路', false); return; }
    state.room.signals = signals;
    list.innerHTML = signals.map(function (signal, index) { var label = signal.name || signal.title || signal.label || '线路 ' + (index + 1); return '<button class="signal-button focusable ' + (!index ? 'is-active' : '') + '" data-signal="' + index + '" data-focus="signal-' + index + '">' + escapeHTML(label) + '</button>'; }).join('');
    list.querySelectorAll('.signal-button').forEach(function (button) { button.addEventListener('click', function () { selectSignal(Number(button.getAttribute('data-signal')), signals); }); });
    panel.hidden = signals.length < 2;
    selectSignal(0, signals);
    if (signals.length > 1) { focusById('signal-0'); showSignalPanel(); } else focusById('player-toggle');
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
      var surface = document.getElementById('room-video');
      if (layer.contains(document.activeElement) && document.activeElement !== surface && document.activeElement.classList.contains('focusable')) return;
      if (surface && layer.contains(document.activeElement)) surface.focus();
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
    state.room.playing = false; state.room.ended = true;
    if (roomStatusTimer) window.clearInterval(roomStatusTimer);
    roomStatusTimer = null;
    var video = document.getElementById('room-video');
    if (video && !video.paused) video.pause();
    if (state.hls && state.hls.stopLoad) state.hls.stopLoad();
    var panel = document.getElementById('signal-panel'); if (panel) panel.hidden = true;
    var liveLabel = layer.querySelector('.live-label'); if (liveLabel) liveLabel.textContent = '已结束';
    layer.classList.add('is-ended');
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
    if (video.ended) { showPlaybackEnded(state.room.kind === 'live' ? '直播已结束' : '播放已结束'); return; }
    state.room.playing = false; updatePlayerControl(); showPlayerControls();
    if (error && error.name === 'NotAllowedError') setVideoPlaceholder('自动播放受限，按播放键继续', false);
    else setVideoPlaceholder(state.room.kind === 'replay' ? '回放加载失败，请尝试其他线路' : '直播流中断，请尝试其他线路', false);
  }
  function requestVideoPlayback(video) {
    try {
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function (error) { handlePlaybackFailure(video, error); });
    } catch (error) { handlePlaybackFailure(video, error); }
  }
  function togglePlayback() {
    var video = document.getElementById('room-video'); if (!video || (state.room && state.room.ended)) return;
    if (video.paused) requestVideoPlayback(video);
    else { video.pause(); showToast('已暂停'); }
    updatePlayerControl();
  }
  function updatePlayerControl() {
    var video = document.getElementById('room-video'); var button = document.getElementById('player-toggle'); if (!video || !button) return;
    var ended = !!(state.room && state.room.ended); var playing = !ended && !video.paused && !video.ended;
    var icon = document.getElementById('player-icon');
    if (icon) icon.innerHTML = '<use xlink:href="#icon-' + (playing ? 'pause' : 'play') + '"></use>';
    button.setAttribute('aria-label', ended ? '直播已结束' : playing ? '暂停' : '播放');
    button.setAttribute('title', ended ? '直播已结束' : playing ? '暂停' : '播放');
  }
  function selectSignal(index, signals) {
    var signal = signals[index] || {}; var url = signal.url || signal.stream_url || signal.play_url || signal.m3u8 || '';
    layer.querySelectorAll('.signal-button').forEach(function (button) { button.classList.toggle('is-active', Number(button.getAttribute('data-signal')) === index); });
    showSignalPanel();
    if (signal.resolve) {
      setVideoPlaceholder('正在获取直播源…', true);
      api(signal.resolve, function (resolveError, resolveResponse) {
        if (!state.room || !state.room.signals || state.room.signals[index] !== signal) return;
        if (resolveError) { setVideoPlaceholder('直播源获取失败，请重试', false); showPlayerControls(); return; }
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
    if (!url) { showToast('该线路暂不可用'); return; }
    state.room.ended = false; layer.classList.remove('is-ended');
    var video = document.getElementById('room-video'); var placeholder = document.getElementById('video-placeholder');
    setVideoPlaceholder('正在连接直播源…', true);
    if (window.KafeiTVPlayer && typeof window.KafeiTVPlayer.open === 'function') { window.KafeiTVPlayer.open(url, state.room.title); setVideoPlaceholder('正在电视播放器中打开…', true); return; }
    if (state.hls && state.hls.destroy) { state.hls.destroy(); state.hls = null; }
    video.pause(); video.removeAttribute('src'); video.load();
    video.onerror = function () { handlePlaybackFailure(video, video.error || null); };
    video.onplaying = function () { if (state.room) state.room.playing = true; placeholder.hidden = true; updatePlayerControl(); video.focus(); showPlayerControls(); };
    video.onpause = function () { if (state.room) state.room.playing = false; updatePlayerControl(); showPlayerControls(); };
    video.onwaiting = function () { if (state.room) state.room.playing = false; setVideoPlaceholder('正在缓冲…', true); showPlayerControls(); };
    video.onended = function () { showPlaybackEnded(state.room && state.room.kind === 'live' ? '直播已结束' : '播放已结束'); };
    if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; requestVideoPlayback(video); }
    else if (window.Hls && window.Hls.isSupported()) {
      state.hls = new window.Hls();
      state.hls.loadSource(url); state.hls.attachMedia(video);
      state.hls.on(window.Hls.Events.MANIFEST_PARSED, function () { requestVideoPlayback(video); });
      state.hls.on(window.Hls.Events.ERROR, function (event, detail) { if (detail && detail.fatal) handlePlaybackFailure(video, new Error('HLS playback error')); });
    }
    else setVideoPlaceholder('当前设备无法播放 HLS', false);
    if (!window.Hls && !hlsScriptRequested) { hlsScriptRequested = true; var script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'; script.onload = function () { selectSignal(index, signals); }; script.onerror = function () { setVideoPlaceholder('播放器加载失败', false); }; document.head.appendChild(script); }
  }
  function closeRoom() { if (!state.room) return; var previous = state.room.previous; var video = document.getElementById('room-video'); if (signalHideTimer) window.clearTimeout(signalHideTimer); if (controlsHideTimer) window.clearTimeout(controlsHideTimer); if (roomStatusTimer) window.clearInterval(roomStatusTimer); signalHideTimer = null; controlsHideTimer = null; roomStatusTimer = null; if (video) { video.pause(); video.removeAttribute('src'); video.load(); } if (state.hls && state.hls.destroy) state.hls.destroy(); state.hls = null; if (window.KafeiTVPlayer && window.KafeiTVPlayer.close) window.KafeiTVPlayer.close(); var exit = document.exitFullscreen || document.webkitExitFullscreen; if (fullscreenActive() && exit) { var exitRequest = exit.call(document); if (exitRequest && exitRequest.catch) exitRequest.catch(function () {}); } state.room = null; layer.classList.remove('is-controls-hidden', 'is-ended'); layer.hidden = true; layer.innerHTML = ''; focusById(previous); }
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
    if (target && !state.room && document.activeElement !== target) target.focus();
  });
  layer.addEventListener('mouseover', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('.focusable') : null;
    if (target && state.room && document.activeElement !== target) { target.focus(); if (target.classList.contains('signal-button')) showSignalPanel(); }
  });
  layer.addEventListener('mousemove', function () { if (state.room) showPlayerControls(); });
  document.addEventListener('focusin', function (event) { var target = event.target; if (target && target.getAttribute) { var id = target.getAttribute('data-focus'); if (id) state.focused = id; if (state.room && layer.contains(target) && target.id !== 'room-video' && target.classList.contains('focusable')) showPlayerControls(); } });
  // 旧版 WebView 不支持 :focus-within,用 .is-expanded 代替(CSS 里已配套)
  var sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    var syncSidebar = function () {
      window.setTimeout(function () {
        var active = document.activeElement;
        if (active && sidebar.contains(active)) sidebar.classList.add('is-expanded');
        else sidebar.classList.remove('is-expanded');
      }, 0);
    };
    sidebar.addEventListener('focusin', syncSidebar);
    sidebar.addEventListener('focusout', syncSidebar);
  }
  document.addEventListener('fullscreenchange', updateFullscreenControl);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControl);
  window.MingmingTVKey = function (code) { var keys = { 19: 'ArrowUp', 20: 'ArrowDown', 21: 'ArrowLeft', 22: 'ArrowRight', 23: 'Enter', 66: 'Enter', 4: 'Escape' }; var key = keys[code]; if (!key) return; var event = document.createEvent('Event'); event.initEvent('keydown', true, true); Object.defineProperty(event, 'key', { value: key }); document.dispatchEvent(event); };
  window.MingmingTVBack = function () { if (state.room) { closeRoom(); return true; } if (state.supportModal) { closeSupportModal(); return true; } return false; };
  window.MingmingTVBackground = function () { var video = document.getElementById('room-video'); if (video) video.pause(); };
  window.MingmingTVForeground = function () { };
  window.addEventListener('load', function () { api('/health', function (err, health) { setConnection(!err && health.ready); }); loadPage('card-'); });
}());