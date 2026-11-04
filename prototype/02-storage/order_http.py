"""Minimal order API used only for the trusted prototype integration test."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from order_service import OrderService

path = os.path.join(os.environ.get('DATA_DIR', '/data'), 'orders.sqlite3')
os.makedirs(os.path.dirname(path), exist_ok=True)
service = OrderService(os.environ.get('DB_BACKEND', 'sqlite'), path)
service.setup()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlsplit(self.path)
        q = parse_qs(parsed.query)
        try:
            if parsed.path == '/stock':
                return self.reply(200, {'quantity': service.stock(q['sku'][0])})
            if parsed.path == '/orders':
                return self.reply(200, service.find_orders(q['sku'][0], int(q.get('minimum', ['1'])[0])))
            if parsed.path == '/sales':
                return self.reply(200, service.sales_by_category(q['category'][0], int(q.get('minimum', ['1'])[0])))
            return self.reply(404, {'error': 'not found'})
        except (KeyError, ValueError, TypeError) as exc:
            return self.reply(400, {'error': str(exc)})

    def do_POST(self):
        if self.headers.get_content_type() != 'application/json':
            return self.reply(415, {'error': 'application/json required'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError('invalid body size')
            body = json.loads(self.rfile.read(length))
            if self.path == '/stock':
                created = service.add_stock(body['sku'], body['category'], body['quantity'], body['price_cents'])
                return self.reply(201 if created else 409, {'created': created})
            if self.path == '/orders':
                result = service.purchase(body['order_id'], body['sku'], body['quantity'])
                return self.reply(201 if result == 'created' else 409, {'result': result})
            if self.path == '/cancel':
                result = service.cancel(body['order_id'])
                return self.reply(200 if result == 'cancelled' else 404, {'result': result})
            return self.reply(404, {'error': 'not found'})
        except (KeyError, TypeError, ValueError) as exc:
            return self.reply(400, {'error': str(exc)})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
