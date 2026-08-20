FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY services/performance-aggregator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/performance-aggregator/worker.py .
COPY services/performance-aggregator/migrate.py .
COPY database/migrations ./migrations

USER 65532:65532

CMD ["python", "worker.py"]
