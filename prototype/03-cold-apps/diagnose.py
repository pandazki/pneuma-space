"""Bounded timing diagnosis: one test app, at most 9 concurrent requests."""
import concurrent.futures
import http.client
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:10]
name = 'latency' + suffix
image = 'appbase-latency:' + suffix
volume = 'appbase-data-' + name
start = time.monotonic()


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def elapsed():
    return round((time.monotonic() - start) * 1000, 2)


def request(path):
    before = time.monotonic()
    with urllib.request.urlopen('http://127.0.0.1:8080/apps/' + name + '/' + path, timeout=30) as response:
        body = response.read()
        timing = response.headers.get('X-Appbase-Timings')
        assert response.status == 200 and body == b'ok' and timing, (response.status, timing)
    stages = {k: float(v) for k, v in (item.split('=') for item in timing.split(';'))}
    return {'at_ms': round((before - start) * 1000, 2), 'client_ms': round((time.monotonic() - before) * 1000, 2), **stages}


def sample(gateway, app):
    rows = docker('stats', '--no-stream', '--format', '{{json .}}', gateway, app).stdout.splitlines()
    state = [json.loads(line) for line in rows if line]
    return {'at_ms': elapsed(), 'containers': [{k: row[k] for k in ('Name', 'CPUPerc', 'MemUsage')} for row in state]}


created = built = False
with tempfile.TemporaryDirectory(prefix='appbase-latency-') as temp:
    p = pathlib.Path(temp)
    (p/'Dockerfile').write_text('FROM python:3.12.12-slim\nCOPY app.py /app.py\nCMD ["python", "-u", "/app.py"]\n')
    (p/'app.py').write_text('''import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/hold': time.sleep(1.5)
  self.send_response(200); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'ok')
ThreadingHTTPServer(('0.0.0.0',8000),H).serve_forever()
''')
    try:
        assert docker('image','inspect','python:3.12.12-slim',check=False).returncode == 0
        assert docker('volume','inspect',volume,check=False).returncode != 0
        assert all(row['name'] != name for row in appctl.call('/apps'))
        gateway_id = docker('compose','ps','-q','gateway').stdout.strip()
        gateway = docker('inspect','--format','{{.Name}}',gateway_id).stdout.strip().lstrip('/')
        docker('build','-t',image,temp)
        built = True
        appctl.call('/apps/publish', {'name':name,'image':image})
        created = True
        cold = request('')
        app = docker('ps','--filter','label=appbase.name='+name,'--format','{{.Names}}').stdout.strip()
        assert app and '\n' not in app
        # Direct-from-gateway baseline measures container DNS/connect and HTTP
        # without the gateway's per-request Docker start or proxy processing.
        direct_script = '''import http.client,json,time,sys
rows=[]
for i in range(15):
 start=time.monotonic(); c=http.client.HTTPConnection(sys.argv[1],8000,timeout=10); c.request("GET","/"); r=c.getresponse(); r.read(); rows.append(round((time.monotonic()-start)*1000,2)); c.close()
print(json.dumps(rows))'''
        direct = json.loads(docker('exec',gateway,'python','-c',direct_script,app).stdout)
        waves = []
        for wave in range(3):
            before = [request('') for _ in range(10)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
                held = list(pool.map(lambda _: request('hold'), range(9)))
            after = [request('') for _ in range(10)]
            resources = sample(gateway,app)
            waves.append({'wave':wave+1,'before':before,'held':held,'after':after,'resource_snapshot':resources})
            # Guardrail: abort if this bounded test becomes slow or unexpectedly heavy.
            if elapsed() > 90000:
                raise RuntimeError('diagnosis exceeded 90 seconds')
            for row in resources['containers']:
                raw=row['MemUsage'].split('/')[0].strip()
                value=float(raw[:-3]) if raw.endswith('MiB') else float(raw[:-3])*1024 if raw.endswith('GiB') else 0
                limit=128 if row['Name']==gateway else 64
                if value > limit:
                    raise RuntimeError('observed container memory exceeds threshold')
        print(json.dumps({'limits':{'max_apps':1,'max_concurrent_requests':9,'waves':3,'warm_samples_per_side':10,
                                    'memory_observation_threshold_mib':{'gateway':128,'app':64},'checked_elapsed_seconds':90},
                          'cold':cold,'direct_from_gateway_ms':direct,'waves':waves,'elapsed_ms':elapsed()},indent=2))
    finally:
        errors=[]
        if created:
            try:
                appctl.call('/apps/remove',{'name':name})
            except Exception as exc:
                errors.append('remove app: '+str(exc))
            else:
                r=docker('volume','rm',volume,check=False)
                if r.returncode and 'No such volume' not in r.stderr:
                    errors.append('remove volume: '+r.stderr)
        if built:
            r=docker('image','rm',image,check=False)
            if r.returncode:
                errors.append('remove image: '+r.stderr)
        if errors:
            raise RuntimeError('; '.join(errors))
