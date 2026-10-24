(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TVFeedPager = factory();
}(this, function () {
  'use strict';
  function create(options) {
    var active = true; var seen = {}; var entries = {};
    var names = options.sources.slice();
    names.forEach(function (name) { entries[name] = { source: name, page: 0, cursor: '', loading: false, received: false, retrying: false, done: false, error: null, request: null, status: 'loading' }; });
    function snapshot() {
      var states = {}; var loading = false; var hasMore = false; var failed = false;
      names.forEach(function (name) {
        var entry = entries[name];
        states[name] = { status: entry.loading ? 'loading' : entry.error ? 'error' : entry.status, page: entry.page, received: entry.received, loading: entry.loading, retrying: entry.retrying, done: entry.done, message: entry.error && entry.error.message || '' };
        loading = loading || entry.loading || !entry.received; failed = failed || !!entry.error;
        hasMore = hasMore || (!entry.done && !entry.error);
      });
      return { states: states, loading: loading, hasMore: hasMore, failed: failed };
    }
    function notify(source, items) { if (active) options.onChange({ source: source, items: items || [], snapshot: snapshot() }); }
    function fetchPage(name) {
      var entry = entries[name];
      if (!active || entry.loading || entry.done || entry.error) return;
      entry.loading = true;
      var page = entry.page + 1; var cursor = entry.cursor; var finished = false;
      function complete(error, data) {
        if (!active || finished) return;
        finished = true; entry.loading = false; entry.retrying = false; entry.request = null; entry.received = true;
        if (error) { entry.error = error; notify(name); return; }
        data = data || {}; var rows = Array.isArray(data.items) ? data.items : []; var added = [];
        rows.forEach(function (item) {
          var identity = item.room_id || item.play_id || item.replay_id || item.match_id || item.id;
          var key = name + ':' + identity;
          if (identity != null && seen[key]) return;
          if (identity != null) seen[key] = true;
          added.push(item);
        });
        entry.page = page; entry.cursor = data.nextCursor || '';
        entry.done = !data.hasMore || !rows.length || !added.length || (!!cursor && entry.cursor === cursor);
        entry.status = data.sources && data.sources[name] && data.sources[name].status || 'ok';
        notify(name, added);
      }
      notify(name);
      try {
        var request = options.request(name, page, cursor, complete);
        if (!finished && active) entry.request = request;
      } catch (error) { complete(error); }
    }
    return {
      start: function () { names.forEach(fetchPage); },
      loadMore: function () { names.forEach(fetchPage); },
      retry: function (name) { if (!active || !entries[name] || !entries[name].error) return; entries[name].error = null; entries[name].retrying = true; fetchPage(name); },
      snapshot: snapshot,
      abort: function () {
        active = false;
        names.forEach(function (name) { var request = entries[name].request; if (request && request.abort) request.abort(); entries[name].request = null; });
      }
    };
  }
  return { create: create };
}));
