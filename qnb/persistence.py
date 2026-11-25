"""Batch publication of the durable SQLite proof journal."""

import json
import logging
import os
import sqlite3
import time
from collections import defaultdict
from contextlib import closing, contextmanager

import psycopg
from psycopg import sql

from . import store
from .runtime import RequestError

LOG = logging.getLogger(__name__)
# PostgreSQL stores proofs by account ID. Identity and session data stay in SQLite.
POSTGRES_SCHEMA = store.PROOF_SCHEMA.replace(" REFERENCES accounts(id)", "")


def stage_batch(buffer, offset, limit, *, graph=False):
    source_filter = "AND table_name = 'theorems'" if graph else ""
    buffer.execute("DROP TABLE IF EXISTS pending")
    buffer.execute(f"""
        CREATE TABLE pending AS
        SELECT sequence, table_name, row_key, queued_at FROM source.proof_sync_queue
        WHERE sequence > ? {source_filter} ORDER BY sequence LIMIT ?
    """, (offset, limit))
    return buffer.execute("SELECT count(*), min(queued_at), max(sequence) FROM pending").fetchone()


def batch_select(table):
    keys = store.PROOF_TABLES[table]
    match = " AND ".join(f"r.{key} = json_extract(p.row_key, '$[{i}]')"
                         for i, key in enumerate(keys))
    return f"""
        SELECT r.* FROM pending p JOIN source.{table} r ON {match}
        WHERE p.table_name = ? ORDER BY p.sequence
    """


@contextmanager
def materialize_postgres_batch(buffer):
    pending = {table for table, in buffer.execute("SELECT DISTINCT table_name FROM pending")}
    tables = []
    try:
        for table in store.PROOF_TABLES:
            if table in pending:
                buffer.execute(f"CREATE TABLE main.{table} AS {batch_select(table)}", (table,))
                tables.append(table)
        yield tables
    finally:
        for table in tables:
            buffer.execute(f"DROP TABLE main.{table}")


def prepare_postgres(connection):
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(48105001)")
            for statement in POSTGRES_SCHEMA.split(";"):
                if statement.strip():
                    cursor.execute(statement)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS proof_sync_checkpoint (
                    id INTEGER PRIMARY KEY CHECK (id = 1), sequence BIGINT NOT NULL
                )
            """)
            cursor.execute("INSERT INTO proof_sync_checkpoint VALUES (1, 0) ON CONFLICT DO NOTHING")


def flush_postgres(connection, buffer, limit, interval):
    with connection.transaction():
        with connection.cursor() as cursor:
            cursor.execute("SELECT sequence FROM proof_sync_checkpoint WHERE id = 1 FOR UPDATE")
            offset = cursor.fetchone()[0]
            count, oldest, last = stage_batch(buffer, offset, limit)
            if not count or (count < limit and time.time() - oldest < interval):
                return False
            with materialize_postgres_batch(buffer) as tables:
                for table in tables:
                    records = buffer.execute(f"SELECT * FROM main.{table} ORDER BY rowid")
                    columns = sql.SQL(", ").join(sql.Identifier(column[0]) for column in records.description)
                    values = sql.SQL(", ").join(sql.Placeholder() for _ in records.description)
                    insert = sql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT DO NOTHING")
                    cursor.executemany(insert.format(sql.Identifier(table), columns, values), map(tuple, records))
            cursor.execute("UPDATE proof_sync_checkpoint SET sequence = %s WHERE id = 1", (last,))
            return count == limit


def sync_graph(buffer, limit):
    with store.database() as db:
        checkpoint = db.execute(
            "SELECT sequence FROM proof_sync_offsets WHERE consumer = 'neo4j'"
        ).fetchone()
    count, _, last = stage_batch(buffer, checkpoint[0] if checkpoint else 0, limit, graph=True)
    if not count:
        return False
    owners = defaultdict(list)
    for record in buffer.execute(batch_select("theorems"), ("theorems",)):
        owners[record["account_id"]].append({
            "id": record["node_id"], "name": record["name"], "hash": record["content_hash"],
            "path": record["path"], "dependencies": json.loads(record["dependencies"]),
        })
    for owner, rows in owners.items():
        store.project(owner, rows)
    with store.database() as db:
        db.execute("""
            INSERT INTO proof_sync_offsets VALUES ('neo4j', ?)
            ON CONFLICT (consumer) DO UPDATE SET sequence = max(sequence, excluded.sequence)
        """, (last,))
    return count == limit


def run():
    limit = int(os.environ.get("QNB_BATCH_SIZE", "100"))
    interval = int(os.environ.get("QNB_BATCH_INTERVAL", "30"))
    if limit < 1 or interval < 1:
        raise ValueError("QNB_BATCH_SIZE and QNB_BATCH_INTERVAL must be positive")
    store.initialize()
    # The journal is retained on disk so a restart can recreate an uncommitted memory batch.
    source = store.database_path().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(":memory:", uri=True, timeout=10)) as buffer:
        buffer.row_factory = sqlite3.Row
        buffer.execute("PRAGMA temp_store = MEMORY")
        buffer.execute("ATTACH DATABASE ? AS source", (source,))
        postgres = None
        try:
            while True:
                more_graph = more_postgres = False
                failed = False
                try:
                    more_graph = sync_graph(buffer, limit)
                except (sqlite3.Error, RequestError):
                    LOG.exception("Neo4j proof publication will retry")
                    failed = True
                try:
                    if postgres is None:
                        postgres = psycopg.connect(os.environ["QNB_POSTGRES_DSN"], connect_timeout=5,
                                                   options="-c statement_timeout=15000")
                        prepare_postgres(postgres)
                    more_postgres = flush_postgres(postgres, buffer, limit, interval)
                except (sqlite3.Error, psycopg.Error):
                    LOG.exception("PostgreSQL proof publication will retry")
                    if postgres is not None:
                        postgres.close()
                        postgres = None
                    failed = True
                if failed:
                    time.sleep(5)
                elif not (more_graph or more_postgres):
                    time.sleep(1)
        finally:
            if postgres is not None:
                postgres.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
