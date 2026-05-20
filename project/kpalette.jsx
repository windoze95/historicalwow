/* eslint-disable */
// Cmd-K palette + global search

window.KPalette = function KPalette({ open, onClose }) {
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [taskMatches, setTaskMatches] = React.useState([]);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ(''); setDebouncedQ(''); setActiveIdx(0); setTaskMatches([]);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Debounce input by 200ms before firing the API search.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Fire /api/search for task tables when query changes.
  React.useEffect(() => {
    if (!debouncedQ) { setTaskMatches([]); return; }
    let cancel = false;
    window.HistoricalWowData.fetchSearch(debouncedQ).then(rows => {
      if (!cancel) setTaskMatches(rows || []);
    }).catch(() => { if (!cancel) setTaskMatches([]); });
    return () => { cancel = true; };
  }, [debouncedQ]);

  const data = window.HistoricalWowData;

  const results = React.useMemo(() => {
    const ql = (debouncedQ || '').toLowerCase();
    if (!ql) {
      // Default: navigation shortcuts (no incident peek since those aren't eager-loaded)
      const tcount = (t) => data.manifest.tables.find(x => x.table === t)?.source_rows || 0;
      return [
        { group: 'Browse', items: [
          { kind: 'go', target: '/incidents',     label: 'All incidents',         sub: tcount('incident').toLocaleString() + ' records',         icon: 'incident' },
          { kind: 'go', target: '/changes',       label: 'All change requests',   sub: tcount('change_request').toLocaleString() + ' records',  icon: 'change' },
          { kind: 'go', target: '/problems',      label: 'Problems',              sub: tcount('problem').toLocaleString() + ' records',          icon: 'flag' },
          { kind: 'go', target: '/requests',      label: 'Service catalog requests', sub: tcount('sc_request').toLocaleString() + ' records',     icon: 'folder' },
          { kind: 'go', target: '/users',         label: 'Users',                 sub: tcount('sys_user').toLocaleString() + ' records',         icon: 'user' },
          { kind: 'go', target: '/groups',        label: 'Groups',                sub: tcount('sys_user_group').toLocaleString() + ' records',   icon: 'users' },
          { kind: 'go', target: '/cis',           label: 'Configuration items',   sub: tcount('cmdb_ci').toLocaleString() + ' records',          icon: 'ci' },
        ]},
      ];
    }

    // Group task results by table.
    const tasksByTable = {};
    for (const r of taskMatches) {
      const t = r._table;
      if (!tasksByTable[t]) tasksByTable[t] = [];
      if (tasksByTable[t].length >= 6) continue;
      tasksByTable[t].push({
        kind: t === 'incident' ? 'incident' : t === 'change_request' ? 'change' : 'task',
        table: t, sys_id: r.sys_id,
        label: r.number || (r.sys_id || '').slice(0, 8) + '…',
        sub: r.short_description || '—',
        meta: t,
      });
    }

    // Assignment groups — eager (sys_user_group, ~200 records).
    const groupHits = data.sys_user_group.filter((g) =>
      (g.name || '').toLowerCase().includes(ql) ||
      (g.description || '').toLowerCase().includes(ql)
    ).slice(0, 6).map(g => ({
      kind: 'group', sys_id: g.sys_id, label: g.name,
      sub: g.description || `${(g.member_sys_ids || []).length} member${(g.member_sys_ids || []).length === 1 ? '' : 's'}`,
    }));

    // Users — background-loaded lookup Map (sys_id → projection).
    const userHits = [];
    if (data.sys_user_lookup && data.sys_user_lookup.forEach) {
      data.sys_user_lookup.forEach((info, sys_id) => {
        if (userHits.length >= 6) return;
        if ((info.name || '').toLowerCase().includes(ql) ||
            (info.user_name || '').toLowerCase().includes(ql) ||
            (info.title || '').toLowerCase().includes(ql)) {
          userHits.push({ kind: 'user', sys_id, label: info.name, sub: info.title });
        }
      });
    }

    const cis = [];
    if (data.cmdb_ci_lookup && data.cmdb_ci_lookup.forEach) {
      data.cmdb_ci_lookup.forEach((info, sys_id) => {
        if (cis.length >= 6) return;
        if ((info.name || '').toLowerCase().includes(ql)) {
          cis.push({ kind: 'ci', sys_id, label: info.name, sub: info.sys_class_name });
        }
      });
    }

    const groups = [];
    // Groups and users lead — they're who/what the search is usually about.
    if (groupHits.length) groups.push({ group: 'Groups', items: groupHits });
    if (userHits.length)  groups.push({ group: 'Users',  items: userHits });
    // Incidents and changes get prominent placement when matched.
    if (tasksByTable.incident)        groups.push({ group: 'Incidents', items: tasksByTable.incident });
    if (tasksByTable.change_request)  groups.push({ group: 'Change requests', items: tasksByTable.change_request });
    for (const [t, items] of Object.entries(tasksByTable)) {
      if (t === 'incident' || t === 'change_request') continue;
      groups.push({ group: window.taskLabel(t, 'plural'), items });
    }
    if (cis.length)   groups.push({ group: 'Configuration items', items: cis });
    return groups;
    // Background lookups (sys_user_lookup, cmdb_ci_lookup) get a fresh
    // reference on arrival, so depending on them re-runs the memo once
    // they land — otherwise a query typed before they load shows empty
    // sections until the user edits the input.
  }, [debouncedQ, taskMatches, data.sys_user_lookup, data.cmdb_ci_lookup, data.sys_user_group]);

  const flat = React.useMemo(() => results.flatMap(g => g.items), [results]);

  React.useEffect(() => { setActiveIdx(0); }, [q]);

  const go = (item) => {
    onClose();
    if (item.kind === 'go') { window.navigate(item.target); return; }
    if (item.kind === 'incident') window.navigate(`/incidents/${item.sys_id}`);
    if (item.kind === 'change')   window.navigate(`/changes/${item.sys_id}`);
    if (item.kind === 'task')     window.navigate(window.recordUrl(item.table, item.sys_id));
    if (item.kind === 'user')     window.navigate(`/users/${item.sys_id}`);
    if (item.kind === 'ci')       window.navigate(`/cis/${item.sys_id}`);
    if (item.kind === 'group')    window.navigate(`/groups/${item.sys_id}`);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, flat.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); if (flat[activeIdx]) go(flat[activeIdx]); }
  };

  if (!open) return null;
  let runningIdx = -1;
  return (
    <div className="kpalette-overlay" onClick={onClose}>
      <div className="kpalette" onClick={e => e.stopPropagation()}>
        <div className="input-row">
          <window.Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search incidents, changes, users, CIs, journal entries…"
            spellCheck={false}
          />
          <span className="kbd-inline">esc</span>
        </div>
        <div className="results-list">
          {results.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-4)', fontSize: 13 }}>
              No matches in this snapshot.
            </div>
          )}
          {results.map((g, gi) => (
            <div key={gi}>
              <div className="group-label">{g.group}</div>
              {g.items.map((it, ii) => {
                runningIdx++;
                const active = runningIdx === activeIdx;
                const myIdx = runningIdx;
                return (
                  <div key={ii} className={'result' + (active ? ' active' : '')}
                       onMouseEnter={() => setActiveIdx(myIdx)}
                       onClick={() => go(it)}>
                    <div className="icon">
                      <window.Icon name={it.icon || (
                        it.kind === 'incident' ? 'incident' :
                        it.kind === 'change' ? 'change' :
                        it.kind === 'task' ? 'check' :
                        it.kind === 'user' ? 'user' :
                        it.kind === 'ci' ? 'ci' :
                        it.kind === 'group' ? 'users' : 'arrow_right'
                      )} size={13} />
                    </div>
                    <div className="label">
                      {it.kind !== 'go' && it.kind !== 'user' && it.kind !== 'ci' && it.kind !== 'group' && (
                        <span className="num mono">{it.label.split(' · ')[0]}</span>
                      )}
                      {(it.kind === 'go' || it.kind === 'user' || it.kind === 'ci' || it.kind === 'group') ? it.label : it.sub}
                    </div>
                    {(it.kind !== 'go') && <span className="meta">{
                      it.kind === 'incident' ? 'incident' :
                      it.kind === 'change' ? 'change_request' :
                      it.kind === 'task' ? (it.meta || it.table) :
                      it.kind === 'user' ? 'sys_user' :
                      it.kind === 'ci' ? 'cmdb_ci' :
                      it.kind === 'group' ? 'sys_user_group' : ''
                    }</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="footer">
          <span className="hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="hint"><kbd>↵</kbd> open</span>
          <span className="hint"><kbd>esc</kbd> close</span>
          <span style={{ marginLeft: 'auto', color: 'var(--fg-4)' }}>Reads from snapshot · {window.HistoricalWowData.manifest.label}</span>
        </div>
      </div>
    </div>
  );
};
