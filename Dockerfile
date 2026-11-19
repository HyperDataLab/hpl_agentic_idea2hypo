# Engine image for the Cloudflare Container (worker/wrangler.toml, class EngineContainer).
# No secret is baked in: the Worker passes the keys as environment variables at start.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    I2H_CONFIG=/app/configs/cloudflare.yaml

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
COPY configs ./configs
RUN pip install --no-cache-dir ".[api]" \
    && useradd --create-home --uid 10001 engine \
    && mkdir -p /tmp/i2h && chown engine /tmp/i2h
USER engine

EXPOSE 8080
CMD ["python", "-m", "uvicorn", "idea2hypothesis.api.app:app", "--host", "0.0.0.0", "--port", "8080"]
