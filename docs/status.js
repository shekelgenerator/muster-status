// Muster Status page. Reads the checker's files from the data branch
// (config.js says where) and incidents.json from this site, then draws the
// page. Everything from the data is set as text, never as HTML.
(function () {
  'use strict';

  var DAYS = 90;
  var DAY_MS = 86400000;
  var STALE_MS = 30 * 60000;
  var REFRESH_MS = 60000;
  var STAGES = { investigating: 'Investigating', identified: 'Found the cause', monitoring: 'Fixed, watching', resolved: 'Resolved' };

  // ── pure helpers (also used by test/page.test.js) ────────────────────────

  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

  // Minutes a component was down on a UTC day, from the outage list.
  function downMinutes(outages, id, key, now) {
    var start = Date.parse(key + 'T00:00:00Z');
    var end = start + DAY_MS;
    var total = 0;
    (outages || []).forEach(function (o) {
      if (o.component !== id) return;
      var a = Math.max(start, Date.parse(o.started_at));
      var b = Math.min(end, o.ended_at ? Date.parse(o.ended_at) : now);
      if (b > a) total += b - a;
    });
    return Math.round(total / 60000);
  }

  // Each outage that touched a UTC day, as UK times (Sam, 22 Oct), e.g.
  // "22:14–22:52", or "22:14–now" while it's still going. An outage running
  // past midnight shows its real start and end, with the date when it isn't
  // that day's.
  var UK = 'Europe/London';
  var fmtUkTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: UK });
  var fmtUkDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: UK });
  function ukDay(ms) { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: UK }).format(ms); }
  function outageSpans(outages, id, key, now) {
    var start = Date.parse(key + 'T00:00:00Z');
    var end = start + DAY_MS;
    var out = [];
    (outages || []).forEach(function (o) {
      if (o.component !== id) return;
      var a = Date.parse(o.started_at);
      var b = o.ended_at ? Date.parse(o.ended_at) : null;
      if (a < end && (b == null ? now : b) >= start) out.push({ start: a, end: b });
    });
    return out.sort(function (x, y) { return x.start - y.start; });
  }
  function spanText(span, key) {
    var t = function (ms, sameAs) { return (ukDay(ms) === sameAs ? '' : fmtUkDate.format(ms) + ' ') + fmtUkTime.format(ms); };
    return t(span.start, key) + '\u2013' + (span.end == null ? 'now' : t(span.end, ukDay(span.start)));
  }

  // A day's colour: grey with no checks, red for a real outage (2% of the
  // day's checks, about half an hour), amber for any failure or lots of slow.
  function dayState(d) {
    if (!d || !d.n) return 'none';
    if (d.down / d.n >= 0.02) return 'down';
    if (d.down > 0 || d.slow / d.n >= 0.1) return 'slow';
    return 'up';
  }

  // Share of checks that answered (slow counts as working) over the days given.
  function uptime(days) {
    var n = 0, ok = 0;
    Object.keys(days || {}).forEach(function (k) { n += days[k].n || 0; ok += (days[k].up || 0) + (days[k].slow || 0); });
    if (!n) return null;
    var pct = (ok / n) * 100;
    return pct >= 99.995 ? '100%' : (Math.floor(pct * 100) / 100).toFixed(2) + '%';
  }

  function headline(status) {
    var comps = (status && status.components) || [];
    var down = comps.filter(function (c) { return c.status === 'down'; });
    var slow = comps.filter(function (c) { return c.status === 'slow'; });
    if (down.length === 1) return down[0].name + ': down';
    if (down.length > 1) return down.length + ' services are down';
    if (slow.length === 1) return slow[0].name + ': slow';
    if (slow.length > 1) return 'Some services are slow';
    return comps.length ? 'Everything is working' : 'Checking Muster…';
  }

  function ago(ms, now) {
    var m = Math.max(0, Math.round((now - ms) / 60000));
    if (m < 1) return 'just now';
    if (m === 1) return '1 minute ago';
    if (m < 60) return m + ' minutes ago';
    var h = Math.round(m / 60);
    return h === 1 ? 'an hour ago' : h + ' hours ago';
  }

  function duration(min) {
    if (min < 1) return 'under a minute';
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  // What to list under "Happening now" and "The last 14 days".
  function events(incidents, outages, names, now) {
    var active = [], past = [];
    var since = now - 14 * DAY_MS;
    (incidents || []).forEach(function (inc) {
      var ups = (inc.updates || []).slice().sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at); });
      if (!ups.length) return;
      var e = { kind: 'incident', title: inc.title, components: inc.components || [], updates: ups, start: Date.parse(ups[ups.length - 1].at), end: ups[0].stage === 'resolved' ? Date.parse(ups[0].at) : null };
      if (!e.end) active.push(e);
      else if (e.end >= since) past.push(e);
    });
    var posted = active.concat(past);
    (outages || []).forEach(function (o) {
      var start = Date.parse(o.started_at);
      var end = o.ended_at ? Date.parse(o.ended_at) : null;
      // An incident someone posted about the same service at the same time
      // already tells the story, so the automatic card is left out.
      var covered = posted.some(function (inc) {
        return inc.components.indexOf(o.component) >= 0 && inc.start <= (end || now) && (inc.end || now) >= start;
      });
      if (covered) return;
      var e = { kind: 'outage', title: (names[o.component] || o.component) + (end ? ': outage' : ': down'), components: [o.component], start: start, end: end };
      if (!e.end) active.push(e);
      else if (e.end >= since) past.push(e);
    });
    var newest = function (a, b) { return (b.end || b.start) - (a.end || a.start); };
    return { active: active.sort(newest), past: past.sort(newest) };
  }

  var api = { dayKey: dayKey, downMinutes: downMinutes, outageSpans: outageSpans, spanText: spanText, dayState: dayState, uptime: uptime, headline: headline, ago: ago, duration: duration, events: events };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  window.MusterStatus = api;

  // ── page ─────────────────────────────────────────────────────────────────

  var $ = function (id) { return document.getElementById(id); };
  var fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  var fmtWhen = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  var fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Where the checker's files are. A test may point at a folder on this site
  // (?data=fixtures/x/); nothing else in the address is used.
  function dataBase() {
    var q = new URLSearchParams(location.search).get('data');
    if (q && /^[a-z0-9_\-/]+\/$/i.test(q) && q.indexOf('..') < 0) return q;
    return (window.MUSTER_STATUS && window.MUSTER_STATUS.data) || 'data/';
  }

  function getJson(url, fallback) {
    var bust = (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 60000);
    return fetch(url + bust, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : fallback; })
      .catch(function () { return fallback; });
  }

  var tip = null;
  function showTip(target) {
    if (!tip) { tip = el('div', 'tip'); tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.textContent = '';
    tip.appendChild(el('strong', null, target.dataset.day));
    tip.appendChild(document.createTextNode(target.dataset.note));
    // The times of each outage that day, UK time, one per line.
    (target.dataset.spans ? target.dataset.spans.split('|') : []).forEach(function (line) { tip.appendChild(el('span', 'tip-span', line)); });
    tip.hidden = false;
    var r = target.getBoundingClientRect();
    var w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function renderHero(status, now) {
    var hero = $('hero');
    hero.dataset.state = status ? status.overall : 'none';
    $('headline').textContent = status ? headline(status) : 'Status unavailable';
    var updated = status && Date.parse(status.updated_at);
    $('checked').textContent = updated
      ? 'Last checked ' + ago(updated, now) + ' (' + fmtTime.format(updated) + '). Checked every few minutes.'
      : "The latest checks couldn't be loaded. Try again in a minute.";
    var stale = $('stale');
    if (updated && now - updated > STALE_MS) {
      stale.hidden = false;
      stale.textContent = 'The last check ran ' + ago(updated, now) + '. GitHub sometimes runs the checks late, so this page may be behind.';
    } else {
      stale.hidden = true;
    }
  }

  function renderComponents(status, daily, outages, now) {
    var list = $('components');
    list.textContent = '';
    var labels = { up: 'Working', slow: 'Slow', down: 'Down', none: 'Not checked yet' };
    ((status && status.components) || []).forEach(function (c) {
      var li = el('li', 'comp');
      li.dataset.id = c.id;
      var head = el('div', 'comp-head');
      var names = el('div');
      names.appendChild(el('p', 'comp-name', c.name));
      names.appendChild(el('p', 'comp-desc', c.description));
      head.appendChild(names);
      head.appendChild(el('span', 'pill ' + (labels[c.status] ? c.status : 'none'), labels[c.status] || labels.none));
      li.appendChild(head);
      if (c.status === 'down' && c.detail) {
        li.appendChild(el('p', 'comp-detail', 'Since ' + fmtTime.format(Date.parse(c.since)) + ': ' + c.detail));
      }

      var days = (daily && daily[c.id]) || {};
      var bars = el('div', 'bars');
      bars.setAttribute('role', 'img');
      var u = uptime(days);
      bars.setAttribute('aria-label', c.name + ': ' + (u ? u + ' working' : 'no checks yet') + ' over the last ' + DAYS + ' days');
      for (var i = DAYS - 1; i >= 0; i--) {
        var ms = now - i * DAY_MS;
        var key = dayKey(ms);
        var d = days[key];
        var state = dayState(d);
        var b = el('span', 'bar ' + state);
        b.tabIndex = -1;
        b.dataset.day = fmtDay.format(ms) + (i === 0 ? ' (today)' : '');
        var mins = downMinutes(outages, c.id, key, now);
        b.dataset.note = state === 'none' ? 'No checks' : mins ? 'Down for ' + duration(mins) : state === 'slow' ? 'Slow or failing at times' : 'No problems';
        var spans = outageSpans(outages, c.id, key, now);
        if (spans.length) b.dataset.spans = spans.map(function (sp) { return spanText(sp, key); }).join('|');
        b.addEventListener('mouseenter', function (ev) { showTip(ev.currentTarget); });
        b.addEventListener('mouseleave', hideTip);
        bars.appendChild(b);
      }
      li.appendChild(bars);
      var scale = el('div', 'bar-scale');
      var left = el('span');
      left.appendChild(el('span', 'from-90', DAYS + ' days ago'));
      left.appendChild(el('span', 'from-30', '30 days ago'));
      scale.appendChild(left);
      scale.appendChild(el('span', 'uptime', u ? u + ' working' : 'No checks yet'));
      scale.appendChild(el('span', null, 'Today'));
      li.appendChild(scale);
      list.appendChild(li);
    });
  }

  function eventNode(e, names, now, open) {
    var box = el('article', 'event' + (open ? ' open' : ''));
    var head = el('div', 'event-head');
    head.appendChild(el('h3', 'event-title', e.title));
    var when = open
      ? 'Since ' + fmtWhen.format(e.start) + ' (' + duration(Math.round((now - e.start) / 60000)) + ')'
      : fmtWhen.format(e.start) + ' – ' + fmtTime.format(e.end) + ' (' + duration(Math.round((e.end - e.start) / 60000)) + ')';
    head.appendChild(el('span', 'event-when', when));
    box.appendChild(head);
    var affected = e.components.map(function (id) { return names[id]; }).filter(Boolean);
    if (e.kind === 'incident' && affected.length) box.appendChild(el('p', 'event-meta', 'Affected: ' + affected.join(', ')));
    if (e.kind === 'outage') box.appendChild(el('p', 'event-meta', open ? 'Found by our automatic checks. We\'re on it.' : 'Found by our automatic checks.'));
    if (e.updates) {
      var ul = el('ul', 'updates');
      e.updates.forEach(function (u) {
        var li = el('li');
        li.appendChild(el('span', 'stage', (STAGES[u.stage] || 'Update') + '. '));
        li.appendChild(document.createTextNode(u.text || ''));
        var t = el('time', null, fmtWhen.format(Date.parse(u.at)));
        t.setAttribute('datetime', u.at);
        li.appendChild(t);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    return box;
  }

  function renderEvents(status, incidents, outages, now) {
    var names = {};
    ((status && status.components) || []).forEach(function (c) { names[c.id] = c.name; });
    var ev = events(incidents, outages, names, now);
    var activeList = $('active-list');
    activeList.textContent = '';
    $('active').hidden = !ev.active.length;
    ev.active.forEach(function (e) { activeList.appendChild(eventNode(e, names, now, true)); });
    var hist = $('history');
    hist.textContent = '';
    if (!ev.past.length) hist.appendChild(el('p', 'empty', 'No problems in the last 14 days.'));
    ev.past.forEach(function (e) { hist.appendChild(eventNode(e, names, now, false)); });
  }

  function load() {
    var base = dataBase();
    return Promise.all([
      getJson(base + 'status.json', null),
      getJson(base + 'daily.json', {}),
      getJson(base + 'outages.json', []),
      getJson('incidents.json', []),
    ]).then(function (r) {
      var now = Date.now();
      renderHero(r[0], now);
      renderComponents(r[0], r[1], r[2], now);
      renderEvents(r[0], r[3], r[2], now);
      document.documentElement.dataset.loaded = '1';
    });
  }

  load();
  setInterval(load, REFRESH_MS);
  document.addEventListener('scroll', hideTip, { passive: true });
})();
