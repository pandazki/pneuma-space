"""Exercise both real backends in a disposable, networkless PostgreSQL container."""
import concurrent.futures
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, "/app")
from records import RecordStore
from business_probe import run as run_business_probe
from order_probe import run as run_order_probe

root = pathlib.Path(tempfile.mkdtemp(prefix="appbase-smoke-"))
data = root / "postgres"
sock = root / "socket"
sock.mkdir()
pgbin = "/usr/lib/postgresql/16/bin/"
subprocess.run([pgbin + "initdb", "-D", str(data), "--auth-local=peer", "--auth-host=scram-sha-256"], check=True, stdout=subprocess.DEVNULL)
subprocess.run([pgbin + "pg_ctl", "-D", str(data), "-l", str(root / "postgres.log"), "-o", "-c listen_addresses='' -k " + str(sock), "-w", "start"], check=True, stdout=subprocess.DEVNULL)
os.environ.update(PGHOST=str(sock), PGUSER="postgres", PGDATABASE="postgres", DATA_DIR=str(root))
spec = importlib.util.spec_from_file_location("store", "/app/store.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def check_backend(backend):
    store = module.CounterStore(backend, str(root / "counter.sqlite3"))
    store.setup()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: store.increment(), range(40)))
    assert store.get() == 40, (backend, store.get())
    try:
        with store.transaction() as db:
            db.execute("UPDATE counter SET value = 41 WHERE id = 1")
            db.execute("UPDATE counter SET value = -1 WHERE id = 1")
    except Exception:
        pass
    else:
        raise AssertionError(backend + " accepted invalid value")
    assert store.get() == 40, backend + " failed to roll back"
    try:
        with store.transaction() as db:
            db.execute("INSERT INTO counter VALUES (2, 0)")
    except Exception:
        pass
    else:
        raise AssertionError(backend + " accepted invalid id")
    records = RecordStore(backend, str(root / "counter.sqlite3"))
    records.setup()
    assert records.create("notes", "one", {"text": "initial"})
    assert not records.create("notes", "one", {"text": "retry"})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda n: records.replace("notes", "one", n, 1), range(20)))
    assert sum(outcomes) == 1
    assert records.get("notes", "one")["revision"] == 2
    assert not records.delete("notes", "one", 1)
    assert records.delete("notes", "one", 2)
    assert not records.delete("notes", "one", 2)
    assert records.get("notes", "one") is None
    assert records.create("notes", "one", {"text": "recreated"})
    assert records.get("notes", "one")["revision"] == 4
    assert not records.replace("notes", "one", "stale", 1)
    env = dict(os.environ, DB_BACKEND=backend)
    app = subprocess.Popen(["python", "/app/app.py"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for attempt in range(50):
            try:
                with urllib.request.urlopen("http://127.0.0.1:8000/", timeout=1) as response:
                    page = response.read().decode()
                break
            except OSError:
                if app.poll() is not None:
                    raise RuntimeError(backend + " app exited during startup")
                time.sleep(0.1)
        else:
            raise RuntimeError(backend + " app did not start")
        assert "Count: <strong>40</strong>" in page and "Storage backend: " + backend in page
        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/increment", data=b"")) as response:
            assert "Count: <strong>41</strong>" in response.read().decode()
        print(backend + ": concurrent increments, rollback, constraints, record CRUD/retries and HTTP increment passed", flush=True)
    finally:
        app.terminate()
        app.wait(timeout=5)


try:
    check_backend("sqlite")
    check_backend("postgres")
    run_business_probe("sqlite", str(root / "business.sqlite3"))
    run_business_probe("postgres", None)
    run_order_probe("sqlite", str(root / "orders.sqlite3"))
    run_order_probe("postgres", None)
    # Different backends contain separate data; switching does not migrate it.
    assert module.CounterStore("sqlite", str(root / "counter.sqlite3")).get() == 41
finally:
    subprocess.run([pgbin + "pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], check=True, stdout=subprocess.DEVNULL)
