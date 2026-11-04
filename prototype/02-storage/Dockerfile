FROM python:3.12.12-slim
WORKDIR /app
RUN pip install --no-cache-dir 'psycopg[binary]==3.2.13'
COPY templates/counter/store.py templates/counter/relational.py ./
COPY prototype/02-storage/order_service.py prototype/02-storage/order_http.py ./
EXPOSE 8000
CMD ["python", "-u", "order_http.py"]
