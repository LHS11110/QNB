import json
import os
import sqlite3
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from .runtime import RequestError, digest

ACCOUNT_SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    vm_id INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    expires INTEGER NOT NULL
);
"""

PROOF_SCHEMA = """
CREATE TABLE IF NOT EXISTS theorems (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    node_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, node_id)
);
CREATE INDEX IF NOT EXISTS theorem_name ON theorems (account_id, name);
CREATE TABLE IF NOT EXISTS lean_archives (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    prerequisites TEXT NOT NULL,
    bindings TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS lean_archive_statements (
    account_id INTEGER NOT NULL,
    archive_id TEXT NOT NULL,
    statements TEXT NOT NULL,
    PRIMARY KEY (account_id, archive_id),
    FOREIGN KEY (account_id, archive_id) REFERENCES lean_archives(account_id, id)
);
CREATE TABLE IF NOT EXISTS lean_symbols (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    FOREIGN KEY (account_id, archive_id) REFERENCES lean_archives(account_id, id),
    PRIMARY KEY (account_id, name, archive_id)
);
CREATE INDEX IF NOT EXISTS lean_symbol_short_name ON lean_symbols (account_id, short_name);
"""

SCHEMA = ACCOUNT_SCHEMA + PROOF_SCHEMA

PROOF_TABLES = {
    "theorems": ("account_id", "node_id"),
    "lean_archives": ("account_id", "id"),
    "lean_archive_statements": ("account_id", "archive_id"),
    "lean_symbols": ("account_id", "name", "archive_id"),
}

GRAPH_UPSERT = """
UNWIND $rows AS row
MERGE (n:Declaration {owner: $owner, id: row.id})
SET n.name = row.name, n.hash = row.hash, n.path = row.path, n.kind = 'theorem'
WITH n, row
UNWIND row.dependencies AS dep
MERGE (d:Declaration {owner: $owner, id: dep.id})
ON CREATE SET d.name = dep.name
SET d.kind = coalesce(dep.kind, 'theorem')
MERGE (n)-[:DEPENDS_ON]->(d)
"""

GRAPH_READ = """
MATCH (n:Declaration {owner: $owner})
WHERE n.id IN $ids
OPTIONAL MATCH (n)-[:DEPENDS_ON]->(d:Declaration {owner: $owner})
RETURN n { .id, .name, .hash, .path, .kind }, collect(d { .id, .name, .hash, .path, .kind })
ORDER BY n.name, n.id
"""


def database_path():
    return Path(os.environ.get("QNB_DATABASE", "data/qnb.sqlite3")).resolve()


@contextmanager
def database():
    location = database_path()
    location.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(location, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys = ON")
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with database() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'theorem_statements'").fetchone():
            initialize_theorem_statements(db)
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_sync_offsets (
                consumer TEXT PRIMARY KEY, sequence INTEGER NOT NULL
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS proof_sync_queue (
                sequence INTEGER PRIMARY KEY,
                table_name TEXT NOT NULL,
                row_key TEXT NOT NULL,
                queued_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS proof_sync_queue_table
            ON proof_sync_queue (table_name, sequence)
        """)
        for table, keys in PROOF_TABLES.items():
            trigger = f"queue_{table}_insert"
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (trigger,)).fetchone():
                db.execute(f"""
                    INSERT INTO proof_sync_queue (table_name, row_key, queued_at)
                    SELECT ?, json_array({", ".join(keys)}), 0 FROM {table} ORDER BY rowid
                """, (table,))
                new_key = ", ".join(f"NEW.{key}" for key in keys)
                db.execute(f"""
                    CREATE TRIGGER {trigger} AFTER INSERT ON {table}
                    BEGIN
                        INSERT INTO proof_sync_queue (table_name, row_key)
                        VALUES ('{table}', json_array({new_key}));
                    END
                """)


def statement_fingerprint(statement):
    if not statement or "type" not in statement:
        return None
    levels = {name: index for index, name in enumerate(statement["levelParams"])}

    def normalize(term):
        if isinstance(term, list):
            return [normalize(item) for item in term]
        if not isinstance(term, dict):
            return term
        if "mdata" in term:
            return normalize(term["mdata"]["expr"])
        if "param" in term:
            return {"param": levels[term["param"]]}
        if "letE" in term:
            return {"letE": {key: normalize(value) for key, value in term["letE"].items()
                             if key not in ("declName", "nonDep")}}
        return {key: normalize(value) for key, value in term.items()
                if key not in ("binderName", "binderInfo")}

    return digest(json.dumps([len(levels), normalize(statement["type"])], sort_keys=True))


def statement_key(statement, fingerprint, archive_id):
    # Local constants with the same name can denote different definitions in different notebooks.
    if statement.get("needsContext", True):
        return digest(json.dumps([archive_id, fingerprint]))
    return fingerprint


def initialize_theorem_statements(db):
    db.execute("""
        CREATE TABLE theorem_statements (
            account_id INTEGER NOT NULL,
            statement_key TEXT NOT NULL,
            node_id TEXT NOT NULL,
            PRIMARY KEY (account_id, statement_key),
            FOREIGN KEY (account_id, node_id) REFERENCES theorems(account_id, node_id)
        )
    """)
    archives = db.execute("""
        SELECT a.account_id, a.id, a.bindings, t.statements
        FROM lean_archives a JOIN lean_archive_statements t
          ON a.account_id = t.account_id AND a.id = t.archive_id
        ORDER BY a.rowid
    """)
    for archive in archives:
        bindings = json.loads(archive["bindings"])
        for item in json.loads(archive["statements"]):
            statement = item["statement"]
            if fingerprint := statement_fingerprint(statement):
                key = statement_key(statement, fingerprint, archive["id"])
                db.execute("""
                    INSERT OR IGNORE INTO theorem_statements
                    SELECT account_id, ?, node_id FROM theorems WHERE account_id = ? AND node_id = ?
                """, (key, archive["account_id"], bindings.get(statement["name"])))


def save_declarations(account_id, file_path, rows, definitions, document, entries, imported):
    if not (rows or definitions):
        return []
    prerequisites = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    archive = digest(json.dumps([document, entries, imported], ensure_ascii=False, sort_keys=True))
    statements = [{"span": row["span"], "statement": row["statement"]} for row in rows]
    inserted = []
    aliases = {}
    bindings = dict(imported)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        for row in rows:
            statement = row["statement"]
            fingerprint = statement_fingerprint(statement)
            key = statement_key(statement, fingerprint, archive) if fingerprint else None
            existing = db.execute("""
                SELECT t.node_id, t.name FROM theorem_statements s JOIN theorems t USING (account_id, node_id)
                WHERE s.account_id = ? AND s.statement_key = ?
            """, (account_id, key)).fetchone() if key else None
            if existing:
                aliases[row["id"]] = {"id": existing["node_id"], "name": existing["name"]}
                bindings[row["name"]] = existing["node_id"]
                continue
            node_id = digest(json.dumps([row["id"], fingerprint])) if fingerprint else row["id"]
            dependencies = {}
            for dep in row["dependencies"]:
                target = aliases.get(dep["id"], dep)
                if target["id"] != node_id:
                    dependencies[target["id"]] = target
            deps = list(dependencies.values())
            result = db.execute("""
                INSERT OR IGNORE INTO theorems
                (account_id, node_id, name, content_hash, source, path, dependencies)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (account_id, node_id, row["name"], row["hash"], row["source"], file_path,
                  json.dumps(deps, ensure_ascii=False)))
            bindings[row["name"]] = node_id
            aliases[row["id"]] = {"id": node_id, "name": row["name"]}
            if key:
                db.execute("INSERT INTO theorem_statements VALUES (?, ?, ?)", (account_id, key, node_id))
            if result.rowcount:
                inserted.append(row | {"id": node_id, "dependencies": deps, "path": file_path})
        db.execute("INSERT OR IGNORE INTO lean_archives VALUES (?, ?, ?, ?, ?)",
                   (account_id, archive, document, prerequisites, json.dumps(bindings, ensure_ascii=False)))
        db.execute("INSERT OR IGNORE INTO lean_archive_statements VALUES (?, ?, ?)",
                   (account_id, archive, json.dumps(statements, ensure_ascii=False)))
        db.executemany("INSERT OR IGNORE INTO lean_symbols VALUES (?, ?, ?, ?)", [
            (account_id, row["name"], row["name"].rsplit(".", 1)[-1], archive)
            for row in rows + definitions if not row["name"].startswith("_private.")
        ])
    return inserted


def masked_archive_source(source, statements):
    # Older snapshots stored spaces in place of theorem proofs.
    lines = [list(line) for line in source.split("\n")]
    for row in statements:
        start, start_col, end, end_col = row["span"]
        for line in range(start - 1, end):
            left = start_col if line == start - 1 else 0
            right = end_col if line == end - 1 else len(lines[line])
            lines[line][left:right] = " " * (right - left)
    return "\n".join("".join(line) for line in lines)


def archive_entry(name, source, prerequisites):
    return {"entry": {"name": name, "source": source, "prerequisites": prerequisites, "line": 1,
                      "statements": []}}


def restore_archive_source(db, account_id, snapshot):
    entry = snapshot["entry"]
    source = entry["source"]
    if entry["statements"]:
        candidates = set()
        for row in db.execute("""
            SELECT a.source, typed.statements, a.prerequisites
            FROM lean_symbols s JOIN lean_archives a
              ON a.account_id = s.account_id AND a.id = s.archive_id
            JOIN lean_archive_statements typed
              ON typed.account_id = a.account_id AND typed.archive_id = a.id
            WHERE s.account_id = ? AND s.name = ?
        """, (account_id, entry["name"])):
            statements = json.loads(row["statements"])
            if ([item["statement"] for item in statements] == entry["statements"]
                    and json.loads(row["prerequisites"]) == entry["prerequisites"]
                    and masked_archive_source(row["source"], statements) == source):
                candidates.add(row["source"])
        if len(candidates) != 1:
            raise RequestError(f"저장된 선언 {entry['name']}의 증명 원본을 확인할 수 없습니다. 원본 셀을 다시 실행하세요.", 409)
        source = candidates.pop()
    prerequisites = [restore_archive_source(db, account_id, item) for item in entry["prerequisites"]]
    return {"entry": entry | {"source": source, "prerequisites": prerequisites, "statements": []}}


def lookup_declaration(account_id, name):
    with database() as db:
        query = """
            SELECT s.name, a.source, a.prerequisites, a.bindings, typed.statements
            FROM lean_symbols s JOIN lean_archives a
              ON a.account_id = s.account_id AND a.id = s.archive_id
            JOIN lean_archive_statements typed
              ON typed.account_id = a.account_id AND typed.archive_id = a.id
            WHERE s.account_id = ?
        """
        record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                            (account_id, name)).fetchone()
        if not record and "." not in name:
            matches = db.execute("""
                SELECT DISTINCT name FROM lean_symbols
                WHERE account_id = ? AND short_name = ? LIMIT 2
            """, (account_id, name)).fetchall()
            if len(matches) == 1:
                record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                                    (account_id, matches[0]["name"])).fetchone()
        parent = name
        while not record and "." in parent:
            parent = parent.rsplit(".", 1)[0]
            record = db.execute(query + " AND s.name = ? ORDER BY s.rowid DESC LIMIT 1",
                                (account_id, parent)).fetchone()
        if record:
            prerequisites = [restore_archive_source(db, account_id, item)
                             for item in json.loads(record["prerequisites"])]
            entry = archive_entry(record["name"], record["source"], prerequisites)
            return entry, json.loads(record["bindings"])
        legacy = db.execute("""
            SELECT 1 FROM lean_symbols WHERE account_id = ? AND name = ?
            UNION ALL
            SELECT 1 FROM theorems WHERE account_id = ? AND name = ?
        """, (account_id, name, account_id, name)).fetchone()
        if legacy:
            return None, {}
        return None


def graph_query(statement, **parameters):
    endpoint = os.environ.get("QNB_NEO4J_URL", "http://neo4j:7474").rstrip("/")
    request = Request(endpoint + "/db/neo4j/query/v2", data=json.dumps({
        "statement": statement, "parameters": parameters,
    }).encode(), headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=5) as response:
            data = json.load(response)
        if data.get("errors"):
            raise ValueError(data["errors"])
        return data["data"]["values"]
    except (URLError, TimeoutError, KeyError, TypeError, ValueError) as error:
        raise RequestError("그래프 DB에 연결할 수 없습니다. 저장된 정리는 연결이 복구되면 다시 표시됩니다.", 503) from error


def project(owner, rows):
    if not rows:
        return
    graph_query("CREATE CONSTRAINT qnb_owner_id IF NOT EXISTS FOR (n:Declaration) REQUIRE (n.owner, n.id) IS UNIQUE")
    graph_query(GRAPH_UPSERT, owner=owner, rows=rows)


def proof_tree(owner, page, root_id, limit, max_depth):
    with database() as db:
        catalog = db.execute("""
            SELECT node_id AS id, name FROM theorems
            WHERE account_id = ? ORDER BY rowid DESC LIMIT 26 OFFSET ?
        """, (owner, page * 25)).fetchall()
        result = {"theorems": [dict(row) for row in catalog[:25]], "hasMore": len(catalog) > 25,
                  "root": None, "nodes": [], "edges": [], "limitedBy": []}
        if root_id is None:
            if not catalog:
                return result
            root_id = catalog[0]["id"]

        def load(node_id):
            row = db.execute("""
                SELECT node_id AS id, name, content_hash AS hash, path, dependencies
                FROM theorems WHERE account_id = ? AND node_id = ?
            """, (owner, node_id)).fetchone()
            if row is None:
                return None, []
            node = dict(row)
            dependencies = json.loads(node.pop("dependencies"))
            return node | {"kind": "theorem"}, dependencies

        root, dependencies = load(root_id)
        if root is None:
            raise RequestError("저장된 정리를 찾을 수 없습니다.", 404)
        nodes = {root_id: root | {"depth": 0}}
        pending = deque([(root_id, 0, dependencies)])
        edges = {}
        external = []
        limited = set()
        while pending:
            source, depth, dependencies = pending.popleft()
            if depth == max_depth:
                if dependencies:
                    limited.add("depth")
                continue
            for dependency in dependencies:
                target = dependency["id"]
                if target.startswith(("axiom:", "external:")):
                    external.append((source, depth + 1, dependency))
                    continue
                if target not in nodes:
                    if len(nodes) == limit:
                        limited.add("nodes")
                        continue
                    node, children = load(target)
                    nodes[target] = (node or {
                        "id": target, "name": dependency["name"], "kind": dependency.get("kind", "theorem"),
                    }) | {"depth": depth + 1}
                    if children:
                        pending.append((target, depth + 1, children))
                edges[source, target] = {"from": source, "to": target}
        # Keep the saved proof chain visible when imported lemmas exhaust the node budget.
        for source, depth, dependency in external:
            target = dependency["id"]
            if target not in nodes:
                if len(nodes) == limit:
                    limited.add("nodes")
                    continue
                nodes[target] = dependency | {"kind": dependency.get("kind", "theorem"), "depth": depth}
            edges[source, target] = {"from": source, "to": target}
        return result | {"root": root_id, "nodes": list(nodes.values()), "edges": list(edges.values()),
                         "limitedBy": sorted(limited)}


def dependency_graph(owner, page):
    with database() as db:
        records = db.execute("""
            SELECT node_id AS id, name, content_hash AS hash, path, dependencies
            FROM theorems WHERE account_id = ?
            ORDER BY rowid DESC LIMIT 26 OFFSET ?
        """, (owner, page * 25)).fetchall()
        if not records:
            return {"nodes": [], "edges": [], "hasMore": False}
        rows = [dict(record) for record in records[:25]]
        for row in rows:
            row["dependencies"] = json.loads(row["dependencies"])

        # Rehydrate dependency metadata after a graph restart or rebuild.
        linked = {dep["id"] for row in rows for dep in row["dependencies"]
                  if dep.get("kind") != "axiom" and not dep["id"].startswith("external:")}
        for dependency in linked - {row["id"] for row in rows}:
            record = db.execute("""
                SELECT node_id AS id, name, content_hash AS hash, path
                FROM theorems WHERE account_id = ? AND node_id = ?
            """, (owner, dependency)).fetchone()
            if record:
                graph_row = dict(record) | {"dependencies": []}
                graph_row["primary"] = False
                rows.append(graph_row)
    project(owner, rows)
    ids = [row["id"] for row in rows if row.get("primary", True)]
    nodes, edges = {}, []
    for node, dependencies in graph_query(GRAPH_READ, owner=owner, ids=ids):
        nodes[node["id"]] = node | {"primary": True}
        for dependency in dependencies:
            nodes.setdefault(dependency["id"], dependency)
            edges.append({"from": node["id"], "to": dependency["id"]})
    return {"nodes": list(nodes.values()), "edges": edges, "hasMore": len(records) > 25}
