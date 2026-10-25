const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../ui/feed-request.js');
const { create } = require('../ui/feed-pager.js');

function clock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(delay) {
      const end = time + delay;
      while (true) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      time = end;
    },
    get pending() { return timers.size; }
  };
}
function error(status) { return Object.assign(new Error('HTTP ' + status), { status }); }
function harness() {
  const timer = clock(), requests = [], results = [];
  const controller = start({ ...timer, request(done, timeout) {
    const request = { done, timeout, aborted: false };
    requests.push(request);
    return { abort() { request.aborted = true; done(error(0)); } };
  }, done(...args) { results.push(args); } });
  return { timer, requests, results, controller };
}

test('a transient first failure recovers once without exposing an error page', () => {
  for (const status of [0, 408, 500, 502, 503, 504]) {
    const h = harness();
    h.requests[0].done(error(status));
    assert.equal(h.results.length, 0);
    h.timer.tick(199); assert.equal(h.requests.length, 1);
    h.timer.tick(1); assert.equal(h.requests.length, 2);
    h.requests[1].done(null, { items: [1] });
    assert.deepEqual(h.results, [[null, { items: [1] }]]);
    h.timer.tick(10000);
    assert.equal(h.requests.length, 2); assert.equal(h.timer.pending, 0);
  }
});

test('persistent failures stop after two attempts and permanent rejection is not retried', () => {
  const h = harness(); h.requests[0].done(error(502)); h.timer.tick(200);
  h.requests[1].done(error(502)); h.timer.tick(10000);
  assert.equal(h.requests.length, 2); assert.equal(h.results.length, 1);
  assert.equal(h.results[0][0].status, 502);
  for (const status of [400, 401, 403, 404, 429]) {
    const permanent = harness(); permanent.requests[0].done(error(status)); permanent.timer.tick(10000);
    assert.equal(permanent.requests.length, 1); assert.equal(permanent.results.length, 1);
  }
});

test('retry shares the original eight-second deadline and aborts a stuck request', () => {
  const h = harness(); assert.equal(h.requests[0].timeout, 6200);
  h.timer.tick(6000); h.requests[0].done(error(504)); h.timer.tick(200);
  assert.equal(h.requests[1].timeout, 1800);
  h.timer.tick(1800);
  assert.equal(h.results.length, 1); assert.equal(h.requests[1].aborted, true);
  assert.equal(h.results[0][0].status, 408);
  h.requests[1].done(null, { stale: true });
  assert.equal(h.results.length, 1); assert.equal(h.timer.pending, 0);
});

test('switching source cancels retry timers and ignores abort callbacks and late results', () => {
  for (const waiting of [false, true]) {
    const h = harness();
    if (waiting) h.requests[0].done(error(502));
    h.controller.abort(); h.controller.abort(); h.timer.tick(10000);
    h.requests[0].done(null, { oldSource: true });
    assert.equal(h.results.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.timer.pending, 0);
    if (!waiting) assert.equal(h.requests[0].aborted, true);
  }
});

test('synchronous completion and duplicate callbacks cannot create phantom attempts', () => {
  const timer = clock(); let calls = 0; const results = [];
  start({ ...timer, request(done) { calls++; done(error(502)); done(null, { invalid: true }); return { abort() { throw new Error('completed request'); } }; }, done(error) { results.push(error); } });
  timer.tick(10000);
  assert.equal(calls, 2); assert.equal(results.length, 1); assert.equal(results[0].status, 502);
});

test('one source can retry while the other source remains usable and continues paging', () => {
  const timer = clock(), requests = [], cards = [];
  const pager = create({ sources: ['doubao', 'kafei'], request(source, page, cursor, done) {
    return start({ ...timer, request(complete) {
      const request = { source, page, cursor, complete, aborted: false }; requests.push(request);
      return { abort() { request.aborted = true; complete(error(0)); } };
    }, done });
  }, onChange(event) { cards.push(...event.items); } });
  pager.start();
  requests[0].complete(error(502));
  requests[1].complete(null, { items: [{ id: 'kafei-1' }], hasMore: true });
  assert.equal(pager.snapshot().states.doubao.loading, true);
  assert.deepEqual(cards.map(c => c.id), ['kafei-1']);
  pager.loadMore(); assert.equal(requests[2].source, 'kafei'); assert.equal(requests[2].page, 2);
  timer.tick(200); assert.equal(requests[3].source, 'doubao'); assert.equal(requests[3].page, 1);
  requests[3].complete(null, { items: [{ id: 'doubao-1' }] });
  const count = cards.length;
  pager.abort(); requests[2].complete(null, { items: [{ id: 'late-card' }] }); timer.tick(10000);
  assert.equal(cards.length, count); assert.equal(requests.length, 4); assert.equal(timer.pending, 0);
});
