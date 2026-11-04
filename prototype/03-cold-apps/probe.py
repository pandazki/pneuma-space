"""Bounded local experiment; never use as a production capacity benchmark."""
import concurrent.futures
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

COUNT, MAX_ACTIVE, MAX_CONCURRENT = 24, 3, 9
GATEWAY_MEMORY_LIMIT_MIB, APP_MEMORY_LIMIT_MIB = 128, 64
TAG = 'appbase-loadtest:' + uuid.uuid4().hex[:10]
prefix = 'load' + uuid.uuid4().hex[:8]
names = [prefix + '-' + str(i) for i in range(COUNT)]
started = time.monotonic()


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


gateway_id = docker('compose', 'ps', '-q', 'gateway').stdout.strip()
if not gateway_id:
    raise RuntimeError('the Compose gateway is not running')
GATEWAY = docker('inspect', '--format', '{{.Name}}', gateway_id).stdout.strip().lstrip('/')


def mem_mib(text):
    match = re.match(r'\s*([\d.]+)\s*(KiB|MiB|GiB)', text)
    if not match:
        raise ValueError('unrecognised Docker memory: ' + text)
    return float(match.group(1)) * {'KiB': 1/1024, 'MiB': 1, 'GiB': 1024}[match.group(2)]


def stats(*containers):
    result = docker('stats', '--no-stream', '--format', '{{json .}}', *containers)
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    return {row['Name']: {'memory_mib': round(mem_mib(row['MemUsage']), 2), 'cpu': row['CPUPerc']} for row in rows}


def gateway_observation():
    # /proc/1/net/tcp is a network-namespace snapshot, not a peak or host-wide count.
    script = '''import json, os
ports = {"1F90", "1F91"}
counts = {}
for fn in ("/proc/1/net/tcp", "/proc/1/net/tcp6"):
    with open(fn) as f:
        next(f)
        for line in f:
            p = line.split()
            if p[1].split(":")[-1] in ports:
                counts[p[3]] = counts.get(p[3], 0) + 1
print(json.dumps({"fds":len(os.listdir("/proc/1/fd")), "tcp_states_hex":counts}))'''
    return json.loads(docker('exec', GATEWAY, 'python', '-c', script).stdout)


def get(name, path=''):
    start = time.monotonic()
    with urllib.request.urlopen('http://127.0.0.1:8080/apps/' + name + '/' + path, timeout=30) as response:
        response.read()
        assert response.status == 200
    return round((time.monotonic() - start) * 1000, 1)


def check_limits(rows):
    for name, data in rows.items():
        limit = GATEWAY_MEMORY_LIMIT_MIB if name == GATEWAY else APP_MEMORY_LIMIT_MIB
        if data['memory_mib'] > limit:
            raise RuntimeError('observed memory exceeds stop threshold: ' + name)
    if time.monotonic() - started > 180:
        raise RuntimeError('experiment exceeded 180 seconds')


created = []
image_built = False
with tempfile.TemporaryDirectory(prefix='appbase-loadtest-') as temp:
    temp_path = pathlib.Path(temp)
    (temp_path / 'Dockerfile').write_text('FROM python:3.12.12-slim\nCOPY app.py /app.py\nCMD ["python", "-u", "/app.py"]\n')
    (temp_path / 'app.py').write_text('''import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/hold': time.sleep(1.5)
  self.send_response(200); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'ok')
ThreadingHTTPServer(('0.0.0.0', 8000), H).serve_forever()
''')
    try:
        if docker('image', 'inspect', 'python:3.12.12-slim', check=False).returncode:
            raise RuntimeError('cached python:3.12.12-slim image required; no image will be pulled')
        existing = {item['name'] for item in appctl.call('/apps')}
        assert not existing.intersection(names), 'name collision'
        for name in names:
            assert docker('volume', 'inspect', 'appbase-data-' + name, check=False).returncode != 0, 'volume collision'
        baseline = {'gateway': stats(GATEWAY), 'connections': gateway_observation()}
        check_limits(baseline['gateway'])
        docker('build', '-t', TAG, temp)
        image_built = True
        publish_times = []
        for name in names:
            t = time.monotonic()
            appctl.call('/apps/publish', {'name': name, 'image': TAG})
            created.append(name)
            publish_times.append(round((time.monotonic() - t) * 1000, 1))
        listing_started = time.monotonic()
        listing = appctl.call('/apps')
        listing_ms = round((time.monotonic() - listing_started) * 1000, 1)
        assert sum(item['name'] in names and not item['running'] for item in listing) == COUNT
        after_cold = {'gateway': stats(GATEWAY), 'connections': gateway_observation(), 'list_ms': listing_ms}
        check_limits(after_cold['gateway'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_ACTIVE) as pool:
            cold_latencies = list(pool.map(get, names[:MAX_ACTIVE]))
        containers = []
        for name in names[:MAX_ACTIVE]:
            matching = docker('ps', '--filter', 'label=appbase.name=' + name, '--format', '{{.Names}}').stdout.splitlines()
            assert len(matching) == 1, (name, matching)
            containers.extend(matching)
        # Re-stop one uniquely named test container, then race three first requests
        # to the same app; total active test containers stays at or below three.
        docker('stop', containers[0])
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_ACTIVE) as pool:
            same_app_cold_ms = list(pool.map(lambda _: get(names[0]), range(MAX_ACTIVE)))
        active_stats = stats(GATEWAY, *containers)
        check_limits(active_stats)
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
            futures = [pool.submit(get, names[i % MAX_ACTIVE], 'hold') for i in range(MAX_CONCURRENT)]
            time.sleep(.6)
            inflight = gateway_observation()
            held_latencies = [future.result() for future in futures]
        warm_latencies = [get(name) for name in names[:MAX_ACTIVE]]
        check_limits(stats(GATEWAY, *containers))
        result = {'limits': {'cold_apps': COUNT, 'max_active_apps': MAX_ACTIVE, 'concurrent_requests': MAX_CONCURRENT,
                             'observed_gateway_stop_mib': GATEWAY_MEMORY_LIMIT_MIB, 'observed_app_stop_mib': APP_MEMORY_LIMIT_MIB,
                             'max_seconds_checked': 180},
                  'baseline': baseline, 'after_cold_registration': after_cold, 'active_stats': active_stats,
                  'publish_ms': publish_times, 'cold_parallel_ms': cold_latencies,
                  'same_app_cold_ms': same_app_cold_ms, 'warm_sequential_ms': warm_latencies, 'held_request_ms': held_latencies,
                  'during_held_requests': inflight, 'elapsed_seconds': round(time.monotonic() - started, 1)}
        print(json.dumps(result, indent=2), flush=True)
    finally:
        errors = []
        for name in reversed(created):
            try:
                appctl.call('/apps/remove', {'name': name})
            except Exception as exc:
                errors.append('registration ' + name + ': ' + str(exc))
                continue
            removed = docker('volume', 'rm', 'appbase-data-' + name, check=False)
            if removed.returncode and 'No such volume' not in removed.stderr:
                errors.append('volume ' + name + ': ' + removed.stderr.strip())
        if image_built:
            removed = docker('image', 'rm', TAG, check=False)
            if removed.returncode:
                errors.append('image ' + TAG + ': ' + removed.stderr.strip())
        if errors:
            raise RuntimeError('cleanup incomplete: ' + '; '.join(errors))
