"""Destructive only to resources created by this test. Requires a running local gateway."""
import concurrent.futures
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:10]
app = 'verify' + suffix
project = 'appbaseverify' + suffix
host = 'pgverify' + suffix
password = 'disposable-test-only'
volume = 'appbase-data-' + app
next_image = 'appbase-verify:' + suffix
url = 'http://127.0.0.1:8080/apps/' + app + '/records/notes/item'


def docker(*args, check=True, **kwargs):
    return subprocess.run(['docker', *args], check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)


def request(method, target, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(target, data=body, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=35) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def wait_http(target):
    deadline = time.monotonic() + 30
    while True:
        try:
            return request('GET', target)
        except (OSError, urllib.error.URLError):
            if time.monotonic() > deadline:
                raise
            time.sleep(.25)


def expect(status, operation):
    actual, body = operation
    assert actual == status, (actual, body, status)
    return body


def publish(env=None, image='appbase-counter:local'):
    appctl.call('/apps/publish', {'name': app, 'image': image, 'env': env or {}})


with tempfile.TemporaryDirectory(prefix='appbase-test-') as temp:
    config = pathlib.Path(temp) / 'compose.yaml'
    # A test-only password is stored only in this temporary file, container and test volume.
    config.write_text('''services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: %s
    volumes:
      - data:/var/lib/postgresql/data
    networks:
      apps:
        aliases: [%s]
networks:
  apps:
    external: true
    name: appbase-local
volumes:
  data:
''' % (password, host))
    compose = ['compose', '-p', project, '-f', str(config)]
    published = False
    built_image = False
    try:
        assert docker('volume', 'inspect', volume, check=False).returncode != 0, 'test volume collision'
        assert all(x['name'] != app for x in appctl.call('/apps')), 'test app collision'
        with urllib.request.urlopen('http://127.0.0.1:8081/', timeout=5) as response:
            assert b'Local application administration' in response.read()
        (pathlib.Path(temp) / 'Dockerfile').write_text('FROM appbase-counter:local\nENV APP_RELEASE=smoke-v2\n')
        docker('build', '-t', next_image, temp)
        built_image = True
        docker(*compose, 'up', '-d')
        deadline = time.monotonic() + 45
        while docker(*compose, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError('test postgres did not become ready')
            time.sleep(.5)
        publish()
        published = True
        # Only the test app's newly created volume gets this disposable pgpass file.
        docker('run', '--rm', '--network', 'none', '-e', 'PGPASS_LINE=' + host + ':5432:postgres:postgres:' + password, '-v', volume + ':/data', '--entrypoint', 'sh', 'python:3.12.12-slim', '-c', 'umask 077; printf "%s\\n" "$PGPASS_LINE" > /data/.pgpass')
        expect(201, request('POST', url, {'value': {'backend': 'sqlite'}}))
        expect(409, request('POST', url, {'value': {'backend': 'duplicate'}}))
        expect(200, request('PUT', url, {'value': {'backend': 'sqlite-v2'}, 'revision': 1}))
        expect(409, request('PUT', url, {'value': {'backend': 'retry'}, 'revision': 1}))
        publish(image=next_image)
        assert expect(200, wait_http(url))['value']['backend'] == 'sqlite-v2'
        with urllib.request.urlopen('http://127.0.0.1:8080/apps/' + app + '/', timeout=30) as response:
            assert 'Version: smoke-v2.' in response.read().decode()
        assert next(item['image'] for item in appctl.call('/apps') if item['name'] == app) == next_image
        pg = {'DB_BACKEND': 'postgres', 'PGHOST': host, 'PGPORT': '5432', 'PGDATABASE': 'postgres', 'PGUSER': 'postgres'}
        publish(pg)
        expect(404, wait_http(url))
        expect(201, request('POST', url, {'value': {'backend': 'postgres'}}))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(lambda n: request('PUT', url, {'value': {'writer': n}, 'revision': 1})[0], range(12)))
        assert statuses.count(200) == 1 and statuses.count(409) == 11, statuses
        docker(*compose, 'restart', 'postgres')
        deadline = time.monotonic() + 45
        while docker(*compose, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError('test postgres did not restart')
            time.sleep(.5)
        assert expect(200, wait_http(url))['revision'] == 2
        docker('compose', 'restart', 'gateway', cwd=str(ROOT))
        assert expect(200, wait_http(url))['revision'] == 2
        publish()
        assert expect(200, wait_http(url))['value']['backend'] == 'sqlite-v2'
        publish(pg)
        assert expect(200, wait_http(url))['revision'] == 2
        expect(409, request('DELETE', url, {'revision': 1}))
        expect(200, request('DELETE', url, {'revision': 2}))
        expect(409, request('DELETE', url, {'revision': 2}))
        expect(404, request('GET', url))
        expect(201, request('POST', url, {'value': {'backend': 'recreated'}}))
        assert expect(200, request('GET', url))['revision'] == 4
        expect(409, request('PUT', url, {'value': {'backend': 'stale'}, 'revision': 1}))
        print('PASS: dashboard, same URL, SQLite/PostgreSQL switch, independent persistence, concurrent CAS, retry, version publish, database and gateway restarts', flush=True)
    finally:
        errors = []
        if published:
            try:
                appctl.call('/apps/remove', {'name': app})
            except Exception as exc:
                errors.append('remove test app: ' + str(exc))
        result = docker(*compose, 'down', '-v', '--remove-orphans', check=False)
        if result.returncode:
            errors.append('remove test postgres resources: ' + result.stderr)
        if published:
            result = docker('volume', 'rm', volume, check=False)
            if result.returncode and 'No such volume' not in result.stderr:
                errors.append('remove test app volume: ' + result.stderr)
        if built_image:
            result = docker('image', 'rm', next_image, check=False)
            if result.returncode:
                errors.append('remove test image: ' + result.stderr)
        if errors:
            raise RuntimeError('; '.join(errors))
