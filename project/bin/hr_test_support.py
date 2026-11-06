"""Synthetic empty ownership tables for focused server tests."""
import build_sqlite
import server


def ensure_hr_tables(conn):
    present = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in server.HR_PROTECTED_TABLES - present:
        columns = ['"sys_id" TEXT PRIMARY KEY', '"raw" TEXT']
        columns += [f'"{name}" TEXT' for name, _ in build_sqlite.SCHEMAS[table]]
        conn.execute(f'CREATE TABLE "{table}" ({", ".join(columns)})')
