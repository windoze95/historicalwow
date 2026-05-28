"""Pure comparison + classification logic — the unit-tested heart of the
harness. No I/O, no network. Every function is deterministic in its inputs so
test_recon.py can exercise the full decision matrix without a DB or live calls.
"""
from .common import (PASS, INFO, WARN, FAIL, worst, uv, udv, is_empty, norm)

# Fields whose value cannot legitimately change for a given sys_id. A mismatch
# here on a record that was edited after the snapshot still indicates a real
# archive defect (wrong lineage / mis-keyed record), not benign drift.
IMMUTABLE_FIELDS = ('sys_id', 'sys_created_on', 'sys_created_by', 'number')

# Fields that legitimately change WITHOUT bumping sys_updated_on (counters,
# recompile/derived metadata). A same-revision value difference on these is not
# corruption — the archive faithfully captured the row at its sys_updated_on and
# the field drifted afterward — so they're excluded from the value comparison.
DEFAULT_VOLATILE_FIELDS = frozenset({
    'sys_mod_count', 'sys_view_count', 'compiler_build', 'latest_snapshot',
    'sizeclass',
    # sys_user activity tracking — updated on login without a sys_updated_on bump
    'last_login', 'last_login_time', 'last_login_device', 'failed_attempts',
})


def _keys(row):
    return set(row.keys()) if isinstance(row, dict) else set()


def compare_fields(arch, live, keys=None, ignore=()):
    """Compare two ServiceNow rows ({field: envelope-or-scalar}).

    keys: iterable of field names to compare; None compares the union of both.
    ignore: field names to skip entirely (e.g. intentionally-omitted bodies).

    A key present on one side but absent on the other counts as missing only
    when the present side actually carries a value (an absent key and an empty
    value are the same fact). Returns lists of value_mismatches /
    display_mismatches / missing_in_archive / missing_in_live.
    """
    ignore = set(ignore)
    if keys is None:
        keys = _keys(arch) | _keys(live)
    res = {'value_mismatches': [], 'display_mismatches': [],
           'missing_in_archive': [], 'missing_in_live': []}
    for k in keys:
        if k in ignore:
            continue
        in_a = isinstance(arch, dict) and k in arch
        in_l = isinstance(live, dict) and k in live
        if in_l and not in_a:
            if not is_empty(uv(live.get(k))):
                res['missing_in_archive'].append(k)
            continue
        if in_a and not in_l:
            if not is_empty(uv(arch.get(k))):
                res['missing_in_live'].append(k)
            continue
        if not (in_a or in_l):
            continue
        av, lv = uv(arch.get(k)), uv(live.get(k))
        if norm(av) != norm(lv):
            res['value_mismatches'].append((k, av, lv))
            continue
        adv, ldv = udv(arch.get(k)), udv(live.get(k))
        if norm(adv) != norm(ldv):
            res['display_mismatches'].append((k, adv, ldv))
    return res


def classify_record(arch, live, delta_field='sys_updated_on', cutoff=None,
                    compare_keys=None, intentional_omissions=(),
                    volatile_fields=DEFAULT_VOLATILE_FIELDS):
    """Classify one sampled archived row against its live re-fetch.

    arch: dict parsed from the DB `raw` column.
    live: dict from the live re-fetch, or None when the sys_id was not returned.
    delta_field: revision axis — 'sys_updated_on', or 'sys_created_on' for the
      append-only tables (sys_audit / sys_journal_field) which have no
      sys_updated_on and are immutable.
    cutoff: the table's snapshot watermark. When the live revision is newer than
      the archived one but still at/before the cutoff, the archive missed an
      in-snapshot update (and a delta export keyed on >= watermark will not
      repair it) — that is a failing staleness, not benign post-snapshot drift.
    compare_keys: restrict the same-revision full compare to these field names
      (the exporter's sysparm_fields allowlist for sys_email); None = all keys.
    intentional_omissions: field names that are deliberately not archived (e.g.
      sys_email body/body_text/headers) and so must not count as MISSING_FIELD.
    volatile_fields: fields that change without bumping sys_updated_on; excluded
      from the same-revision value comparison so they don't read as corruption.

    Returns (category, verdict, detail). Categories:
      DELETED_SINCE | MATCH | CHANGED_SINCE | STALE_IN_SNAPSHOT |
      MISSING_FIELD | CORRUPTION
    """
    if live is None:
        # Source deleted the record after capture. The archive faithfully
        # retains it; that is the whole point of the archive, not a defect.
        return ('DELETED_SINCE', INFO, {})

    au = norm(uv(arch.get(delta_field)))
    lu = norm(uv(live.get(delta_field)))
    ignore = set(intentional_omissions) | set(volatile_fields)

    if au and lu and au == lu:
        # Same revision: the stored row must equal the live row byte-for-byte
        # on the value side. Any difference is a recording error.
        cmp = compare_fields(arch, live, keys=compare_keys, ignore=ignore)
        if cmp['missing_in_archive']:
            return ('MISSING_FIELD', FAIL, cmp)
        if cmp['value_mismatches']:
            return ('CORRUPTION', FAIL, cmp)
        if cmp['display_mismatches']:
            # value identical, only a referenced record's display label moved
            # (e.g. a user was renamed) — benign.
            return ('MATCH', WARN, cmp)
        return ('MATCH', PASS, cmp)

    if au and lu and lu > au:
        # Live revision is newer than the archived one.
        cmp = compare_fields(arch, live, keys=IMMUTABLE_FIELDS)
        if cmp['value_mismatches']:
            return ('CHANGED_SINCE', FAIL, cmp)        # immutable mismatch
        if cutoff and lu <= cutoff:
            # The update happened at/before the table's snapshot boundary, so the
            # archive should hold this revision but doesn't — and a delta export
            # keyed on >= watermark won't re-fetch it. Stale in-snapshot data.
            full = compare_fields(arch, live, keys=compare_keys, ignore=ignore)
            return ('STALE_IN_SNAPSHOT', FAIL, full)
        # Edited after the snapshot — expected drift; immutables agree.
        return ('CHANGED_SINCE', INFO, cmp)

    if au and lu and lu < au:
        # Archive newer than live: impossible for a frozen snapshot vs a later
        # read — surfaces clock skew, a rollback, or a re-import.
        return ('CHANGED_SINCE', WARN,
                {'reason': 'archive_newer_than_live', 'archived': au, 'live': lu})

    # One side lacks the delta stamp — compare at face value and stay cautious.
    cmp = compare_fields(arch, live, keys=compare_keys, ignore=ignore)
    if cmp['missing_in_archive'] or cmp['value_mismatches']:
        return ('CHANGED_SINCE', WARN, cmp)
    return ('MATCH', PASS, cmp)


def summarize_deep(results):
    """Roll a list of (category, verdict, detail) into a deep-check summary.

    Returns {'categories': {cat: n}, 'verdict': worst, 'failures': [...]} where
    failures captures the FAIL/WARN records (capped) with their mismatch detail.
    """
    cats = {}
    verdict = PASS
    failures = []
    for category, v, detail in results:
        cats[category] = cats.get(category, 0) + 1
        verdict = worst(verdict, v)
        if v in (FAIL, WARN) and len(failures) < 25:
            entry = {'category': category, 'verdict': v}
            entry.update(_trim_detail(detail))
            failures.append(entry)
    return {'categories': cats, 'verdict': verdict, 'failures': failures,
            'compared': len(results)}


def _trim_detail(detail):
    """Keep failure detail small and instance-light for the report."""
    out = {}
    for k in ('value_mismatches', 'missing_in_archive', 'missing_in_live',
              'display_mismatches'):
        v = detail.get(k)
        if v:
            out[k] = v[:10]
    for k in ('reason', 'archived', 'live'):
        if k in detail:
            out[k] = detail[k]
    return out


def rollup_table(checks):
    """Worst verdict across a table's check dict ({name: {'verdict': ...}})."""
    return worst(*[c.get('verdict', PASS)
                   for c in checks.values() if isinstance(c, dict)])


def rollup_overall(table_verdicts):
    """Worst verdict across all tables."""
    return worst(*table_verdicts.values()) if table_verdicts else PASS
