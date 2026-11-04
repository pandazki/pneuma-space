"""Isolated Docker gateway smoke test; owns and removes only uniquely named resources."""
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
TRACE = Path(os.environ.get("APPBASE_AGENT_TRACE", Path(__file__).with_name("TRACE.md")))
suffix = uuid.uuid4().hex[:16]
name = "taskcheck" + suffix
network = name + "-net"
gateway = name + "-gateway"
gateway_volume = name + "-gateway-data"
app_volume = "appbase-data-" + name
app_image = name + ":local"
gateway_image = name + "-gateway:local"
created = {"network": False, "gateway_volume": False, "gateway": False, "app_image": False, "gateway_image": False, "publish_attempted": False}
cleanup_errors = []


def log(message):
    print(message, flush=True)
    with TRACE.open("a", encoding="utf-8") as f:
        f.write(message + "\n")


def command(args, check=True):
    log("\n$ " + " ".join(args))
    p = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log(p.stdout.rstrip() + "\n[exit " + str(p.returncode) + "]")
    if check and p.returncode:
        raise RuntimeError("command failed: " + " ".join(args))
    return p


def request(port, method, path, data=None, admin=False):
    headers = {"Host": "127.0.0.1:8081"} if admin else {}
    body = None
    if data is not None:
        if admin:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        else:
            body = urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=35)
    try:
        conn.request(method, path, body, headers)
        response = conn.getresponse()
        result = (response.status, dict(response.getheaders()), response.read().decode())
    finally:
        conn.close()
    log("HTTP " + method + " " + path + " -> " + str(result[0]) + " " + result[2][:500])
    return result


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    log("PASS: " + message)


def cleanup(label, args):
    p = command(args, check=False)
    if p.returncode:
        cleanup_errors.append(label)


log("\n## 经授权的隔离 Docker smoke test\n\n资源后缀：" + suffix)
failed = False
try:
    # Ensure a collision cannot cause a pre-existing resource to be removed.
    for kind, resource in (("network", network), ("volume", gateway_volume), ("volume", app_volume),
                           ("container", gateway), ("image", app_image), ("image", gateway_image)):
        p = command(["docker", kind, "inspect", resource], check=False)
        if p.returncode == 0:
            raise RuntimeError("refusing pre-existing " + kind + " " + resource)
        if not any(x in p.stdout.lower() for x in ("no such", "not found")):
            raise RuntimeError("could not establish absence of " + kind + " " + resource)
    p = command(["docker", "ps", "-a", "--filter", "label=appbase.name=" + name, "--format", "{{.ID}}"])
    check(not p.stdout.strip(), "no existing app containers with the test label")
    command(["docker", "network", "create", network]); created["network"] = True
    command(["docker", "volume", "create", gateway_volume]); created["gateway_volume"] = True
    created["app_image"] = True
    command(["docker", "build", "-t", app_image, "./prototype/04-agent-recheck"])
    created["gateway_image"] = True
    command(["docker", "build", "-t", gateway_image, "./gateway"])
    created["gateway"] = True
    command(["docker", "run", "-d", "--name", gateway, "--network", network,
             "-e", "APP_NETWORK=" + network, "-e", "IDLE_SECONDS=2",
             "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081",
             "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", gateway_volume + ":/data", gateway_image])
    def port(container_port):
        out = command(["docker", "port", gateway, str(container_port) + "/tcp"]).stdout.strip()
        return int(out.rsplit(":", 1)[1])
    proxy_port, admin_port = port(8080), port(8081)
    for attempt in range(30):
        try:
            status, _, _ = request(admin_port, "GET", "/apps", admin=True)
            if status == 200:
                break
        except OSError:
            time.sleep(0.5)
    else:
        raise RuntimeError("gateway did not start")
    created["publish_attempted"] = True
    status, _, _ = request(admin_port, "POST", "/apps/publish", {"name": name, "image": app_image}, True)
    check(status == 200, "published the task app")
    base = "/apps/" + name
    status, _, page = request(proxy_port, "GET", base + "/")
    check(status == 200 and "Task list" in page, "app wakes through gateway")
    status, headers, _ = request(proxy_port, "POST", base + "/add", {"title": "Check persistent task"})
    check(status == 303 and headers.get("Location") == base + "/", "task added with prefix-aware redirect")
    status, _, page = request(proxy_port, "GET", base + "/")
    check(status == 200 and "Check persistent task" in page, "added task appears")
    match = re.search(r"name='key' value='([0-9a-f]{32})'.*?name='revision' value='(\d+)'", page)
    check(match is not None, "task form contains key and revision")
    status, _, _ = request(proxy_port, "POST", base + "/toggle", {"key": match.group(1), "revision": match.group(2)})
    check(status == 303, "task completed")
    status, _, page = request(proxy_port, "GET", base + "/")
    check(status == 200 and "Reopen" in page, "completion appears before idle stop")
    for attempt in range(20):
        time.sleep(1)
        status, _, body = request(admin_port, "GET", "/apps", admin=True)
        apps = json.loads(body)
        if status == 200 and len(apps) == 1 and not apps[0]["running"]:
            break
    else:
        raise AssertionError("app did not stop after idle timeout")
    check(True, "gateway stopped idle app")
    status, _, page = request(proxy_port, "GET", base + "/")
    check(status == 200 and "Check persistent task" in page and "Reopen" in page, "completed task survived stop and wake")
except Exception as exc:
    failed = True
    log("FAIL: " + repr(exc))
finally:
    log("\n### 清理本次创建的资源")
    if created["publish_attempted"]:
        try:
            status, _, _ = request(admin_port, "POST", "/apps/remove", {"name": name}, True)
            if status != 200:
                log("registration removal returned " + str(status) + "; checking test-label containers")
        except Exception as exc:
            log("registration removal failed: " + repr(exc))
        p = command(["docker", "ps", "-a", "--filter", "label=appbase.name=" + name, "--format", "{{.ID}}"], check=False)
        if p.returncode:
            cleanup_errors.append("list test app containers")
        else:
            for container in p.stdout.split():
                cleanup("app container " + container, ["docker", "rm", "-f", container])
    if created["gateway"]:
        cleanup("gateway container", ["docker", "rm", "-f", gateway])
    if created["publish_attempted"]:
        p = command(["docker", "volume", "inspect", app_volume], check=False)
        if p.returncode == 0:
            cleanup("app volume", ["docker", "volume", "rm", app_volume])
        elif not any(x in p.stdout.lower() for x in ("no such", "not found")):
            cleanup_errors.append("inspect app volume")
    if created["gateway_volume"]:
        cleanup("gateway volume", ["docker", "volume", "rm", gateway_volume])
    if created["network"]:
        cleanup("network", ["docker", "network", "rm", network])
    for flag, image in (("app_image", app_image), ("gateway_image", gateway_image)):
        if created[flag]:
            p = command(["docker", "image", "inspect", image], check=False)
            if p.returncode == 0:
                cleanup("image " + image, ["docker", "image", "rm", image])
            elif not any(x in p.stdout.lower() for x in ("no such", "not found")):
                cleanup_errors.append("inspect image " + image)
    log("Cleanup errors: " + (", ".join(cleanup_errors) if cleanup_errors else "none"))
    log("Smoke test result: " + ("FAILED" if failed or cleanup_errors else "PASSED"))
sys.exit(1 if failed or cleanup_errors else 0)
