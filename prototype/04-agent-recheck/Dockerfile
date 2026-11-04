FROM python:3.12.12-slim
WORKDIR /app
RUN pip install --no-cache-dir 'psycopg[binary]==3.2.13'
COPY app.py store.py records.py .
EXPOSE 8000
CMD ["python", "-u", "app.py"]
