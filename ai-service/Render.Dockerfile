FROM python:3.11.18-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_ENV=production

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 scholarship \
    && useradd --system --uid 10001 --gid scholarship --home-dir /app scholarship \
    && mkdir -p /data/db /data/uploads \
    && chown -R scholarship:scholarship /app /data

COPY requirements.txt ./requirements.txt
RUN python -m pip install -r requirements.txt

COPY --chown=scholarship:scholarship *.py ./
COPY render-entrypoint.sh /usr/local/bin/render-entrypoint
RUN chmod 755 /usr/local/bin/render-entrypoint

EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/render-entrypoint"]
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --proxy-headers"]
