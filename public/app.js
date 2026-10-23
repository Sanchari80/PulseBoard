/* Pulseboard dashboard – vanilla JS, no build step. */
(() => {
  'use strict';

  const API = (window.PULSEBOARD_API || '').replace(/\/$/, '');
  const REFRESH_MS = 10000;
  const SLOTS = 30; // beats shown per trace

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const state = {
    filter: 'active',
    q: '',
    status: null,
    publicDemoMode: false,
    seenAlertIds: null,
    lastBeat: new Map(), // api -> timestamp of newest beat already drawn
    timer: null,
    loading: false,
    shown: 20, // alerts rendered; "Show more" adds a page
  };
  const PAGE = 20;

  const EXAMPLE = [
    { api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 },
    { api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 },
  ];

  const TYPE_LABEL = {
    SERVER_ERROR: 'Server error',
    TIMEOUT: 'Timeout',
    CLIENT_ERROR: 'Request rejected',
    RATE_LIMITED: 'Rate limited',
    HIGH_RESPONSE_TIME: 'Slow response',
    LATENCY_SPIKE: 'Latency spike',
    ZERO_RECORDS: 'No records',
    MISSING_FIELD: 'Missing field',
    INVALID_FIELD: 'Invalid field',
    INCONSISTENT_PAYLOAD: 'Inconsistent payload',
    MALFORMED_RESPONSE: 'Malformed entry',
  };

  /* ---------------- storage helpers (may throw in private mode) ---------------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  /* ---------------- formatting ---------------- */
  const nf = new Intl.NumberFormat();
  const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${nf.format(ms)} ms`);
  const fmtNum = (n) => (n === null || n === undefined ? '—' : nf.format(n));
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const fullTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  /* ---------------- HTTP ---------------- */
  async function api(path, { method = 'GET', body, headers = {} } = {}, retried = false) {
    const key = store.sget('pb-key');
    const res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-api-key': key } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && !retried) {
      const entered = window.prompt('This monitor is write-protected. Enter the API key (MONITOR_API_KEY):');
      if (entered) {
        store.sset('pb-key', entered.trim());
        return api(path, { method, body, headers }, true);
      }
    }
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Request failed with status ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------- toasts ---------------- */
  function toast(message, { error = false, action, ms = 4200 } = {}) {
    const el = document.createElement('div');
    el.className = `toast${error ? ' toast--error' : ''}`;
    el.setAttribute('role', error ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = message;
    el.append(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); el.remove(); });
      el.append(b);
    }
    $('#toasts').append(el);
    setTimeout(() => el.remove(), ms);
  }

  async function withBusy(btn, fn) {
    if (btn.classList.contains('is-busy')) return;
    btn.classList.add('is-busy');
    btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('is-busy'); btn.disabled = false; }
  }

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('meta[name="theme-color"]').content = dark ? '#0a1513' : '#10302b';
  }
  applyTheme(store.get('pb-theme'));
  $('#themeBtn').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    store.set('pb-theme', next);
    applyTheme(next);
  });

  /* ---------------- system info ---------------- */
  function renderStatus(s) {
    state.publicDemoMode = Boolean(s.publicDemoMode);
    $('#demoNote').hidden = !state.publicDemoMode;
    const set = (k, text, on, title) => {
      const li = $(`#sysinfo [data-k="${k}"]`);
      li.classList.toggle('on', on);
      li.classList.toggle('off', !on);
      $('.v', li).textContent = text;
      li.title = title;
    };
    const ai = s.ai.provider === 'rule-based' ? 'Rule-based alerts' : `AI: ${s.ai.model}`;
    set('ai', ai, s.ai.provider !== 'rule-based', s.ai.provider === 'rule-based' ? 'No LLM key configured – alerts are written by the built-in rule-based writer' : `Alerts are written by ${s.ai.provider} (${s.ai.model})`);
    set('storage', s.storage === 'mongodb' ? 'MongoDB' : 'In-memory store', s.storage === 'mongodb', s.storage === 'mongodb' ? 'Alerts are stored in MongoDB' : 'Alerts are kept in memory and cleared on restart. Set MONGODB_URI to persist them.');
    set('poll', s.scheduler.enabled ? `Auto-poll every ${Math.round(s.scheduler.intervalMs / 1000)} s` : 'Auto-poll off', s.scheduler.enabled, s.scheduler.enabled ? `Polling: ${s.scheduler.targets.join(', ')}` : 'Set ENABLE_SCHEDULER=true to poll live endpoints automatically');
    $('#pollBtn').hidden = state.publicDemoMode || !s.scheduler.targets.length;
    $('#emailBtn').disabled = state.publicDemoMode || !s.email.enabled;
    $('#emailBtn').title = state.publicDemoMode ? 'Email is disabled in the public recruiter demo' : s.email.enabled ? 'Email a report of open alerts' : 'Email is not configured on the server';
  }

  /* ---------------- vitals monitor ---------------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
  const isFailure = (h) => h.status === 0 || h.status >= 500;

  function beatPath(h, x0, w, B) {
    const p = (fx, dy) => `${(x0 + fx * w).toFixed(2)},${(B + dy).toFixed(2)}`;
    if (isFailure(h)) {
      // flatline with a faint tremor: the call produced nothing
      return `M${p(0, 0)} L${p(0.3, 0)} L${p(0.4, -1.5)} L${p(0.5, 1.5)} L${p(0.6, -1)} L${p(0.7, 0)} L${p(1, 0)}`;
    }
    const ms = h.ms ?? 800;
    const A = 6 + Math.pow(Math.min(1, ms / 6000), 0.7) * 34;
    if (h.status >= 400) {
      // rejected request: short, irregular complex
      return `M${p(0, 0)} L${p(0.35, 0)} L${p(0.45, -A * 0.35)} L${p(0.52, 5)} L${p(0.6, -A * 0.2)} L${p(0.7, 0)} L${p(1, 0)}`;
    }
    return `M${p(0, 0)} L${p(0.3, 0)} Q${p(0.36, -6)} ${p(0.42, 0)} L${p(0.47, 4)} L${p(0.52, -A)} L${p(0.57, 7)} L${p(0.62, 0)} Q${p(0.73, -9)} ${p(0.84, 0)} L${p(1, 0)}`;
  }

  function traceSvg(apiName, history) {
    const W = 600;
    const H = 56;
    const B = 40;
    const w = W / SLOTS;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const base = document.createElementNS(SVGNS, 'path');
    base.setAttribute('d', `M0 ${B}H${W}`);
    base.setAttribute('class', 't-ok');
    base.setAttribute('opacity', '0.18');
    svg.append(base);

    const recent = history.slice(-SLOTS);
    const offset = SLOTS - recent.length; // newest beat sits at the right edge
    const prevNewest = state.lastBeat.get(apiName);
    recent.forEach((h, i) => {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', beatPath(h, (offset + i) * w, w, B));
      const cls = h.severity === 'critical' ? 't-crit' : h.severity === 'warning' ? 't-warn' : 't-ok';
      const isNew = prevNewest !== undefined && Date.parse(h.t) > prevNewest;
      path.setAttribute('class', cls + (isNew ? ' t-new' : ''));
      path.setAttribute('pathLength', '1');
      svg.append(path);
    });
    if (recent.length) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', W - 1);
      dot.setAttribute('cy', B);
      dot.setAttribute('r', '2.6');
      svg.append(dot);
      state.lastBeat.set(apiName, Date.parse(recent.at(-1).t));
    }
    return svg;
  }

  function read(value, label, tone, extra = '') {
    const d = document.createElement('div');
    d.className = `read read--${tone} ${extra}`;
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('small');
    s.textContent = label;
    d.append(b, s);
    return d;
  }

  function renderVitals(items) {
    const list = $('#vitals');
    $('#vitalsEmpty').hidden = items.length > 0;
    list.hidden = items.length === 0;
    const frag = document.createDocumentFragment();
    for (const a of items) {
      const li = document.createElement('li');
      li.className = 'vital';
      const s = a.lastSample || {};

      const id = document.createElement('div');
      id.className = 'vital__id';
      const name = document.createElement('div');
      name.className = 'vital__name';
      name.textContent = a.apiName;
      name.title = a.apiName;
      const sub = document.createElement('div');
      sub.className = 'vital__sub';
      sub.textContent = `${a.uptimePct ?? '—'}% healthy · ${a.checks} check${a.checks === 1 ? '' : 's'}`;
      id.append(name, sub);

      const trace = document.createElement('div');
      trace.className = 'vital__trace';
      trace.append(traceSvg(a.apiName, a.history));

      const reads = document.createElement('div');
      reads.className = 'vital__read';
      const failed = s.status_code === 0 || s.status_code >= 500;
      const msTone = a.lastSeverity === 'healthy' ? 'ok' : s.response_time_ms >= (state.status?.thresholds.responseTimeCriticalMs ?? 5000) ? 'crit' : s.response_time_ms >= (state.status?.thresholds.responseTimeWarnMs ?? 2000) ? 'warn' : 'ok';
      reads.append(
        read(fmtMs(s.response_time_ms), 'latency', msTone),
        read(s.status_code === null || s.status_code === undefined ? '—' : s.status_code === 0 ? 'none' : String(s.status_code), 'status', failed ? 'crit' : s.status_code >= 400 ? 'warn' : 'ok'),
        read(fmtNum(s.records_returned), 'records', s.records_returned === 0 || s.records_returned < 0 || s.records_returned == null ? 'warn' : 'ok', 'read--records')
      );
      li.append(id, trace, reads);
      frag.append(li);
    }
    list.replaceChildren(frag);
  }

  /* ---------------- alerts ---------------- */
  function metricChips(a) {
    const s = a.sample || {};
    const types = new Map((a.anomalies || []).map((x) => [x.type, x.severity]));
    const chips = [];
    if (a.occurrences > 1) {
      const l = document.createElement('span');
      l.className = 'metric-label';
      l.textContent = 'Latest check';
      chips.push(l);
    }
    const add = (label, value, tone) => {
      const el = document.createElement('span');
      el.className = `metric${tone ? ` metric--${tone}` : ''}`;
      const b = document.createElement('b');
      b.textContent = value;
      el.append(b, document.createTextNode(` ${label}`));
      chips.push(el);
    };
    if (s.status_code !== undefined && s.status_code !== null) add('status', s.status_code === 0 ? 'no' : s.status_code, types.has('SERVER_ERROR') || types.has('TIMEOUT') ? 'bad' : types.has('CLIENT_ERROR') || types.has('RATE_LIMITED') ? 'warn' : '');
    if (s.response_time_ms !== undefined && s.response_time_ms !== null) add('', fmtMs(s.response_time_ms), types.get('HIGH_RESPONSE_TIME') === 'critical' ? 'bad' : types.has('HIGH_RESPONSE_TIME') || types.has('LATENCY_SPIKE') ? 'warn' : '');
    if (s.records_returned !== undefined && s.records_returned !== null) add('records', fmtNum(s.records_returned), types.has('ZERO_RECORDS') || types.has('INCONSISTENT_PAYLOAD') || types.has('INVALID_FIELD') ? 'warn' : '');
    for (const t of a.types || []) if (TYPE_LABEL[t]) add('', TYPE_LABEL[t], '');
    return chips;
  }

  function sourceText(a) {
    const writer = !a.aiSource || a.aiSource === 'rule-based' ? 'Written by the rule-based writer' : `Written by AI (${a.aiSource.replace(':', ', ')})`;
    const via = { api: 'POST /monitor', file: 'file upload', sample: 'sample file', simulation: 'simulation', scheduler: 'auto-poll' }[a.source] || a.source;
    return `${writer}. First seen ${fullTime(a.firstSeenAt)} via ${via}.${a.resolvedAt ? ` Resolved ${fullTime(a.resolvedAt)}.` : ''}`;
  }

  function renderAlerts(items) {
    const tpl = $('#alertTpl');
    const list = $('#alertList');
    const fresh = state.seenAlertIds;
    const frag = document.createDocumentFragment();

    const more = $('#more');
    more.hidden = items.length <= state.shown;
    $('#moreBtn').textContent = `Show ${Math.min(PAGE, items.length - state.shown)} more of ${items.length - state.shown} remaining`;

    for (const a of items.slice(0, state.shown)) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const resolved = a.status === 'resolved';
      node.dataset.id = a.id;
      node.classList.add(resolved ? 'alert--resolved' : `alert--${a.severity}`);
      if (fresh && !fresh.has(a.id)) node.classList.add('alert--fresh');

      $('.alert__api', node).textContent = a.apiName;
      const sev = $('.sev', node);
      sev.textContent = resolved ? 'Resolved' : a.severity === 'critical' ? 'Critical' : 'Warning';
      sev.className = `sev sev--${resolved ? 'resolved' : a.severity}`;
      $('.alert__count', node).textContent = a.occurrences > 1 ? `Seen ${a.occurrences} times` : '';
      const time = $('.alert__time', node);
      time.dateTime = a.lastSeenAt;
      time.textContent = ago(a.lastSeenAt);
      time.title = `Last seen ${fullTime(a.lastSeenAt)}`;
      $('.alert__msg', node).textContent = a.message;
      $('.alert__metrics', node).append(...metricChips(a));

      const dl = $('.alert__dl', node);
      for (const [label, val] of [['Likely cause', a.likelyCause], ['Impact', a.impact], ['Next step', a.recommendedAction]]) {
        if (!val) continue;
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = val;
        dl.append(dt, dd);
      }
      const findings = $('.alert__findings', node);
      for (const f of a.anomalies || []) {
        const li = document.createElement('li');
        li.className = `f-${f.severity}`;
        li.textContent = f.detail;
        findings.append(li);
      }
      $('.alert__source', node).textContent = sourceText(a);

      const btn = $('[data-act]', node);
      btn.dataset.act = resolved ? 'reopen' : 'resolve';
      btn.textContent = resolved ? 'Reopen' : 'Resolve';
      btn.setAttribute('aria-label', `${btn.textContent} alert for ${a.apiName}`);
      $('.alert__actions', node).hidden = state.publicDemoMode;
      frag.append(node);
    }
    // keep open "details" panels open across refreshes
    const open = new Set($$('.alert__more[open]', list).map((d) => d.closest('.alert').dataset.id));
    list.replaceChildren(frag);
    for (const id of open) {
      const d = $(`.alert[data-id="${CSS.escape(id)}"] .alert__more`, list);
      if (d) d.open = true;
    }
    state.seenAlertIds = new Set([...(fresh || []), ...items.map((a) => a.id)]);

    const empty = $('#alertsEmpty');
    empty.hidden = items.length > 0;
    if (!items.length) {
      empty.replaceChildren();
      const strong = document.createElement('strong');
      const p = document.createElement('span');
      if (state.q) {
        strong.textContent = 'No alerts match your search';
        p.textContent = 'Try another API name or clear the search box.';
      } else if (state.filter === 'resolved') {
        strong.textContent = 'Nothing resolved yet';
        p.textContent = 'Alerts you resolve are kept here for reference.';
      } else {
        strong.textContent = 'No open alerts';
        p.textContent = 'Every monitored API is within its limits. Run the sample file to see how alerts look.';
        const b = document.createElement('button');
        b.className = 'btn btn--primary';
        b.type = 'button';
        b.textContent = 'Run sample file';
        b.addEventListener('click', () => runSample(b));
        empty.append(strong, p, document.createElement('br'), b);
        return;
      }
      empty.append(strong, p);
    }
  }

  function renderStats(s) {
    $('#cActive').textContent = s.active;
    $('#cCritical').textContent = s.critical;
    $('#cWarning').textContent = s.warning;
    $('#cResolved').textContent = s.resolved;
    $('#resolveAllBtn').disabled = s.active === 0 || state.publicDemoMode;
    $('#resolveAllBtn').title = state.publicDemoMode ? 'Alert management is disabled in the public recruiter demo' : '';
    document.title = s.critical ? `(${s.critical}) Pulseboard · API Monitor` : 'Pulseboard · API Monitor';

    const ul = $('#byApi');
    ul.replaceChildren();
    if (!s.byApi.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'No open incidents.';
      ul.append(li);
      return;
    }
    const max = Math.max(...s.byApi.map((b) => b.occurrences || b.count));
    for (const b of s.byApi.slice(0, 8)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.apiName;
      btn.title = `Show alerts for ${b.apiName}`;
      btn.addEventListener('click', () => {
        $('#search').value = b.apiName;
        state.q = b.apiName;
        setFilter('active');
        $('#alerts').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      const small = document.createElement('small');
      small.textContent = `${b.count} open · ${b.occurrences} hit${b.occurrences === 1 ? '' : 's'}`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const i = document.createElement('i');
      i.className = b.severity === 'critical' ? 'crit' : '';
      i.style.width = `${Math.max(6, ((b.occurrences || b.count) / max) * 100)}%`;
      bar.append(i);
      li.append(btn, small, bar);
      ul.append(li);
    }
  }

  /* ---------------- data loading ---------------- */
  function alertsQuery() {
    const p = new URLSearchParams();
    if (state.filter === 'resolved') p.set('status', 'resolved');
    else {
      p.set('status', 'active');
      if (state.filter === 'critical' || state.filter === 'warning') p.set('severity', state.filter);
    }
    if (state.q) p.set('q', state.q);
    p.set('limit', '200');
    return `/alerts?${p}`;
  }

  async function refresh({ manual = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const btn = $('#refreshBtn');
    if (manual) btn.classList.add('is-spinning');
    try {
      const [alerts, stats, apis, status] = await Promise.all([api(alertsQuery()), api('/alerts/stats'), api('/monitor/apis'), state.status && !manual ? Promise.resolve(state.status) : api('/monitor/status')]);
      state.status = status;
      renderStatus(status);
      renderVitals(apis.items);
      renderAlerts(alerts.items);
      renderStats(stats);
      const sync = $('#sync');
      sync.classList.remove('is-error');
      sync.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
      const sync = $('#sync');
      sync.classList.add('is-error');
      sync.textContent = 'Cannot reach the server';
      if (manual) toast(`Refresh failed: ${err.message}`, { error: true });
    } finally {
      state.loading = false;
      btn.classList.remove('is-spinning');
      const startupLoader = $('#startupLoader');
      if (startupLoader) {
        startupLoader.classList.add('startup-loader--hidden');
        window.setTimeout(() => startupLoader.remove(), 350);
      }
    }
  }

  function schedule() {
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  /* ---------------- filters ---------------- */
  $('#moreBtn').addEventListener('click', () => { state.shown += PAGE; refresh(); });

  function setFilter(f) {
    state.filter = f;
    state.shown = PAGE;
    for (const t of $$('.triage__tab')) {
      const on = t.dataset.filter === f;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    }
    refresh();
  }
  for (const t of $$('.triage__tab')) t.addEventListener('click', () => setFilter(t.dataset.filter));

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.shown = PAGE; refresh(); }, 250);
  });

  /* ---------------- alert actions ---------------- */
  $('#alertList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('.alert');
    const act = btn.dataset.act;
    await withBusy(btn, async () => {
      try {
        await api(`/alerts/${encodeURIComponent(li.dataset.id)}/${act}`, { method: 'PATCH' });
        const name = $('.alert__api', li).textContent;
        if (act === 'resolve') toast(`Resolved alert for ${name}`, { action: { label: 'Undo', run: () => api(`/alerts/${encodeURIComponent(li.dataset.id)}/reopen`, { method: 'PATCH' }).then(() => refresh()).catch((er) => toast(er.message, { error: true })) } });
        else toast(`Reopened alert for ${name}`);
        await refresh();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  });

  $('#resolveAllBtn').addEventListener('click', (e) => {
    if (!window.confirm('Resolve every open alert? They will move to Resolved.')) return;
    withBusy(e.currentTarget, async () => {
      try {
        const r = await api('/alerts/resolve-all', { method: 'POST', body: {} });
        toast(`Resolved ${r.resolved} alert${r.resolved === 1 ? '' : 's'}`);
        await refresh();
      } catch (err) { toast(err.message, { error: true }); }
    });
  });

  $('#emailBtn').addEventListener('click', (e) => {
    if (state.status && !state.status.email.enabled) {
      toast('Email is not set up on the server. Add SMTP settings and EMAIL_TO to the .env file to send reports.', { error: true, ms: 6500 });
      return;
    }
    withBusy(e.currentTarget, async () => {
      try {
        const r = await api('/alerts/report/email', { method: 'POST', body: {} });
        toast(`Emailed a report of ${r.alerts} open alert${r.alerts === 1 ? '' : 's'}`);
      } catch (err) { toast(err.message, { error: true }); }
    });
  });

  /* ---------------- console ---------------- */
  for (const b of $$('.seg__btn')) {
    b.addEventListener('click', () => {
      for (const x of $$('.seg__btn')) {
        const on = x === b;
        x.classList.toggle('is-active', on);
        x.setAttribute('aria-selected', String(on));
      }
      for (const p of $$('.pane')) p.hidden = p.dataset.pane !== b.dataset.pane;
    });
  }

  const jsonInput = $('#jsonInput');
  jsonInput.value = JSON.stringify(EXAMPLE, null, 2);
  jsonInput.addEventListener('input', () => { jsonInput.classList.remove('is-invalid'); setMsg('#jsonMsg', ''); });

  function setMsg(sel, text, error = false) {
    const el = $(sel);
    el.textContent = text;
    el.classList.toggle('is-error', error);
  }

  function renderReceipt(result) {
    const { summary, results } = result;
    const box = $('#receipt');
    box.hidden = false;
    box.replaceChildren();

    const title = document.createElement('div');
    title.className = 'receipt__title';
    title.textContent = 'Last run';
    const when = document.createElement('span');
    when.textContent = `${summary.durationMs} ms · ${new Date().toLocaleTimeString()}`;
    title.append(when);

    const nums = document.createElement('div');
    nums.className = 'receipt__nums';
    for (const [n, l] of [[summary.received, 'received'], [summary.healthy, 'healthy'], [summary.anomalous, 'anomalies'], [summary.alertsCreated, `new alert${summary.alertsCreated === 1 ? '' : 's'}`]]) {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = n;
      const s = document.createElement('small');
      s.textContent = l;
      d.append(b, s);
      nums.append(d);
    }

    const ul = document.createElement('ul');
    ul.className = 'receipt__list';
    const order = { invalid: 0, anomaly: 1, healthy: 2 };
    const sorted = [...results].sort((a, b) => (order[a.status] - order[b.status]) || ((b.severity === 'critical') - (a.severity === 'critical')));
    for (const r of sorted.slice(0, 60)) {
      const li = document.createElement('li');
      li.className = r.status === 'anomaly' ? (r.severity === 'critical' ? 'r-critical' : 'r-anomaly') : `r-${r.status}`;
      const i = document.createElement('i');
      const name = document.createElement('span');
      name.textContent = r.api_name;
      const what = document.createElement('span');
      what.textContent = r.status === 'healthy' ? 'healthy' : r.anomalies.filter((x) => x.severity !== 'info').map((x) => TYPE_LABEL[x.type] || x.type).join(', ');
      li.append(i, name, what);
      ul.append(li);
    }

    const writer = document.createElement('p');
    writer.className = 'receipt__writer';
    writer.textContent = `${summary.alertsUpdated ? `${summary.alertsUpdated} existing alert${summary.alertsUpdated === 1 ? '' : 's'} updated instead of duplicated. ` : ''}Alert text by ${summary.ai.provider === 'rule-based' ? 'the rule-based writer' : `${summary.ai.provider} (${summary.ai.model})`}.`;

    box.append(title, nums, ul, writer);
  }

  async function submitBatch(body, { source } = {}) {
    const result = await api('/monitor', { method: 'POST', body, headers: source ? { 'x-monitor-source': source } : {} });
    afterRun(result);
    return result;
  }

  function afterRun(result) {
    renderReceipt(result);
    const s = result.summary;
    toast(s.anomalous ? `${s.anomalous} anomal${s.anomalous === 1 ? 'y' : 'ies'} found in ${s.received} responses` : `All ${s.received} responses look healthy`);
    if (state.filter === 'resolved') setFilter('active');
    else refresh();
  }

  $('#sendJsonBtn').addEventListener('click', (e) => {
    let body;
    try {
      body = JSON.parse(jsonInput.value);
    } catch (err) {
      jsonInput.classList.add('is-invalid');
      setMsg('#jsonMsg', `This is not valid JSON: ${err.message}`, true);
      jsonInput.focus();
      return;
    }
    withBusy(e.currentTarget, async () => {
      try { await submitBatch(body); setMsg('#jsonMsg', ''); } catch (err) { setMsg('#jsonMsg', err.message, true); }
    });
  });

  function runSample(btn) {
    return withBusy(btn, async () => {
      try { afterRun(await api('/monitor/sample', { method: 'POST', body: {} })); } catch (err) { toast(err.message, { error: true }); }
    });
  }
  $('#sampleBtn').addEventListener('click', (e) => runSample(e.currentTarget));

  const simCount = $('#simCount');
  simCount.addEventListener('input', () => { $('#simOut').textContent = simCount.value; });
  $('#simBtn').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try { afterRun(await api(`/monitor/simulate?count=${simCount.value}`, { method: 'POST', body: {} })); } catch (err) { toast(err.message, { error: true }); }
  }));
  $('#pollBtn').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    try {
      const r = await api('/monitor/poll', { method: 'POST', body: {} });
      if (r.skipped) toast(r.reason, { error: true });
      else { toast(`Polled ${r.targets} live endpoint${r.targets === 1 ? '' : 's'}`); refresh(); }
    } catch (err) { toast(err.message, { error: true }); }
  }));

  async function handleFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setMsg('#fileMsg', 'File is larger than 2 MB. Split it into smaller batches.', true); return; }
    let body;
    try {
      body = JSON.parse(await file.text());
    } catch (err) {
      setMsg('#fileMsg', `${file.name} is not valid JSON: ${err.message}`, true);
      return;
    }
    setMsg('#fileMsg', `Analysing ${file.name}…`);
    try {
      const r = await submitBatch(body, { source: 'file' });
      setMsg('#fileMsg', `${file.name}: ${r.summary.received} responses analysed.`);
    } catch (err) {
      setMsg('#fileMsg', err.message, true);
    }
  }
  const drop = $('#drop');
  $('#fileInput').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });

  // The console is collapsible only on small screens; there it starts closed so alerts show first.
  const narrow = matchMedia('(max-width: 900px)');
  if (narrow.matches) $('#consoleBox').open = false;
  $('#consoleBox > summary').addEventListener('click', (e) => { if (!narrow.matches) e.preventDefault(); });
  narrow.addEventListener('change', (e) => { if (!e.matches) $('#consoleBox').open = true; });

  $('#refreshBtn').addEventListener('click', () => refresh({ manual: true }));

  refresh({ manual: false }).then(() => { $('#sync').textContent ||= 'Live'; });
  schedule();
})();
