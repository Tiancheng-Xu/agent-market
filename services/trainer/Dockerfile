FROM python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8 AS dependencies

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.lock ./
COPY pyproject.toml ./
COPY src ./src
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
    && python -m pip install --no-cache-dir --no-deps --no-build-isolation .

FROM dependencies AS test
COPY requirements-test.lock ./
COPY tests ./tests
COPY fixtures ./fixtures
RUN python -m pip install --no-cache-dir --require-hashes -r requirements-test.lock \
    && PYTHONPATH=src pytest -q \
    && touch /tmp/trainer-tests-passed

FROM dependencies AS runtime
RUN useradd --create-home --uid 10001 trainer \
    && mkdir /data \
    && chown trainer:trainer /data
COPY --from=test /tmp/trainer-tests-passed /opt/trainer-tests-passed
USER trainer
WORKDIR /data
ENTRYPOINT ["python", "-m", "agent_market_trainer.train"]
