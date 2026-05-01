/* eslint-disable */
// Cmd-K palette + global search

window.KPalette = function KPalette({ open, onClose }) {
  const [q, setQ] = React.useState('');
  const [activeIdx, setActiveIdx] = React.useState(0);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (open) {
      setQ('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const data = window.HistoricalWowData;

  const results = React.useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) {
      // Default: pinned/recent
      return [
        { group: 'Pinned', items: [
          { kind: 'incident', sys_id: data.incidents[0].sys_id, label: data.incidents[0].number, sub: data.incidents[0].short_description },
          { kind: 'incident', sys_id: data.incidents[3].sys_id, label: data.incidents[3].number, sub: data.incidents[3].short_description },
          { kind: 'change', sys_id: data.changes[1].sys_id, label: data.changes[1].number, sub: data.changes[1].short_description },
        ]},
        { group: 'Browse', items: [
          { kind: 'go', target: '/incidents', label: 'All incidents', sub: data.incidents.length + ' records', icon: 'incident' },
          { kind: 'go', target: '/changes', label: 'All change requests', sub: data.changes.length + ' records', icon: 'change' },
          { kind: 'go', target: '/users', label: 'Users', sub: data.sys_user.length + ' records', icon: 'user' },
          { kind: 'go', target: '/groups', label: 'Groups', sub: data.sys_user_group.length + ' records', icon: 'users' },
          { kind: 'go', target: '/cis', label: 'Configuration items', sub: data.cmdb_ci.length + ' records', icon: 'ci' },
        ]},
      ];
    }

    const incs = data.incidents.filter((i) =>
      (i.number || '').toLowerCase().includes(ql) ||
      (i.short_description || '').toLowerCase().includes(ql)
    ).slice(0, 8).map(i => ({ kind: 'incident', sys_id: i.sys_id, label: i.number, sub: i.short_description }));

    const chgs = data.changes.filter((c) =>
      (c.number || '').toLowerCase().includes(ql) ||
      (c.short_description || '').toLowerCase().includes(ql)
    ).slice(0, 6).map(c => ({ kind: 'change', sys_id: c.sys_id, label: c.number, sub: c.short_description }));

    // Search every other task table (problem, sc_request, sc_req_item, sc_task,
    // sysapproval_group, asset_task, …) and group matches by table.
    const tasksByTable = {};
    if (window.TASK_TABLES) {
      let total = 0;
      for (const t of window.TASK_TABLES) {
        if (t === 'incident' || t === 'change_request') continue;
        const rows = window.getTaskRecords(t);
        if (!rows.length) continue;
        const matches = [];
        for (const r of rows) {
          if ((r.number || '').toLowerCase().includes(ql) ||
              (r.short_description || '').toLowerCase().includes(ql)) {
            matches.push({
              kind: 'task', table: t, sys_id: r.sys_id,
              label: r.number || r.sys_id?.slice(0, 8) + '…',
              sub: r.short_description || '—',
              meta: t,
            });
            total++;
            if (matches.length >= 6 || total >= 24) break;
          }
        }
        if (matches.length) tasksByTable[t] = matches;
        if (total >= 24) break;
      }
    }

    const users = data.sys_user.filter((u) =>
      u.name.toLowerCase().includes(ql) ||
      u.user_name.toLowerCase().includes(ql)
    ).slice(0, 6).map(u => ({ kind: 'user', sys_id: u.sys_id, label: u.name, sub: u.title }));

    const cis = data.cmdb_ci.filter((c) =>
      c.name.toLowerCase().includes(ql) ||
      c.short_description.toLowerCase().includes(ql)
    ).slice(0, 6).map(c => ({ kind: 'ci', sys_id: c.sys_id, label: c.name, sub: c.sys_class_name }));

    // Journal/comments full-text
    const journals = data.journal.filter((j) => j.value.toLowerCase().includes(ql)).slice(0, 4)
      .map(j => {
        const inc = data.incidents.find(i => i.sys_id === j.element_id) ||
                    data.changes.find(c => c.sys_id === j.element_id);
        if (!inc) return null;
        const idx = j.value.toLowerCase().indexOf(ql);
        const snippet = '…' + j.value.slice(Math.max(0, idx - 24), idx + ql.length + 60) + '…';
        return {
          kind: inc.number?.startsWith('INC') ? 'incident' : 'change',
          sys_id: inc.sys_id,
          label: inc.number + ' · ' + j.element,
          sub: snippet,
        };
      }).filter(Boolean);

    const groups = [];
    if (incs.length) groups.push({ group: 'Incidents', items: incs });
    if (chgs.length) groups.push({ group: 'Change requests', items: chgs });
    for (const [t, items] of Object.entries(tasksByTable)) {
      groups.push({ group: window.taskLabel(t, 'plural'), items });
    }
    if (cis.length)  groups.push({ group: 'Configuration items', items: cis });
    if (users.length) groups.push({ group: 'Users', items: users });
    if (journals.length) groups.push({ group: 'In journal / comments', items: journals });
    return groups;
  }, [q]);

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
                      {it.kind !== 'go' && it.kind !== 'user' && it.kind !== 'ci' && (
                        <span className="num mono">{it.label.split(' · ')[0]}</span>
                      )}
                      {(it.kind === 'go' || it.kind === 'user' || it.kind === 'ci') ? it.label : it.sub}
                    </div>
                    {(it.kind !== 'go') && <span className="meta">{
                      it.kind === 'incident' ? 'incident' :
                      it.kind === 'change' ? 'change_request' :
                      it.kind === 'task' ? (it.meta || it.table) :
                      it.kind === 'user' ? 'sys_user' :
                      it.kind === 'ci' ? 'cmdb_ci' : ''
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
