FROM python:3.12-slim
RUN pip install --no-cache-dir 'psycopg[binary]>=3.2,<4' && useradd --system --uid 10001 app
# A fresh volume takes the ownership of the directory it mounts over, so the non-root user can write /data and the SQLite directory.
RUN mkdir -p /data /pneuma/db && chown app /data /pneuma/db
WORKDIR /app
COPY app.py .
USER app
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "app.py"]
