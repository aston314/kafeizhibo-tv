(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TVFeedRequest = factory();
}(this, function () {
  'use strict';
  // Only feed metadata uses this policy. The whole operation, including the
  // second attempt, has one deadline; switching away silences every callback.
  function start(options) {
    var now = options.now || Date.now;
    var schedule = options.setTimeout || setTimeout;
    var unschedule = options.clearTimeout || clearTimeout;
    var budget = options.budget || 8000;
    var deadline = now() + budget;
    var active = true; var attempts = 0; var request = null; var retryTimer = null;
    var deadlineTimer = schedule(function () {
      var error = new Error('请求超时'); error.status = 408;
      finish(error);
    }, budget);
    function finish(error, value) {
      if (!active) return;
      active = false; unschedule(deadlineTimer); unschedule(retryTimer);
      var pending = request; request = null;
      if (pending && pending.abort) pending.abort();
      options.done(error, value);
    }
    function send() {
      if (!active) return;
      retryTimer = null;
      var attempt = ++attempts; var answered = false;
      function complete(error, value) {
        if (!active || answered || attempt !== attempts) return;
        answered = true; request = null;
        if (!error) { finish(null, value); return; }
        var retryable = !error.canceled && (error.retryable || [0, 408, 500, 502, 503, 504].indexOf(error.status) !== -1);
        if (retryable && attempts < 2 && deadline - now() > 250) retryTimer = schedule(send, 200);
        else finish(error);
      }
      try {
        var pending = options.request(complete, Math.max(1, Math.min(6200, deadline - now())));
        if (active && !answered) request = pending;
      } catch (error) { complete(error); }
    }
    send();
    return { abort: function () {
      if (!active) return;
      active = false; unschedule(deadlineTimer); unschedule(retryTimer);
      if (request && request.abort) request.abort();
      request = null;
    } };
  }
  return { start: start };
}));
