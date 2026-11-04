"""Test the agent app with both databases via isolated Docker resources."""
import concurrent.futures
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:10]
name, host = 'surveypg' + suffix, 'pgsurvey' + suffix
project, image = 'appbasesurvey' + suffix, 'appbase-surveypg:' + suffix
volume = 'appbase-data-' + name
password = 'temporary-test-only'
url = 'http://127.0.0.1:8080/apps/' + name


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path, form=None):
    opener = urllib.request.build_opener(NoRedirect)
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    try:
        with opener.open(urllib.request.Request(url + path, data=data), timeout=30) as response:
            return response.status, response.headers, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode()


def publish(env=None):
    appctl.call('/apps/publish', {'name': name, 'image': image, 'env': env or {}})


def create(title):
    status, headers, _ = request('/create', {'title': title, 'question': 'What next?'})
    assert status == 303, status
    path = headers['Location'].removeprefix('/apps/' + name)
    assert request(path)[0] == 200
    return path


def check_parallel_answers(path, backend):
    key = path.rsplit('/', 1)[-1]
    def submit(index):
        return request('/answer/' + key, {'revision': '1', 'answer': backend + '-answer-' + str(index)})[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(submit, range(10)))
    assert statuses.count(303) == 1 and statuses.count(409) == 9, statuses
    status, _, page = request(path)
    assert status == 200 and 'Answers (1)' in page
    assert page.count(backend + '-answer-') == 1
    assert submit(0) == 409
    print(backend + ': 10 concurrent responses, one save, nine conflicts, repeat rejected', flush=True)


def wait_ready(compose):
    deadline = time.monotonic() + 45
    while docker(*compose, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', check=False).returncode:
        if time.monotonic() > deadline:
            raise RuntimeError('temporary PostgreSQL did not become ready')
        time.sleep(.5)


with tempfile.TemporaryDirectory(prefix='appbase-surveypg-') as temp:
    config = pathlib.Path(temp) / 'compose.yaml'
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
    published = built = False
    try:
        assert all(item['name'] != name for item in appctl.call('/apps'))
        assert docker('volume', 'inspect', volume, check=False).returncode != 0
        assert docker('image', 'inspect', 'python:3.12.12-slim', check=False).returncode == 0, 'cached Python base image required'
        assert docker('image', 'inspect', 'postgres:16-alpine', check=False).returncode == 0, 'cached postgres image required'
        docker('build', '-t', image, 'prototype/01-agent-app')
        built = True
        docker(*compose, 'up', '-d')
        wait_ready(compose)
        publish()
        published = True
        docker('run', '--rm', '--network', 'none', '-e', 'PGPASS_LINE=' + host + ':5432:postgres:postgres:' + password, '-v', volume + ':/data', '--entrypoint', 'sh', 'python:3.12.12-slim', '-c', 'umask 077; printf "%s\\n" "$PGPASS_LINE" > /data/.pgpass')
        sqlite_path = create('SQLite questionnaire')
        check_parallel_answers(sqlite_path, 'sqlite')
        pg = {'DB_BACKEND': 'postgres', 'PGHOST': host, 'PGPORT': '5432', 'PGDATABASE': 'postgres', 'PGUSER': 'postgres'}
        publish(pg)
        assert request(sqlite_path)[0] == 404, 'backend switch unexpectedly migrated data'
        postgres_path = create('PostgreSQL questionnaire')
        check_parallel_answers(postgres_path, 'postgres')
        docker(*compose, 'restart', 'postgres')
        wait_ready(compose)
        assert 'Answers (1)' in request(postgres_path)[2]
        # Restart only the newly created test app, leaving the shared gateway and unrelated apps alone.
        containers = docker('ps', '--filter', 'label=appbase.name=' + name, '--format', '{{.Names}}').stdout.splitlines()
        assert len(containers) == 1
        docker('restart', containers[0])
        assert 'Answers (1)' in request(postgres_path)[2]
        publish()
        assert 'Answers (1)' in request(sqlite_path)[2]
        assert request(postgres_path)[0] == 404
        publish(pg)
        assert 'Answers (1)' in request(postgres_path)[2]
        print('PASS: survey app image, real SQLite/PostgreSQL, independent data, database/app restart, back-and-forth config switching', flush=True)
    finally:
        errors = []
        if published:
            try:
                appctl.call('/apps/remove', {'name': name})
            except Exception as exc:
                errors.append('remove test registration: ' + str(exc))
        result = docker(*compose, 'down', '-v', '--remove-orphans', check=False)
        if result.returncode:
            errors.append('remove test postgres: ' + result.stderr)
        if published:
            result = docker('volume', 'rm', volume, check=False)
            if result.returncode and 'No such volume' not in result.stderr:
                errors.append('remove test volume: ' + result.stderr)
        if built:
            result = docker('image', 'rm', image, check=False)
            if result.returncode:
                errors.append('remove test image: ' + result.stderr)
        if errors:
            raise RuntimeError('; '.join(errors))
