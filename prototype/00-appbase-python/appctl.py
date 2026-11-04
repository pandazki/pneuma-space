#!/usr/bin/env python3
"""Local operator/agent CLI for the prototype gateway."""
import argparse
import json
import sys
import urllib.error
import urllib.request

URL = "http://127.0.0.1:8081"


def call(path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(URL + path, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode()) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError("gateway unavailable: %s" % exc.reason) from exc


def main():
    parser = argparse.ArgumentParser(description="Manage trusted local app images")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    publish = sub.add_parser("publish")
    publish.add_argument("name")
    publish.add_argument("image")
    publish.add_argument("--env", action="append", default=[], metavar="NAME=VALUE", help="non-secret database setting; repeat as needed")
    remove = sub.add_parser("remove")
    remove.add_argument("name")
    args = parser.parse_args()
    try:
        if args.command == "list":
            result = call("/apps")
        elif args.command == "publish":
            env = {}
            for item in args.env:
                if "=" not in item:
                    raise RuntimeError("--env needs NAME=VALUE")
                key, value = item.split("=", 1)
                env[key] = value
            result = call("/apps/publish", {"name": args.name, "image": args.image, "env": env})
        else:
            result = call("/apps/remove", {"name": args.name})
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
