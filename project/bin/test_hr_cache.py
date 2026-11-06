#!/usr/bin/env python3
"""Synthetic task-metrics regressions for WAL commits and archive replacement.

Run from the repository root: python3 project/bin/test_hr_cache.py
"""
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

os.environ.setdefault('HISTORICALWOW_ACCESS_LOG', '')

import server  # noqa: E402


class Handler:
    headers = {}

    def __init__(self):
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, key, value):
        pass

    def end_headers(self):
        pass


def create_archive(path, group='ordinary-group', wal=False):
    conn = sqlite3.connect(path)
    if wal:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA wal_autocheckpoint=0')
    conn.execute('''CREATE TABLE incident (
        sys_id TEXT PRIMARY KEY, assignment_group TEXT, parent TEXT, raw TEXT
    )''')
    conn.execute('INSERT INTO incident VALUES (?, ?, ?, ?)',
                 ('synthetic-record', group, '', '{}'))
    conn.commit()
    return conn


class TaskMetricsCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'historicalwow.db'
        self.old_conn = getattr(server._local, 'conn', None)
        self.old_identity = getattr(server._local, 'conn_identity', None)
        self.old_snapshot = getattr(server._local, 'task_metrics_snapshot', None)
        server._local.conn = None
        server._local.conn_identity = None
        server._local.task_metrics_snapshot = None
        self.patches = [
            mock.patch.object(server, 'DB_PATH', self.path),
            mock.patch.object(server, 'HR_GROUP_SYS_ID', 'synthetic-hr-group'),
            mock.patch.object(server, 'is_hr_unlocked', return_value=False),
            mock.patch.object(server, '_build_manifest_payload', return_value={}),
        ]
        for patch in self.patches:
            patch.start()
        server._task_metrics_cache.clear()
        self.writer = create_archive(self.path, wal=True)

    def tearDown(self):
        conn = getattr(server._local, 'conn', None)
        if conn is not None:
            conn.close()
        self.writer.close()
        server._local.conn = self.old_conn
        server._local.conn_identity = self.old_identity
        server._local.task_metrics_snapshot = self.old_snapshot
        server._task_metrics_cache.clear()
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def metrics(self):
        handler = Handler()
        server.get_task_metrics(handler, 'incident')
        self.assertEqual(handler.status, 200)
        return json.loads(handler.wfile.getvalue())

    def assign_hr(self):
        self.writer.execute('UPDATE incident SET assignment_group=?',
                            ('synthetic-hr-group',))
        self.writer.commit()

    def test_wal_commit_hides_new_hr_assignment_before_checkpoint(self):
        with mock.patch.object(server, '_build_task_metrics_payload',
                               wraps=server._build_task_metrics_payload) as build:
            self.assertEqual(self.metrics()['total'], 1)
            self.assertEqual(self.metrics()['total'], 1)
            self.assertEqual(build.call_count, 1)
            main_mtime = self.path.stat().st_mtime_ns
            self.assign_hr()
            self.assertEqual(self.path.stat().st_mtime_ns, main_mtime)
            self.assertGreater(Path(str(self.path) + '-wal').stat().st_size, 0)
            self.assertEqual(self.metrics()['total'], 0)
            self.assertEqual(self.metrics()['total'], 0)
            self.assertEqual(build.call_count, 2)

    def test_replacement_reconnects_even_with_preserved_main_mtime(self):
        self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.writer.execute('PRAGMA journal_mode=DELETE')
        self.assertEqual(self.metrics()['total'], 1)
        previous_conn = server.get_conn()
        previous_stat = self.path.stat()
        self.writer.close()
        replacement = self.path.with_name('replacement.db')
        create_archive(replacement, group='synthetic-hr-group').close()
        os.utime(replacement, ns=(previous_stat.st_atime_ns, previous_stat.st_mtime_ns))
        os.replace(replacement, self.path)
        self.assertEqual(self.path.stat().st_mtime_ns, previous_stat.st_mtime_ns)
        self.assertNotEqual(self.path.stat().st_ino, previous_stat.st_ino)
        self.assertEqual(self.metrics()['total'], 0)
        self.assertIsNot(server.get_conn(), previous_conn)
        with self.assertRaises(sqlite3.ProgrammingError):
            previous_conn.execute('SELECT 1')

    def test_commit_during_build_is_not_cached(self):
        build = server._build_task_metrics_payload

        def changing_build(*args):
            payload = build(*args)
            self.assign_hr()
            return payload

        # Even if filesystem metadata did not distinguish two observations,
        # the same reader's SQLite data_version must detect the commit.
        with mock.patch.object(server, '_db_cache_generation', return_value=('same',)):
            with mock.patch.object(server, '_build_task_metrics_payload',
                                   side_effect=changing_build):
                self.assertEqual(self.metrics()['total'], 1)
            self.assertEqual(server._task_metrics_cache, {})
            self.assertEqual(self.metrics()['total'], 0)

    def test_replacement_between_connection_and_generation_is_not_cached(self):
        self.writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.writer.execute('PRAGMA journal_mode=DELETE')
        previous_conn = server.get_conn()
        previous_conn.execute('SELECT COUNT(*) FROM incident').fetchone()
        self.writer.close()
        replacement = self.path.with_name('replacement.db')
        create_archive(replacement, group='synthetic-hr-group').close()
        generation = server._db_cache_generation

        def replace_before_generation():
            if replacement.exists():
                os.replace(replacement, self.path)
            return generation()

        with mock.patch.object(server, '_db_cache_generation',
                               side_effect=replace_before_generation):
            self.assertEqual(self.metrics()['total'], 1)
        self.assertEqual(server._task_metrics_cache, {})
        self.assertEqual(self.metrics()['total'], 0)
        self.assertIsNot(server.get_conn(), previous_conn)

    def test_old_wal_snapshot_does_not_publish_under_new_generation(self):
        conn = server.get_conn()
        conn.execute('BEGIN')
        server._local.task_metrics_snapshot = server._task_metrics_snapshot_token(conn)
        self.assign_hr()
        self.assertEqual(self.metrics()['total'], 1)
        self.assertEqual(server._task_metrics_cache, {})
        conn.rollback()
        server._local.task_metrics_snapshot = None
        server._local.hr_restrictions = None
        self.assertEqual(self.metrics()['total'], 0)

    def test_old_wal_snapshot_does_not_read_new_generation_cache(self):
        conn = server.get_conn()
        conn.execute('BEGIN')
        server._local.task_metrics_snapshot = server._task_metrics_snapshot_token(conn)
        self.assign_hr()
        # Another request may already have cached the newly committed state.
        key = (server._db_cache_generation(), 'incident', False)
        server._task_metrics_cache[key] = {'total': 0}
        self.assertEqual(self.metrics()['total'], 1)
        self.assertEqual(server._task_metrics_cache[key], {'total': 0})

    def test_preexisting_snapshot_without_start_token_bypasses_cache(self):
        conn = server.get_conn()
        conn.execute('BEGIN')
        conn.execute('SELECT COUNT(*) FROM incident').fetchone()
        self.assign_hr()
        self.assertEqual(self.metrics()['total'], 1)
        self.assertEqual(server._task_metrics_cache, {})

    def test_http_snapshot_token_preserves_cache_hits_when_stable(self):
        conn = server.get_conn()
        with mock.patch.object(server, '_build_task_metrics_payload',
                               wraps=server._build_task_metrics_payload) as build:
            for _ in range(2):
                conn.execute('BEGIN')
                server._local.task_metrics_snapshot = server._task_metrics_snapshot_token(conn)
                self.assertEqual(self.metrics()['total'], 1)
                conn.rollback()
                server._local.task_metrics_snapshot = None
                server._local.hr_restrictions = None
            self.assertEqual(build.call_count, 1)


if __name__ == '__main__':
    unittest.main()
