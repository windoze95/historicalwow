#!/usr/bin/env python3
"""Offline unit tests for task metrics and generic list drill-down filters.

Run from the repository root:

    python3 project/bin/test_server.py
"""
import io
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

os.environ.setdefault('HISTORICALWOW_ACCESS_LOG', '')

import build_sqlite as build  # noqa: E402
import server                 # noqa: E402


def _envelope(**fields):
    return json.dumps({
        key: {'value': value, 'display_value': display}
        for key, (value, display) in fields.items()
    })


def _choice_raw(*, inactive=False, parent='', sequence=1):
    return json.dumps({
        'inactive': {'value': 'true' if inactive else 'false'},
        'dependent_value': {'value': parent},
        'sequence': {'value': str(sequence)},
    })


def _fixture():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE incident (
            sys_id TEXT PRIMARY KEY,
            number TEXT,
            short_description TEXT,
            active TEXT,
            state TEXT,
            priority TEXT,
            impact TEXT,
            urgency TEXT,
            category TEXT,
            subcategory TEXT,
            contact_type TEXT,
            assignment_group TEXT,
            assigned_to TEXT,
            cmdb_ci TEXT,
            opened_at TEXT,
            raw TEXT
        );
        CREATE INDEX idx_incident_category ON incident(category);
        CREATE INDEX idx_incident_subcategory ON incident(subcategory);
        CREATE INDEX idx_incident_category_subcategory
            ON incident(category, subcategory);
        CREATE TABLE incident_task (
            sys_id TEXT PRIMARY KEY,
            incident TEXT,
            number TEXT,
            short_description TEXT,
            state TEXT,
            raw TEXT
        );
        CREATE TABLE problem_task (
            sys_id TEXT PRIMARY KEY,
            problem TEXT,
            number TEXT,
            short_description TEXT,
            state TEXT,
            raw TEXT
        );
        CREATE TABLE change_task (
            sys_id TEXT PRIMARY KEY,
            parent TEXT,
            number TEXT,
            short_description TEXT,
            state TEXT,
            raw TEXT
        );
        CREATE TABLE sc_req_item (
            sys_id TEXT PRIMARY KEY,
            request TEXT,
            configuration_item TEXT,
            number TEXT,
            short_description TEXT,
            state TEXT,
            raw TEXT
        );
        CREATE TABLE sc_task (
            sys_id TEXT PRIMARY KEY,
            request_item TEXT,
            request TEXT,
            number TEXT,
            short_description TEXT,
            state TEXT,
            raw TEXT
        );
        CREATE TABLE sys_journal_field (
            sys_id TEXT PRIMARY KEY,
            element_id TEXT,
            element TEXT,
            value TEXT,
            sys_created_by TEXT,
            sys_created_on TEXT,
            raw TEXT
        );
        CREATE INDEX idx_sys_journal_field_element_id
            ON sys_journal_field(element_id);
        CREATE TABLE sys_audit (
            sys_id TEXT PRIMARY KEY,
            documentkey TEXT,
            fieldname TEXT,
            fieldlabel TEXT,
            oldvalue TEXT,
            newvalue TEXT,
            user TEXT,
            sys_created_on TEXT,
            raw TEXT
        );
        CREATE INDEX idx_sys_audit_documentkey ON sys_audit(documentkey);
        CREATE TABLE sys_attachment (
            sys_id TEXT PRIMARY KEY,
            table_sys_id TEXT,
            file_name TEXT,
            content_type TEXT,
            size_bytes TEXT,
            sys_created_by TEXT,
            sys_created_on TEXT,
            raw TEXT
        );
        CREATE INDEX idx_sys_attachment_table_sys_id
            ON sys_attachment(table_sys_id);
        CREATE TABLE sys_email (
            sys_id TEXT PRIMARY KEY,
            instance TEXT,
            target_table TEXT,
            type TEXT,
            state TEXT,
            subject TEXT,
            recipients TEXT,
            sys_created_on TEXT,
            raw TEXT
        );
        CREATE INDEX idx_sys_email_instance ON sys_email(instance);
        CREATE TABLE task_ci (
            sys_id TEXT PRIMARY KEY,
            task TEXT,
            ci TEXT,
            raw TEXT
        );
        CREATE TABLE task_sla (
            sys_id TEXT PRIMARY KEY,
            task TEXT,
            sla_definition TEXT,
            stage TEXT,
            business_percentage TEXT,
            raw TEXT
        );
        CREATE TABLE sysapproval_approver (
            sys_id TEXT PRIMARY KEY,
            sysapproval TEXT,
            "group" TEXT,
            approver TEXT,
            state TEXT,
            sys_created_on TEXT,
            raw TEXT
        );
        CREATE TABLE sysapproval_group (
            sys_id TEXT PRIMARY KEY,
            parent TEXT,
            assignment_group TEXT,
            state TEXT,
            approval TEXT,
            approval_user TEXT,
            raw TEXT
        );
        CREATE TABLE sc_item_option_mtom (
            sys_id TEXT PRIMARY KEY,
            request_item TEXT,
            sc_item_option TEXT,
            raw TEXT
        );
        CREATE TABLE sc_item_option (
            sys_id TEXT PRIMARY KEY,
            value TEXT,
            item_option_new TEXT,
            cat_item TEXT,
            raw TEXT
        );
        CREATE TABLE item_option_new (
            sys_id TEXT PRIMARY KEY,
            name TEXT,
            question_text TEXT,
            type TEXT,
            "order" TEXT,
            reference TEXT,
            raw TEXT
        );
        CREATE TABLE sc_cat_item (
            sys_id TEXT PRIMARY KEY,
            name TEXT,
            raw TEXT
        );
        CREATE TABLE sys_choice (
            sys_id TEXT PRIMARY KEY,
            name TEXT,
            element TEXT,
            value TEXT,
            label TEXT,
            raw TEXT
        );
    ''')
    rows = [
        ('a', 'INC-A', 'Laptop issue', '1', '1', '2', '2', '2',
         'hardware', 'laptop', 'email', 'group-a', 'user-a', 'ci-a',
         '2025-01-01 10:00:00',
         _envelope(
             active=('true', 'true'), state=('1', 'New'), priority=('2', 'High'),
             impact=('2', 'Medium'), urgency=('2', 'Medium'),
             category=('hardware', 'Hardware'), subcategory=('laptop', 'Laptop'),
             contact_type=('email', 'Email'), assignment_group=('group-a', 'Support'),
             assigned_to=('user-a', 'Analyst'), cmdb_ci=('ci-a', 'Device'),
         )),
        ('b', 'INC-B', 'Unclassified issue', '0', '7', '4', '3', '3',
         '', '', 'phone', '', '', '', '2025-01-02 10:00:00',
         _envelope(
             active=('false', 'false'), state=('7', 'Closed'), priority=('4', 'Low'),
             impact=('3', 'Low'), urgency=('3', 'Low'), category=('', ''),
             subcategory=('', ''), contact_type=('phone', 'Phone'),
             assignment_group=('', ''), assigned_to=('', ''), cmdb_ci=('', ''),
         )),
        ('c', 'INC-C', 'Restricted desktop issue', '1', '2', '3', '2', '2',
         'hardware', 'desktop', 'email', 'hr-test-group', 'user-b', 'ci-b',
         '2025-01-03 10:00:00',
         _envelope(
             active=('true', 'true'), state=('2', 'In progress'), priority=('3', 'Moderate'),
             impact=('2', 'Medium'), urgency=('2', 'Medium'),
             category=('hardware', 'Hardware'), subcategory=('desktop', 'Desktop'),
             contact_type=('email', 'Email'), assignment_group=('hr-test-group', 'Restricted'),
             assigned_to=('user-b', 'Other'), cmdb_ci=('ci-b', 'Other device'),
         )),
        ('d', 'INC-D', 'Historic classification', '0', '7', '4', '3', '3',
         'legacy', '', 'phone', 'group-a', '', '', '2025-01-04 10:00:00',
         _envelope(
             active=('false', 'false'), state=('7', 'Closed'), priority=('4', 'Low'),
             impact=('3', 'Low'), urgency=('3', 'Low'), category=('legacy', 'Legacy'),
             subcategory=('', ''), contact_type=('phone', 'Phone'),
             assignment_group=('group-a', 'Support'), assigned_to=('', ''), cmdb_ci=('', ''),
         )),
    ]
    conn.executemany(
        'INSERT INTO incident VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows
    )
    conn.executemany(
        'INSERT INTO incident_task VALUES (?,?,?,?,?,?)', [
            ('task-a', 'a', 'ITASK-A', 'Investigate', '1', _envelope(
                incident=('a', 'INC-A'), state=('1', 'Open'))),
            ('task-c', 'c', 'ITASK-C', 'Restricted', '1', _envelope(
                incident=('c', 'INC-C'), state=('1', 'Open'))),
        ]
    )
    conn.executemany(
        'INSERT INTO problem_task VALUES (?,?,?,?,?,?)', [
            ('problem-task-a', 'problem-a', 'PTASK-A', 'Analyze', '2', _envelope(
                problem=('problem-a', 'PRB-A'), state=('2', 'Work in Progress'))),
        ]
    )
    conn.execute(
        'INSERT INTO change_task VALUES (?,?,?,?,?,?)',
        ('change-task-a', 'a', 'CTASK-A', 'Implement', '1', _envelope(
            parent=('a', 'CHG-A'), state=('1', 'Open'))),
    )
    conn.execute(
        'INSERT INTO sc_req_item VALUES (?,?,?,?,?,?,?)',
        ('ritm-related-a', 'request-a', 'ci-a', 'RITM-A', 'Fulfill', '1',
         _envelope(request=('request-a', 'REQ-A'),
                   configuration_item=('ci-a', 'CI A'), state=('1', 'Open'))),
    )
    conn.execute(
        'INSERT INTO sc_task VALUES (?,?,?,?,?,?,?)',
        ('sc-task-a', 'ritm-related-a', 'request-a', 'SCTASK-A', 'Deliver', '1',
         _envelope(request_item=('ritm-related-a', 'RITM-A'),
                   request=('request-a', 'REQ-A'), state=('1', 'Open'))),
    )
    conn.executemany('INSERT INTO sys_journal_field VALUES (?,?,?,?,?,?,?)', [
        ('journal-a', 'a', 'comments', 'Update', 'analyst',
         '2025-01-01 11:00:00', '{}'),
        ('journal-c', 'c', 'work_notes', 'Restricted', 'analyst',
         '2025-01-03 11:00:00', '{}'),
        ('journal-task-c', 'task-c', 'work_notes', 'Restricted child', 'analyst',
         '2025-01-03 11:01:00', '{}'),
        ('journal-group-c', 'group-approval-c', 'comments', 'Restricted approval', 'analyst',
         '2025-01-03 11:02:00', '{}'),
    ])
    conn.executemany('INSERT INTO sys_audit VALUES (?,?,?,?,?,?,?,?,?)', [
        ('audit-a2', 'a', 'state', 'State', '1', '2', 'analyst',
         '2025-01-01 12:00:00', '{}'),
        ('audit-a1', 'a', 'priority', 'Priority', '3', '2', 'analyst',
         '2025-01-01 11:00:00', '{}'),
        ('audit-c', 'c', 'state', 'State', '1', '2', 'analyst',
         '2025-01-03 12:00:00', '{}'),
        ('audit-task-c', 'task-c', 'state', 'State', '1', '2', 'analyst',
         '2025-01-03 12:01:00', '{}'),
        ('audit-group-c', 'group-approval-c', 'approval', 'Approval',
         'requested', 'approved', 'analyst', '2025-01-03 12:02:00', '{}'),
    ])
    conn.executemany('INSERT INTO sys_attachment VALUES (?,?,?,?,?,?,?,?)', [
        ('attach-a', 'a', 'evidence.txt', 'text/plain', '12', 'analyst',
         '2025-01-01 13:00:00', '{}'),
        ('attach-c', 'c', 'restricted.txt', 'text/plain', '12', 'analyst',
         '2025-01-03 13:00:00', '{}'),
        ('attach-task-c', 'task-c', 'restricted-child.txt', 'text/plain', '12', 'analyst',
         '2025-01-03 13:01:00', '{}'),
        ('attach-group-c', 'group-approval-c', 'restricted-approval.txt',
         'text/plain', '12', 'analyst', '2025-01-03 13:02:00', '{}'),
    ])
    conn.executemany('INSERT INTO sys_email VALUES (?,?,?,?,?,?,?,?,?)', [
        ('email-a1', 'a', 'incident', 'sent', 'sent', 'First', 'user@example.test',
         '2025-01-01 14:00:00', '{}'),
        ('email-a2', 'a', 'incident', 'received', 'received', 'Second', 'desk@example.test',
         '2025-01-01 15:00:00', '{}'),
        ('email-c', 'c', 'incident', 'sent', 'sent', 'Restricted', 'user@example.test',
         '2025-01-03 14:00:00', '{}'),
        ('email-task-c', 'task-c', 'incident_task', 'sent', 'sent',
         'Restricted child', 'user@example.test', '2025-01-03 14:01:00', '{}'),
        ('email-group-c', 'group-approval-c', 'sysapproval_group', 'sent', 'sent',
         'Restricted approval', 'user@example.test', '2025-01-03 14:02:00', '{}'),
    ])
    conn.executemany('INSERT INTO task_ci VALUES (?,?,?,?)', [
        ('task-ci-a', 'a', 'ci-a', _envelope(
            task=('a', 'INC-A'), ci_item=('ci-a', 'CI A'))),
        ('task-ci-c', 'c', 'ci-b', _envelope(
            task=('c', 'INC-C'), ci_item=('ci-b', 'CI B'))),
    ])
    conn.executemany('INSERT INTO task_sla VALUES (?,?,?,?,?,?)', [
        ('sla-a', 'a', 'Resolution', 'in_progress', '50', _envelope(
            task=('a', 'INC-A'), sla=('sla-def-a', 'Resolution'))),
        ('sla-c', 'c', 'Resolution', 'in_progress', '50', _envelope(
            task=('c', 'INC-C'), sla=('sla-def-a', 'Resolution'))),
    ])
    conn.executemany('INSERT INTO sysapproval_approver VALUES (?,?,?,?,?,?,?)', [
        ('approval-a1', 'a', 'group-approval-a', 'user-a', 'approved',
         '2025-01-01 16:00:00', '{}'),
        ('approval-a2', 'a', 'group-b', 'user-b', 'requested',
         '2025-01-01 16:01:00', '{}'),
        ('approval-c', 'c', 'hr-test-group', 'user-b', 'requested',
         '2025-01-03 16:00:00', '{}'),
        ('approval-unlinked', None, '', 'user-a', 'requested',
         '2025-01-04 16:00:00', '{}'),
    ])
    conn.executemany('INSERT INTO sysapproval_group VALUES (?,?,?,?,?,?,?)', [
        ('group-approval-a', 'a', 'group-a', '3', 'requested', 'user-a',
         _envelope(state=('3', 'Closed Complete'), approval=('requested', 'Requested'),
                   approval_user=('user-a', 'Analyst'))),
        ('group-approval-c', 'c', 'hr-test-group', '3', 'requested', 'user-b',
         _envelope(state=('3', 'Closed Complete'), approval=('requested', 'Requested'),
                   approval_user=('user-b', 'Other'))),
        ('group-approval-unlinked', None, 'group-a', '7', 'approved', 'user-a',
         _envelope(state=('7', 'Closed'), approval=('approved', 'Approved'),
                   approval_user=('user-a', 'Analyst'))),
    ])
    conn.execute(
        'INSERT INTO sc_cat_item VALUES (?,?,?)',
        ('cat-a', 'Request access', '{}'),
    )
    conn.execute(
        'INSERT INTO item_option_new VALUES (?,?,?,?,?,?,?)',
        ('def-a', 'requested_for', 'Requested for', '8', '100', 'sys_user', '{}'),
    )
    conn.execute(
        'INSERT INTO sc_item_option VALUES (?,?,?,?,?)',
        ('option-a', 'user-a', 'def-a', 'cat-a', '{}'),
    )
    conn.execute(
        'INSERT INTO sc_item_option_mtom VALUES (?,?,?,?)',
        ('mtom-a', 'ritm-a', 'option-a', '{}'),
    )
    choices = [
        ('cat-h', 'incident', 'category', 'hardware', 'Hardware',
         _choice_raw(sequence=1)),
        ('cat-s', 'incident', 'category', 'software', 'Software',
         _choice_raw(sequence=2)),
        ('cat-l', 'incident', 'category', 'legacy', 'Legacy',
         _choice_raw(inactive=True, sequence=3)),
        ('sub-l', 'incident', 'subcategory', 'laptop', 'Laptop',
         _choice_raw(parent='hardware', sequence=1)),
        ('sub-d', 'incident', 'subcategory', 'desktop', 'Desktop',
         _choice_raw(parent='hardware', sequence=2)),
        ('sub-a', 'incident', 'subcategory', 'application', 'Application',
         _choice_raw(parent='software', sequence=1)),
    ]
    conn.executemany('INSERT INTO sys_choice VALUES (?,?,?,?,?,?)', choices)
    conn.commit()
    return conn


class _Handler:
    def __init__(self):
        self.headers = {}
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass


def _payload(handler):
    return json.loads(handler.wfile.getvalue())


def test_task_metrics_used_unused_and_hr_visibility():
    conn = _fixture()
    old_group = server.HR_GROUP_SYS_ID
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    try:
        locked = server._build_task_metrics_payload(conn, 'incident', False)
        unlocked = server._build_task_metrics_payload(conn, 'incident', True)
    finally:
        server.HR_GROUP_SYS_ID = old_group
    assert locked['total'] == 3, locked
    assert unlocked['total'] == 4, unlocked
    hardware = next(x for x in locked['dimensions']['category'] if x['value'] == 'hardware')
    assert hardware['label'] == 'Hardware' and hardware['count'] == 1, hardware
    assert locked['coverage']['category'] == {'set': 2, 'empty': 1}
    assert [x['value'] for x in locked['unused']['category']] == ['software']
    unused_pairs = {(x['category'], x['value']) for x in locked['unused']['subcategory']}
    assert unused_pairs == {('hardware', 'desktop'), ('software', 'application')}, unused_pairs
    assert any(x['category'] == 'hardware' and x['value'] == 'laptop'
               for x in locked['subcategory_pairs'])
    # An inactive historical code remains visible in observed usage but is not
    # misreported as an active configured choice with zero usage.
    assert any(x['value'] == 'legacy' for x in locked['dimensions']['category'])
    assert not any(x['value'] == 'legacy' for x in locked['unused']['category'])


def test_empty_filter_drills_to_null_or_empty_rows():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'incident', {
            'category': [server.EMPTY_FILTER_VALUE],
            'limit': ['50'], 'slim': ['1'],
        })
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    body = _payload(handler)
    assert handler.status == 200
    assert body['total'] == 1, body
    assert [row['sys_id'] for row in body['rows']] == ['b']
    assert body['rows'][0]['active'] == '0'


def test_combined_search_and_category_filter_matches_list_total():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'incident', {
            'q': ['Laptop'], 'category': ['hardware'], 'limit': ['50'],
        })
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    body = _payload(handler)
    assert body['total'] == 1, body
    assert body['rows'][0]['sys_id'] == 'a'
    assert body['rows'][0]['active'] == {
        'value': 'true', 'display_value': 'true',
    }


def test_record_detail_related_data_paths_and_shapes():
    """Exercise every API/data path consumed by the generic record page."""
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    old_group = server.HR_GROUP_SYS_ID
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    try:
        handler = _Handler()
        server.get_record(handler, 'incident', 'a')
        assert handler.status == 200
        assert _payload(handler)['sys_id'] == 'a'

        handler = _Handler()
        server.get_journal_for(handler, 'a')
        journal = _payload(handler)['rows']
        assert [row['element'] for row in journal] == ['comments']

        handler = _Handler()
        server.get_audit_for(handler, 'a')
        audit = _payload(handler)['rows']
        assert [row['sys_created_on'] for row in audit] == [
            '2025-01-01 11:00:00', '2025-01-01 12:00:00',
        ]
        required_audit = {
            'sys_id', 'fieldname', 'fieldlabel', 'oldvalue', 'newvalue',
            'user', 'sys_created_on',
        }
        assert all(required_audit.issubset(row) for row in audit)

        handler = _Handler()
        server.get_attachments_for(handler, 'a')
        attachment = _payload(handler)['rows'][0]
        assert {
            'sys_id', 'file_name', 'content_type', 'size_bytes',
            'sys_created_by', 'sys_created_on',
        }.issubset(attachment)

        handler = _Handler()
        server.list_table(handler, 'sys_email', {
            'instance': ['a'], 'order_by': ['sys_created_on'],
            'dir': ['desc'], 'limit': ['200'], 'slim': ['1'],
        })
        email = _payload(handler)
        assert email['total'] == 2
        assert [row['subject'] for row in email['rows']] == ['Second', 'First']
        assert all({'type', 'state', 'subject', 'recipients', 'sys_created_on'}
                   .issubset(row) for row in email['rows'])

        related_queries = [
            ('incident_task', {'incident': ['a']}),
            ('problem_task', {'problem': ['problem-a']}),
            ('change_task', {'parent': ['a']}),
            ('sc_req_item', {'request': ['request-a']}),
            ('sc_task', {'request_item': ['ritm-related-a']}),
            ('task_ci', {'task': ['a']}),
            ('task_sla', {'task': ['a']}),
            ('sysapproval_group', {'parent': ['a']}),
        ]
        for table, params in related_queries:
            handler = _Handler()
            query = {**params, 'limit': ['50']}
            if table == 'sysapproval_group':
                query['slim'] = ['1']
            server.list_table(handler, table, query)
            body = _payload(handler)
            assert body['total'] == 1, (table, body)
            if table == 'incident_task':
                assert body['rows'][0]['state']['value'] == '1'
            if table == 'sysapproval_group':
                assert body['rows'][0]['approval'] == 'requested'
                assert body['rows'][0]['approval_user'] == 'user-a'

        handler = _Handler()
        server.list_table(handler, 'task_ci', {
            'task': ['a'], 'limit': ['50'],
        })
        task_ci_row = _payload(handler)['rows'][0]
        assert task_ci_row['ci'] == 'ci-a'
        assert task_ci_row['ci_item']['display_value'] == 'CI A'

        # A group approval page filters approvers by both parent and group.
        # `group` must be a real indexed column or list_table silently ignores
        # it and returns approvers spawned for other groups on the same task.
        handler = _Handler()
        server.list_table(handler, 'sysapproval_approver', {
            'sysapproval': ['a'], 'group': ['group-approval-a'], 'limit': ['50'],
        })
        approvers = _payload(handler)
        assert approvers['total'] == 1
        assert approvers['rows'][0]['group'] == 'group-approval-a'
        assert 'group' in {name for name, _ in build.SCHEMAS['sysapproval_approver']}

        handler = _Handler()
        server.get_record(handler, 'sysapproval_group', 'group-approval-a')
        approval_group = _payload(handler)
        assert approval_group['state']['value'] == '3'
        assert approval_group['approval']['value'] == 'requested'
        assert approval_group['approval_user']['value'] == 'user-a'

        handler = _Handler()
        server.get_variables_for(handler, 'ritm-a')
        variables = _payload(handler)
        assert variables['cat_item'] == 'Request access'
        assert variables['rows'] == [{
            'opt_sys_id': 'option-a', 'value': 'user-a',
            'def_sys_id': 'def-a', 'var_name': 'requested_for',
            'label': 'Requested for', 'type': '8', 'order_idx': '100',
            'reference': 'sys_user', 'cat_item_name': 'Request access',
        }]

        # Same-CI lookups used by Related are ordinary indexed list filters.
        handler = _Handler()
        server.list_table(handler, 'incident', {
            'cmdb_ci': ['ci-a'], 'limit': ['9'], 'slim': ['1'],
        })
        assert _payload(handler)['total'] == 1
        handler = _Handler()
        server.list_table(handler, 'sc_req_item', {
            'configuration_item': ['ci-a'], 'limit': ['9'], 'slim': ['1'],
        })
        assert _payload(handler)['total'] == 1

        # Every incident-parent relation must honor the HR gate even when a
        # caller bypasses RecordPage and queries the child table directly.
        server.HR_UNLOCK_PASSWORD = 'configured-for-test'
        server.HR_GROUP_SYS_ID = 'hr-test-group'
        parent_cases = {
            'sys_journal_field': ('element_id', 'journal-c'),
            'sys_audit': ('documentkey', 'audit-c'),
            'sys_attachment': ('table_sys_id', 'attach-c'),
            'sys_email': ('instance', 'email-c'),
            'task_ci': ('task', 'task-ci-c'),
            'task_sla': ('task', 'sla-c'),
            'incident_task': ('incident', 'task-c'),
            'sysapproval_approver': ('sysapproval', 'approval-c'),
            'sysapproval_group': ('parent', 'group-approval-c'),
        }
        for table, (parent_col, restricted_id) in parent_cases.items():
            handler = _Handler()
            server.list_table(handler, table, {'limit': ['50']})
            body = _payload(handler)
            assert all(row.get(parent_col) != 'c' for row in body['rows'])
            assert 'Cookie' in handler.response_headers['Vary']
            handler = _Handler()
            server.get_record(handler, table, restricted_id)
            assert handler.status == 403, table

        descendant_sidecars = {
            'sys_journal_field': {'journal-task-c', 'journal-group-c'},
            'sys_audit': {'audit-task-c', 'audit-group-c'},
            'sys_attachment': {'attach-task-c', 'attach-group-c'},
            'sys_email': {'email-task-c', 'email-group-c'},
        }
        for table, restricted_ids in descendant_sidecars.items():
            handler = _Handler()
            server.list_table(handler, table, {'limit': ['100']})
            visible_ids = {row['sys_id'] for row in _payload(handler)['rows']}
            assert visible_ids.isdisjoint(restricted_ids), table
            for restricted_id in restricted_ids:
                handler = _Handler()
                server.get_record(handler, table, restricted_id)
                assert handler.status == 403, (table, restricted_id)

        assert server.is_hr_related_record('task-c')
        assert server.is_hr_related_record('group-approval-c')
        assert server.is_hr_related_record('approval-c')
        assert server._attachment_is_hr('attach-task-c')
        assert server._attachment_is_hr('attach-group-c')
        for table in ('sysapproval_approver', 'sysapproval_group'):
            handler = _Handler()
            server.list_table(handler, table, {'limit': ['50']})
            assert any(row['sys_id'].endswith('unlinked')
                       for row in _payload(handler)['rows'])

        for target in ('c', 'task-c', 'group-approval-c'):
            for getter in (
                server.get_journal_for, server.get_audit_for,
                server.get_attachments_for,
            ):
                handler = _Handler()
                getter(handler, target)
                assert handler.status == 403, (getter.__name__, target)

        token = 'record-related-unlock'
        with server._hr_tokens_lock:
            server._hr_tokens.add(token)
        try:
            handler = _Handler()
            handler.headers['Cookie'] = f'hr_unlock={token}'
            server.get_audit_for(handler, 'c')
            assert handler.status == 200
            assert len(_payload(handler)['rows']) == 1

            handler = _Handler()
            handler.headers['Cookie'] = f'hr_unlock={token}'
            server.list_table(handler, 'sys_email', {
                'instance': ['c'], 'limit': ['50'],
            })
            assert _payload(handler)['total'] == 1
        finally:
            with server._hr_tokens_lock:
                server._hr_tokens.discard(token)
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        server.HR_GROUP_SYS_ID = old_group
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn


def test_hr_parent_lists_are_never_publicly_cached():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    old_group = server.HR_GROUP_SYS_ID
    token = 'test-unlocked-token'
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = 'configured-for-test'
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    with server._hr_tokens_lock:
        server._hr_tokens.add(token)
    try:
        handlers = [_Handler(), _Handler()]
        handlers[1].headers['Cookie'] = f'hr_unlock={token}'
        for handler in handlers:
            server.list_table(handler, 'incident_task', {'limit': ['201']})
            assert handler.response_headers['Cache-Control'] == 'no-cache, must-revalidate'
            vary = {x.strip() for x in handler.response_headers['Vary'].split(',')}
            assert vary == {'Accept-Encoding', 'Cookie'}
    finally:
        with server._hr_tokens_lock:
            server._hr_tokens.discard(token)
        server.HR_UNLOCK_PASSWORD = old_password
        server.HR_GROUP_SYS_ID = old_group
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn


def test_restricted_attachment_files_are_transitive_and_never_cached():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    old_group = server.HR_GROUP_SYS_ID
    old_data_dir = server.DATA_DIR
    token = 'attachment-unlock-token'
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = 'configured-for-test'
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    try:
        with tempfile.TemporaryDirectory() as td:
            server.DATA_DIR = Path(td).resolve()
            attachment = (
                server.DATA_DIR / 'attachments' / 'at' /
                'attach-task-c' / 'restricted-child.txt'
            )
            attachment.parent.mkdir(parents=True)
            attachment.write_bytes(b'restricted test body')
            path = '/data/attachments/at/attach-task-c/restricted-child.txt'
            unknown = (
                server.DATA_DIR / 'attachments' / 'un' /
                'unknown-attachment' / 'metadata-pending.txt'
            )
            unknown.parent.mkdir(parents=True)
            unknown.write_bytes(b'body awaiting metadata')
            unknown_path = (
                '/data/attachments/un/unknown-attachment/metadata-pending.txt'
            )

            locked = _Handler()
            locked.path = path
            server.Handler._route(locked)
            assert locked.status == 403
            assert locked.response_headers['Cache-Control'] == 'private, no-store'
            assert locked.response_headers['Vary'] == 'Cookie'

            pending = _Handler()
            pending.path = unknown_path
            server.Handler._route(pending)
            assert pending.status == 403
            assert pending.response_headers['Cache-Control'] == 'private, no-store'
            assert pending.response_headers['Vary'] == 'Cookie'

            with server._hr_tokens_lock:
                server._hr_tokens.add(token)
            try:
                unlocked = _Handler()
                unlocked.path = path
                unlocked.headers['Cookie'] = f'hr_unlock={token}'
                server.Handler._route(unlocked)
                assert unlocked.status == 200
                assert unlocked.wfile.getvalue() == b'restricted test body'
                assert unlocked.response_headers['Cache-Control'] == 'private, no-store'
                assert unlocked.response_headers['Vary'] == 'Cookie'

                pending_unlocked = _Handler()
                pending_unlocked.path = unknown_path
                pending_unlocked.headers['Cookie'] = f'hr_unlock={token}'
                server.Handler._route(pending_unlocked)
                assert pending_unlocked.status == 200
                assert pending_unlocked.wfile.getvalue() == b'body awaiting metadata'
            finally:
                with server._hr_tokens_lock:
                    server._hr_tokens.discard(token)
    finally:
        server.DATA_DIR = old_data_dir
        server.HR_UNLOCK_PASSWORD = old_password
        server.HR_GROUP_SYS_ID = old_group
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn


def test_incomplete_hr_ancestry_schema_fails_closed_until_rebuild():
    conn = _fixture()
    conn.execute('ALTER TABLE incident_task RENAME COLUMN incident TO parent')
    conn.commit()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    old_group = server.HR_GROUP_SYS_ID
    token = 'schema-pending-unlock'
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = 'configured-for-test'
    server.HR_GROUP_SYS_ID = 'hr-test-group'
    try:
        assert not server.hr_ancestry_schema_ready(conn)
        assert server.is_hr_related_record('task-c')
        assert server._attachment_is_hr('attach-a')

        handler = _Handler()
        server.get_journal_for(handler, 'task-c')
        assert handler.status == 403
        assert handler.response_headers['Cache-Control'] == 'private, no-store'

        handler = _Handler()
        server.list_table(handler, 'sys_journal_field', {'limit': ['50']})
        assert handler.status == 503
        assert _payload(handler)['error'] == 'hr_schema_pending'
        assert handler.response_headers['Cache-Control'] == 'private, no-store'

        handler = _Handler()
        server.get_record(handler, 'sys_journal_field', 'journal-a')
        assert handler.status == 503
        assert _payload(handler)['error'] == 'hr_schema_pending'

        with server._hr_tokens_lock:
            server._hr_tokens.add(token)
        try:
            handler = _Handler()
            handler.headers['Cookie'] = f'hr_unlock={token}'
            server.list_table(handler, 'sys_journal_field', {'limit': ['50']})
            assert handler.status == 200
        finally:
            with server._hr_tokens_lock:
                server._hr_tokens.discard(token)
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        server.HR_GROUP_SYS_ID = old_group
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn


def test_public_list_cache_varies_on_content_encoding():
    conn = _fixture()
    old_conn = getattr(server._local, 'conn', None)
    old_password = server.HR_UNLOCK_PASSWORD
    server._local.conn = conn
    server.HR_UNLOCK_PASSWORD = ''
    handler = _Handler()
    try:
        server.list_table(handler, 'sys_choice', {'limit': ['201']})
    finally:
        server.HR_UNLOCK_PASSWORD = old_password
        if old_conn is None:
            delattr(server._local, 'conn')
        else:
            server._local.conn = old_conn
    assert handler.response_headers['Cache-Control'] == 'public, max-age=300'
    assert handler.response_headers['Vary'] == 'Accept-Encoding'


def test_subcategory_pair_query_has_covering_index():
    conn = _fixture()
    plan = conn.execute(
        'EXPLAIN QUERY PLAN SELECT category, subcategory, COUNT(*) '
        'FROM incident GROUP BY category, subcategory'
    ).fetchall()
    detail = ' '.join(str(row['detail']) for row in plan)
    assert 'idx_incident_category_subcategory' in detail, detail
    assert build.COMPOSITE_INDEXES['incident'] == [('category', 'subcategory')]


def test_build_table_extracts_analytics_columns_and_indexes():
    with tempfile.TemporaryDirectory() as td:
        ndjson = Path(td) / 'incident.ndjson'
        row = {
            'sys_id': {'value': 'one'},
            'number': {'value': 'INC-ONE'},
            'sys_updated_on': {'value': '2025-01-01 00:00:00'},
            'active': {'value': 'true'},
            'impact': {'value': '2'},
            'urgency': {'value': '3'},
            'contact_type': {'value': 'email'},
            'category': {'value': 'hardware'},
            'subcategory': {'value': 'laptop'},
        }
        ndjson.write_text(json.dumps(row) + '\n')
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        build.build_table(
            conn, 'incident', build.SCHEMAS['incident'], ndjson,
            force_full=True, report_new_tables=False,
        )
        stored = conn.execute(
            'SELECT active, impact, urgency, contact_type, category, subcategory '
            'FROM incident WHERE sys_id = ?', ('one',),
        ).fetchone()
        assert tuple(stored) == ('1', '2', '3', 'email', 'hardware', 'laptop')
        indexes = {r['name'] for r in conn.execute('PRAGMA index_list("incident")')}
        assert 'idx_incident_category_subcategory' in indexes


def test_build_table_extracts_real_related_reference_fields():
    cases = [
        ('incident_task', {
            'incident': {'value': 'incident-a', 'display_value': 'INC-A'},
        }, 'incident', 'incident-a'),
        ('problem_task', {
            'problem': {'value': 'problem-a', 'display_value': 'PRB-A'},
        }, 'problem', 'problem-a'),
        ('task_ci', {
            'task': {'value': 'incident-a', 'display_value': 'INC-A'},
            'ci_item': {'value': 'ci-a', 'display_value': 'CI A'},
        }, 'ci', 'ci-a'),
        ('task_sla', {
            'task': {'value': 'incident-a', 'display_value': 'INC-A'},
            'sla': {'value': 'sla-a', 'display_value': 'Resolution'},
        }, 'sla_definition', 'Resolution'),
        ('sc_req_item', {
            'request': {'value': 'request-a', 'display_value': 'REQ-A'},
            'configuration_item': {
                'value': 'ci-a', 'display_value': 'CI A',
            },
        }, 'configuration_item', 'ci-a'),
        ('change_task', {
            'parent': {'value': 'change-a', 'display_value': 'CHG-A'},
        }, 'parent', 'change-a'),
        ('sc_req_item', {
            'request': {'value': 'request-a', 'display_value': 'REQ-A'},
        }, 'request', 'request-a'),
        ('sc_task', {
            'request_item': {'value': 'ritm-a', 'display_value': 'RITM-A'},
        }, 'request_item', 'ritm-a'),
    ]
    with tempfile.TemporaryDirectory() as td:
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        for table, fields, projected_col, expected in cases:
            ndjson = Path(td) / f'{table}.ndjson'
            row = {
                'sys_id': {'value': f'{table}-a'},
                'sys_updated_on': {'value': '2025-01-01 00:00:00'},
                **fields,
            }
            ndjson.write_text(json.dumps(row) + '\n')
            build.build_table(
                conn, table, build.SCHEMAS[table], ndjson,
                force_full=True, report_new_tables=False,
            )
            stored = conn.execute(
                f'SELECT "{projected_col}" FROM "{table}"'
            ).fetchone()[0]
            assert stored == expected, (table, stored)


def test_projection_version_rebuilds_existing_columns_once():
    with tempfile.TemporaryDirectory() as td:
        ndjson = Path(td) / 'task_ci.ndjson'
        row = {
            'sys_id': {'value': 'link-a'},
            'sys_updated_on': {'value': '2025-01-01 00:00:00'},
            'task': {'value': 'incident-a'},
            'ci_item': {'value': 'ci-a', 'display_value': 'CI A'},
        }
        ndjson.write_text(json.dumps(row) + '\n')
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        build.build_table(
            conn, 'task_ci', build.SCHEMAS['task_ci'], ndjson,
            force_full=True, report_new_tables=False,
        )
        conn.execute('UPDATE task_ci SET ci = NULL')
        conn.execute(
            'UPDATE _build_state SET projection_version = 0 '
            'WHERE table_name = ?', ('task_ci',),
        )
        conn.commit()

        written, drift = build.build_table(
            conn, 'task_ci', build.SCHEMAS['task_ci'], ndjson,
            report_new_tables=False,
        )
        assert drift is True
        assert written == 1
        assert conn.execute('SELECT ci FROM task_ci').fetchone()[0] == 'ci-a'
        assert build._read_projection_version(conn, 'task_ci') == 1


def test_interrupted_schema_drift_rebuild_restarts_from_scratch():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        ndjson = root / 'drift_task.ndjson'
        rows = [
            {
                'sys_id': {'value': 'old'},
                'sys_updated_on': {'value': '2025-01-01 00:00:00'},
                'category': {'value': 'hardware'},
            },
            {
                'sys_id': {'value': 'new'},
                'sys_updated_on': {'value': '2025-02-01 00:00:00'},
                'category': {'value': 'software'},
            },
        ]
        ndjson.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        db_path = root / 'archive.db'
        old_cols = [
            ('sys_updated_on', lambda row: build._v(row.get('sys_updated_on'))),
        ]
        new_cols = old_cols + [
            ('category', lambda row: build._v(row.get('category'))),
        ]

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        build._ensure_build_state_table(conn)
        build.build_table(
            conn, 'drift_task', old_cols, ndjson,
            force_full=True, report_new_tables=False,
        )

        def interrupt(_row):
            raise KeyboardInterrupt('simulated interrupted rebuild')

        interrupted_cols = old_cols + [('category', interrupt)]
        try:
            build.build_table(
                conn, 'drift_task', interrupted_cols, ndjson,
                report_new_tables=False,
            )
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError('expected simulated interruption')
        conn.close()

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        assert build._read_build_state(conn, 'drift_task') is None
        build.build_table(
            conn, 'drift_task', new_cols, ndjson,
            report_new_tables=False,
        )
        restored = conn.execute(
            'SELECT sys_id, category FROM drift_task ORDER BY sys_id'
        ).fetchall()
        assert [tuple(row) for row in restored] == [
            ('new', 'software'), ('old', 'hardware'),
        ]
        assert build._read_build_state(conn, 'drift_task') == '2025-02-01 00:00:00'
        conn.close()


def _run():
    tests = sorted((name, fn) for name, fn in globals().items()
                   if name.startswith('test_') and callable(fn))
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print('[PASS] %s' % name)
        except Exception as exc:  # noqa: BLE001
            import traceback
            print('[FAIL] %s -> %s' % (name, exc))
            traceback.print_exc()
            failed += 1
    print('\n%d passed, %d failed' % (len(tests) - failed, failed))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(_run())
