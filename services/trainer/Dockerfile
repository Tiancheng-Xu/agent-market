FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN useradd --create-home --uid 10001 trainer

COPY pyproject.toml ./
COPY src ./src
RUN python -m pip install --no-cache-dir .

USER trainer
ENTRYPOINT ["python", "-m", "agent_market_trainer.train"]
