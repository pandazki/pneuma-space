"""Measure stopped-container DNS lookup and recovery for one temporary app."""
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
import appctl
suffix=uuid.uuid4().hex[:10]
name='dnscheck'+suffix
image='appbase-dnscheck:'+suffix
volume='appbase-data-'+name

def docker(*args,check=True):
    return subprocess.run(['docker',*args],cwd=str(ROOT),check=check,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

built=created=False
with tempfile.TemporaryDirectory(prefix='appbase-dns-') as temp:
    p=pathlib.Path(temp)
    (p/'Dockerfile').write_text('FROM python:3.12.12-slim\nCOPY app.py /app.py\nCMD ["python","-u","/app.py"]\n')
    (p/'app.py').write_text('''from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'ok')
ThreadingHTTPServer(('0.0.0.0',8000),H).serve_forever()
''')
    try:
        assert docker('image','inspect','python:3.12.12-slim',check=False).returncode==0
        assert docker('volume','inspect',volume,check=False).returncode!=0
        assert all(row['name']!=name for row in appctl.call('/apps'))
        gateway_id=docker('compose','ps','-q','gateway').stdout.strip()
        docker('build','-t',image,temp);built=True
        appctl.call('/apps/publish',{'name':name,'image':image});created=True
        url='http://127.0.0.1:8080/apps/'+name+'/'
        with urllib.request.urlopen(url,timeout=30) as r:
            assert r.read()==b'ok'
        app=docker('ps','--filter','label=appbase.name='+name,'--format','{{.Names}}').stdout.strip()
        assert app and '\n' not in app
        docker('stop',app)
        dns_script='''import json,socket,sys,time
start=time.monotonic()
try:
 socket.getaddrinfo(sys.argv[1],8000,type=socket.SOCK_STREAM); ok=True; error=None
except OSError as e:
 ok=False;error=type(e).__name__
print(json.dumps({"dns_ms":round((time.monotonic()-start)*1000,2),"resolved":ok,"error":error}))'''
        dns=json.loads(docker('exec',gateway_id,'python','-c',dns_script,app).stdout)
        start=time.monotonic()
        with urllib.request.urlopen(url,timeout=30) as r:
            assert r.read()==b'ok'
            timing=r.headers.get('X-Appbase-Timings')
        assert timing
        print(json.dumps({'stopped_dns':dns,'external_stop_recovery_ms':round((time.monotonic()-start)*1000,2),'gateway_timing':timing},indent=2))
    finally:
        errors=[]
        if created:
            try:appctl.call('/apps/remove',{'name':name})
            except Exception as e:errors.append('app '+str(e))
            else:
                r=docker('volume','rm',volume,check=False)
                if r.returncode and 'No such volume' not in r.stderr:errors.append('volume '+r.stderr)
        if built:
            r=docker('image','rm',image,check=False)
            if r.returncode:errors.append('image '+r.stderr)
        if errors:raise RuntimeError('; '.join(errors))
