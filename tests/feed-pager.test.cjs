const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../ui/feed-pager.js');

function harness() {
  const requests = [], events = [], cards = [];
  const pager = create({
    sources: ['doubao', 'kafei'],
    request(source, page, cursor, done) {
      const request = { source, page, cursor, done, aborted: false, answered: false };
      requests.push(request);
      return { abort() { request.aborted = true; } };
    },
    onChange(event) { events.push(event); cards.push(...event.items); }
  });
  function reply(source, data, error) {
    const request = requests.find(r => r.source === source && !r.answered);
    assert.ok(request, 'expected an outstanding request for ' + source);
    request.answered = true; request.done(error || null, data);
  }
  return { pager, requests, events, cards, reply };
}
function data(source, ids, hasMore = false, cursor = '') {
  return { items: ids.map(id => ({ source, id, room_id: String(id) })), hasMore, nextCursor: cursor, sources: { [source]: { status: 'ok' } } };
}

test('fast source becomes usable before the slow source finishes', () => {
  const h = harness(); h.pager.start();
  assert.deepEqual(h.requests.map(r => r.source), ['doubao', 'kafei']);
  h.reply('doubao', data('doubao', [1, 2]));
  assert.deepEqual(h.cards.map(c => c.source), ['doubao', 'doubao']);
  assert.equal(h.pager.snapshot().loading, true);
  h.reply('kafei', data('kafei', [3]));
  assert.deepEqual(h.cards.map(c => c.id), [1, 2, 3]);
  assert.equal(h.pager.snapshot().loading, false);
});

test('pagination uses each source cursor and never waits for another source', () => {
  const h = harness(); h.pager.start();
  h.reply('doubao', data('doubao', [1], true, 'doubao-next'));
  h.pager.loadMore(); h.pager.loadMore();
  assert.deepEqual(h.requests.map(r => [r.source, r.page, r.cursor]), [['doubao', 1, ''], ['kafei', 1, ''], ['doubao', 2, 'doubao-next']]);
  h.reply('doubao', data('doubao', [2]));
  h.reply('kafei', data('kafei', [3], true, 'kafei-next'));
  h.pager.loadMore();
  assert.deepEqual(h.requests.at(-1).source, 'kafei');
  assert.deepEqual(h.requests.at(-1).cursor, 'kafei-next');
  h.reply('kafei', data('kafei', [4]));
  h.pager.loadMore();
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.cards.map(c => c.id), [1, 2, 3, 4]);
});

test('retry only repeats the failed source and page, preserving healthy cards', () => {
  const h = harness(); h.pager.start();
  h.reply('doubao', data('doubao', [1], true, 'cursor-2'));
  h.reply('kafei', null, new Error('HTTP 502'));
  h.pager.loadMore();
  h.reply('doubao', null, new Error('timeout'));
  const healthyCard = h.cards[0];
  h.pager.retry('doubao');
  assert.equal(h.pager.snapshot().states.doubao.retrying, true);
  assert.deepEqual(h.requests.at(-1).page, 2);
  assert.deepEqual(h.requests.at(-1).cursor, 'cursor-2');
  h.reply('doubao', data('doubao', [2]));
  h.pager.retry('kafei');
  assert.deepEqual(h.requests.at(-1).page, 1);
  assert.equal(h.requests.filter(r => r.source === 'doubao').length, 3);
  h.reply('kafei', data('kafei', [3]));
  assert.equal(h.cards[0], healthyCard);
  assert.equal(h.pager.snapshot().failed, false);
  assert.deepEqual(h.cards.map(c => c.id), [1, 2, 3]);
});

test('canceled pages abort both requests and ignore late success or failure', () => {
  const h = harness(); h.pager.start(); const count = h.events.length;
  h.pager.abort();
  assert.ok(h.requests.every(r => r.aborted));
  h.reply('doubao', data('doubao', [1]));
  h.reply('kafei', null, new Error('aborted'));
  h.pager.loadMore(); h.pager.retry('kafei');
  assert.equal(h.events.length, count);
  assert.equal(h.cards.length, 0);
  assert.equal(h.requests.length, 2);
});

test('same-source overlap is deduplicated but matching IDs across sources remain separate', () => {
  const h = harness(); h.pager.start();
  h.reply('doubao', data('doubao', [1, 2], true));
  h.reply('kafei', data('kafei', [1]));
  h.pager.loadMore(); h.reply('doubao', data('doubao', [2, 3]));
  assert.deepEqual(h.cards.map(c => c.source + ':' + c.id), ['doubao:1', 'doubao:2', 'kafei:1', 'doubao:3']);
});

test('empty or repeated pages stop automatic pagination', () => {
  const h = harness(); h.pager.start();
  h.reply('doubao', data('doubao', [], true));
  h.reply('kafei', data('kafei', [1], true));
  h.pager.loadMore(); h.reply('kafei', data('kafei', [1], true));
  h.pager.loadMore();
  assert.equal(h.requests.length, 3);
  assert.equal(h.pager.snapshot().hasMore, false);
});

test('an unchanged cursor cannot loop and one empty source does not hide another', () => {
  const h = harness(); h.pager.start();
  h.reply('doubao', data('doubao', [1], true, 'same'));
  h.reply('kafei', data('kafei', []));
  h.pager.loadMore(); h.reply('doubao', data('doubao', [2], true, 'same'));
  h.pager.loadMore();
  assert.deepEqual(h.cards.map(c => c.id), [1, 2]);
  assert.equal(h.requests.length, 3);
});

test('synchronous request failure does not stop the other source starting', () => {
  const sources = [], events = [];
  const pager = create({ sources: ['doubao', 'kafei'], request(source, page, cursor, done) { sources.push(source); if (source === 'doubao') throw new Error('offline'); done(null, data(source, [1])); }, onChange(event) { events.push(event); } });
  pager.start();
  assert.deepEqual(sources, ['doubao', 'kafei']);
  assert.equal(pager.snapshot().states.doubao.status, 'error');
  assert.equal(pager.snapshot().states.kafei.status, 'ok');
  assert.equal(events.filter(e => e.items.length).length, 1);
});
