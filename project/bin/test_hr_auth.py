#!/usr/bin/env python3
"""Offline HR authentication regressions using only synthetic archive records.

Run from the repository root: python3 project/bin/test_hr_auth.py
"""
import io
import json
import os
import sqlite3
import unittest

os.environ.setdefault('HISTORICALWOW_ACCESS_LOG', '')

import server  # noqa: E402


class Handler:
    def __init__(self, cookie=None):
        self.headers = {} if cookie is None else {'Cookie': cookie}
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, key, value):
        self.response_headers[key] = value

    def end_headers(self):
        pass

    def payload(self):
        return json.loads(self.wfile.getvalue())


class HrAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.old_password = server.HR_UNLOCK_PASSWORD
        self.old_group = server.HR_GROUP_SYS_ID
        self.old_conn = getattr(server._local, 'conn', None)
        with server._hr_tokens_lock:
            self.old_tokens = set(server._hr_tokens)
            server._hr_tokens.clear()
        server.HR_UNLOCK_PASSWORD = 'synthetic-hr-password'
        server.HR_GROUP_SYS_ID = 'synthetic-hr-group'
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('''CREATE TABLE incident (
            sys_id TEXT PRIMARY KEY, number TEXT, assignment_group TEXT,
            short_description TEXT, raw TEXT, parent TEXT
        )''')
        self.conn.executemany(
            'INSERT INTO incident (sys_id, number, assignment_group, short_description, raw) VALUES (?, ?, ?, ?, ?)',
            [
                ('hr-record', 'INC-HR-TEST', 'synthetic-hr-group',
                 'synthetic protected content', '{}'),
                ('ordinary-record', 'INC-ORDINARY-TEST', 'ordinary-group',
                 'synthetic ordinary content', '{}'),
            ],
        )
        server._local.conn = self.conn

    def tearDown(self):
        server.HR_UNLOCK_PASSWORD = self.old_password
        server.HR_GROUP_SYS_ID = self.old_group
        with server._hr_tokens_lock:
            server._hr_tokens.clear()
            server._hr_tokens.update(self.old_tokens)
        if self.old_conn is None:
            del server._local.conn
        else:
            server._local.conn = self.old_conn
        self.conn.close()

    def unlock(self):
        handler = Handler()
        server.post_hr_unlock(handler, json.dumps({
            'password': server.HR_UNLOCK_PASSWORD,
        }).encode())
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload(), {'ok': True})
        cookie_header = handler.response_headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie_header)
        self.assertIn('SameSite=Strict', cookie_header)
        self.assertEqual(handler.response_headers['Cache-Control'], 'no-store')
        return cookie_header.split(';', 1)[0]

    def assert_hr_denied(self, cookie=None):
        handler = Handler(cookie)
        server.get_record(handler, 'incident', 'hr-record')
        self.assertEqual(handler.status, 403)
        self.assertNotIn(b'synthetic protected content', handler.wfile.getvalue())
        handler = Handler(cookie)
        server.list_table(handler, 'incident', {
            'assignment_group': ['synthetic-hr-group'], 'limit': ['100'],
        })
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload()['rows'], [])
        self.assertEqual(handler.payload()['total'], 0)

    def test_missing_password_stays_locked_even_for_previously_valid_token(self):
        cookie = self.unlock()
        server.HR_UNLOCK_PASSWORD = ''
        self.assertTrue(server.hr_gate_enabled())
        for presented_cookie in (None, 'hr_unlock=forged', cookie):
            with self.subTest(cookie=presented_cookie):
                self.assertFalse(server.is_hr_unlocked(Handler(presented_cookie)))
                self.assert_hr_denied(presented_cookie)
        handler = Handler(cookie)
        server.get_hr_status(handler)
        self.assertTrue(handler.payload()['enabled'])
        self.assertFalse(handler.payload()['unlocked'])

    def test_missing_password_does_not_issue_unlock_token(self):
        server.HR_UNLOCK_PASSWORD = ''
        for password in ('', 'synthetic-hr-password'):
            handler = Handler()
            server.post_hr_unlock(handler, json.dumps({'password': password}).encode())
            self.assertEqual(handler.status, 503)
            self.assertNotIn('Set-Cookie', handler.response_headers)
        self.assertEqual(server._hr_tokens, set())

    def test_absent_forged_and_misnamed_cookies_cannot_read_hr(self):
        cookie = self.unlock()
        token = cookie.partition('=')[2]
        for presented_cookie in (None, 'hr_unlock=forged',
                                 f'other_hr_unlock={token}',
                                 f'hr_unlock={token}extra'):
            with self.subTest(cookie=presented_cookie):
                self.assert_hr_denied(presented_cookie)

    def test_wrong_or_missing_password_does_not_issue_token(self):
        for body in (b'{}', b'{"password":""}', b'{"password":"wrong"}'):
            handler = Handler()
            server.post_hr_unlock(handler, body)
            self.assertEqual(handler.status, 403)
            self.assertNotIn('Set-Cookie', handler.response_headers)
        self.assertEqual(server._hr_tokens, set())

    def test_correct_password_unlocks_and_lock_revokes_replayed_cookie(self):
        cookie = self.unlock()
        handler = Handler(f'unrelated=value; {cookie}')
        server.get_hr_status(handler)
        self.assertTrue(handler.payload()['unlocked'])
        self.assertIn('Cookie', handler.response_headers['Vary'])
        handler = Handler(cookie)
        server.get_record(handler, 'incident', 'hr-record')
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.payload()['short_description'],
                         'synthetic protected content')
        handler = Handler(cookie)
        server.post_hr_lock(handler)
        self.assertEqual(handler.status, 200)
        self.assertIn('Max-Age=0', handler.response_headers['Set-Cookie'])
        self.assertEqual(handler.response_headers['Cache-Control'], 'no-store')
        self.assert_hr_denied(cookie)
        self.assertFalse(server.is_hr_unlocked(Handler(cookie)))

    def test_lock_revokes_only_the_presented_session(self):
        first = self.unlock()
        second = self.unlock()
        self.assertNotEqual(first, second)
        for cookie in (None, 'hr_unlock=forged', first, first):
            handler = Handler(cookie)
            server.post_hr_lock(handler)
            self.assertEqual(handler.status, 200)
        self.assert_hr_denied(first)
        self.assertTrue(server.is_hr_unlocked(Handler(second)))

    def test_locked_requests_can_still_read_ordinary_records(self):
        for password in ('synthetic-hr-password', ''):
            server.HR_UNLOCK_PASSWORD = password
            handler = Handler()
            server.get_record(handler, 'incident', 'ordinary-record')
            self.assertEqual(handler.status, 200)
            self.assertEqual(handler.payload()['sys_id'], 'ordinary-record')


if __name__ == '__main__':
    unittest.main()
