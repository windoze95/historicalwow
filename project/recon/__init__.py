"""Pre-shutdown reconciliation harness for the HistoricalWow archive.

Proves the deployed SQLite archive is a complete, faithful copy of the live
ServiceNow instance before the source is decommissioned. Run as a module:

    python3 -m recon.reconcile --phase all --sample 200

See recon/README.md for the full procedure and verdict interpretation.
"""
