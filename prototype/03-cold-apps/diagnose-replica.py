"""Repeat the original bounded 24-cold/3-active scenario with stage timings."""
import concurrent.futures
import http.client
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:8]
names = ['trace' + suffix + '-' + str(i) for i in range(24)]
image = 'appbase-tracereplica:' + suffix
started = time.monotonic()


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def sample(name, path=''):
    before = time.monotonic()
    conn = http.client.HTTPConnection('127.0.0.1', 8080, timeout=30)
    try:
        conn.connect()
        connected = time.monotonic()
        conn.request('GET', '/apps/' + name + '/' + path)
        sent = time.monotonic()
        response = conn.getresponse()
        headers_received = time.monotonic()
        body, timing = response.read(), response.getheader('X-Appbase-Timings')
        finished = time.monotonic()
        assert response.status == 200 and body == b'ok' and timing
    finally:
        conn.close()
    return {'at_ms':round((before-started)*1000,2), 'client_ms':round((finished-before)*1000,2),
            'host_connect_ms':round((connected-before)*1000,2), 'host_send_ms':round((sent-connected)*1000,2),
            'host_wait_headers_ms':round((headers_received-sent)*1000,2), 'host_read_ms':round((finished-headers_received)*1000,2),
            **{k:float(v) for k,v in (item.split('=') for item in timing.split(';'))}}


def resources(gateway, containers):
    output = docker('stats', '--no-stream', '--format', '{{json .}}', gateway, *containers).stdout
    rows = [json.loads(line) for line in output.splitlines() if line]
    result = [{'name':row['Name'], 'cpu':row['CPUPerc'], 'memory':row['MemUsage']} for row in rows]
    for row in result:
        raw=row['memory'].split('/')[0].strip()
        mib=float(raw[:-3]) if raw.endswith('MiB') else float(raw[:-3])*1024 if raw.endswith('GiB') else 0
        if mib > (128 if row['name']==gateway else 64):
            raise RuntimeError('observed memory threshold exceeded')
    return {'at_ms':round((time.monotonic()-started)*1000,2),'containers':result}


created=[]
built=False
with tempfile.TemporaryDirectory(prefix='appbase-trace-replica-') as temp:
    p=pathlib.Path(temp)
    (p/'Dockerfile').write_text('FROM python:3.12.12-slim\nCOPY app.py /app.py\nCMD ["python", "-u", "/app.py"]\n')
    (p/'app.py').write_text('''import time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path == '/hold': time.sleep(1.5)
  self.send_response(200); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'ok')
ThreadingHTTPServer(('0.0.0.0',8000),H).serve_forever()
''')
    try:
        assert docker('image','inspect','python:3.12.12-slim',check=False).returncode==0
        assert not set(names).intersection(row['name'] for row in appctl.call('/apps'))
        for name in names:
            assert docker('volume','inspect','appbase-data-'+name,check=False).returncode!=0
        gateway_id=docker('compose','ps','-q','gateway').stdout.strip()
        gateway=docker('inspect','--format','{{.Name}}',gateway_id).stdout.strip().lstrip('/')
        docker('build','-t',image,temp)
        built=True
        for name in names:
            appctl.call('/apps/publish',{'name':name,'image':image})
            created.append(name)
        before=appctl.call('/apps')
        assert sum(row['name'] in names and not row['running'] for row in before)==24
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            cold=list(pool.map(sample,names[:3]))
        containers=[]
        for name in names[:3]:
            found=docker('ps','--filter','label=appbase.name='+name,'--format','{{.Names}}').stdout.splitlines()
            assert len(found)==1
            containers+=found
        docker('stop',containers[0])
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            same_app=list(pool.map(lambda _:sample(names[0]),range(3)))
        direct_script='''import http.client,json,time,sys
out={}
for name in sys.argv[1:]:
 a=[]
 for i in range(10):
  t=time.monotonic(); c=http.client.HTTPConnection(name,8000,timeout=10); c.request("GET","/"); r=c.getresponse(); r.read(); a.append(round((time.monotonic()-t)*1000,2)); c.close()
 out[name]=a
print(json.dumps(out))'''
        direct=json.loads(docker('exec',gateway,'python','-c',direct_script,*containers).stdout)
        waves=[]
        for i in range(3):
            before=[sample(names[k%3]) for k in range(9)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=9) as pool:
                held=list(pool.map(lambda k:sample(names[k%3],'hold'),range(9)))
            after=[sample(names[k%3]) for k in range(12)]
            state=resources(gateway,containers)
            waves.append({'wave':i+1,'before':before,'held':held,'after':after,'resources':state})
            if time.monotonic()-started>120:
                raise RuntimeError('observed elapsed threshold exceeded')
        print(json.dumps({'limits':{'registered_cold':24,'max_active_test_apps':3,'concurrent_requests':9,
                                    'observed_memory_threshold_mib':{'gateway':128,'per_app':64},'observed_seconds':120},
                          'cold':cold,'same_app_cold':same_app,'direct_ms':direct,'waves':waves,
                          'elapsed_ms':round((time.monotonic()-started)*1000,2)},indent=2))
    finally:
        errors=[]
        for name in reversed(created):
            try:
                appctl.call('/apps/remove',{'name':name})
            except Exception as exc:
                errors.append('remove '+name+': '+str(exc))
                continue
            removed=docker('volume','rm','appbase-data-'+name,check=False)
            if removed.returncode and 'No such volume' not in removed.stderr:
                errors.append('volume '+name+': '+removed.stderr)
        if built:
            removed=docker('image','rm',image,check=False)
            if removed.returncode:
                errors.append('image: '+removed.stderr)
        if errors:
            raise RuntimeError('; '.join(errors))
