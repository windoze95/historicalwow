#!/usr/bin/env python3
"""Probe ServiceNow for whether a list of candidate tables exists on this
instance, and (cheaply) how many rows each has.

Usage on the VM:
  cd ~/historicalwow/project/export
  set -a; source .env; set +a
  python3 ../bin/probe_tables.py <table1> <table2> ...

Prints one line per table: name, exists/missing, row count if available.
Doesn't write anything — purely diagnostic."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

INSTANCE = (os.environ.get('SN_INSTANCE') or '').replace('https://', '').replace('http://', '')
CLIENT_ID = os.environ.get('SN_CLIENT_ID')
CLIENT_SECRET = os.environ.get('SN_CLIENT_SECRET')
USERNAME = os.environ.get('SN_USERNAME')
PASSWORD = os.environ.get('SN_PASSWORD')

if not all([INSTANCE, CLIENT_ID, CLIENT_SECRET, USERNAME, PASSWORD]):
    print('Missing SN_* env vars; source .env first.', file=sys.stderr)
    sys.exit(2)


def get_token():
    body = urllib.parse.urlencode({
        'grant_type': 'password',
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'username': USERNAME,
        'password': PASSWORD,
    }).encode()
    req = urllib.request.Request(
        f'https://{INSTANCE}/oauth_token.do', data=body,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())['access_token']


def probe(token, table):
    """Returns (status, rows_or_msg). status is 'ok'|'missing'|'error'."""
    qs = urllib.parse.urlencode({
        'sysparm_limit': 1,
        'sysparm_count': 'true',
        'sysparm_fields': 'sys_id',
    })
    req = urllib.request.Request(
        f'https://{INSTANCE}/api/now/table/{table}?{qs}',
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read())
            n = r.headers.get('X-Total-Count', '?')
            return ('ok', n)
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            return ('missing', f'HTTP {e.code}')
        try:
            body = e.read().decode('utf-8', errors='replace')[:200]
        except Exception:
            body = str(e)
        return ('error', f'HTTP {e.code} — {body}')
    except Exception as e:
        return ('error', str(e))


def main():
    tables = sys.argv[1:] or [
        'alm_software_license', 'samp_sw_install', 'samp_sw_subscription',
        'lic_master', 'alm_license', 'cmdb_software_instance',
        'cmdb_ci_spkg', 'cmdb_ci_software',
        'customer_contact', 'csm_consumer', 'csm_consumer_user',
    ]
    token = get_token()
    width = max(len(t) for t in tables)
    for t in tables:
        status, info = probe(token, t)
        print(f'{t.ljust(width)}  {status:<8} {info}')


if __name__ == '__main__':
    main()
