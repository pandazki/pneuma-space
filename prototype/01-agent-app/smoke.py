"""Build and exercise the agent's app through the gateway using isolated test data."""
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import appctl

suffix = uuid.uuid4().hex[:10]
name = 'surveytest' + suffix
image = 'appbase-surveytest:' + suffix
volume = 'appbase-data-' + name
url = 'http://127.0.0.1:8080/apps/' + name


def docker(*args, check=True):
    return subprocess.run(['docker', *args], cwd=str(ROOT), check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(path, form=None):
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    try:
        with opener.open(urllib.request.Request(url + path, data=data), timeout=30) as response:
            return response.status, response.headers, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode()


published = built = False
try:
    assert all(item['name'] != name for item in appctl.call('/apps'))
    assert docker('volume', 'inspect', volume, check=False).returncode != 0
    docker('build', '-t', image, 'prototype/01-agent-app')
    built = True
    appctl.call('/apps/publish', {'name': name, 'image': image})
    published = True
    assert request('/')[0] == 200
    status, headers, _ = request('/create', {'title': 'Prototype survey', 'question': 'What next?'})
    assert status == 303
    path = headers['Location'].removeprefix('/apps/' + name)
    key = path.rsplit('/', 1)[-1]
    assert request(path)[0] == 200
    assert request('/answer/' + key, {'revision': '1', 'answer': 'Build an experiment'})[0] == 303
    status, _, body = request('/answer/' + key, {'revision': '1', 'answer': 'Stale response'})
    assert status == 409 and 'Your answer was not saved' in body
    print('Waiting for the test app to stop after the configured idle timeout...', flush=True)
    deadline = time.monotonic() + 90
    while True:
        item = next(item for item in appctl.call('/apps') if item['name'] == name)
        if not item['running']:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('test app did not stop within 90 seconds')
        time.sleep(3)
    status, _, body = request(path)
    assert status == 200 and 'Build an experiment' in body and 'Stale response' not in body
    print('PASS: questionnaire creation, answer, stale conflict, idle-stop wake and persisted answer')
finally:
    errors = []
    if published:
        try:
            appctl.call('/apps/remove', {'name': name})
        except Exception as exc:
            errors.append('remove test registration: ' + str(exc))
        else:
            result = docker('volume', 'rm', volume, check=False)
            if result.returncode and 'No such volume' not in result.stderr:
                errors.append('remove test volume: ' + result.stderr)
    if built:
        result = docker('image', 'rm', image, check=False)
        if result.returncode:
            errors.append('remove test image: ' + result.stderr)
    if errors:
        raise RuntimeError('; '.join(errors))
