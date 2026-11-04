# Only for the isolated smoke test; no ports or credentials are published.
FROM postgres:16
COPY --from=appbase-counter:local /usr/local /usr/local
COPY templates/counter /app
COPY tests/postgres/smoke.py /tmp/smoke.py
COPY prototype/02-storage/business_probe.py prototype/02-storage/order_service.py prototype/02-storage/order_probe.py /app/
USER postgres
CMD ["python", "/tmp/smoke.py"]
