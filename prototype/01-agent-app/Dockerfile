FROM python:3.12.12-slim
WORKDIR /app
RUN pip install --no-cache-dir 'psycopg[binary]==3.2.13'
COPY app.py records.py store.py ./
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000
CMD ["python3", "app.py"]
