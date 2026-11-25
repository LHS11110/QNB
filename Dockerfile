FROM node:22-slim AS terminal-assets
WORKDIR /assets
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts

FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY qnb ./qnb
COPY --from=terminal-assets /assets/node_modules/@xterm/xterm/lib/xterm.js /app/qnb/static/vendor/xterm.js
COPY --from=terminal-assets /assets/node_modules/@xterm/xterm/css/xterm.css /app/qnb/static/vendor/xterm.css
COPY --from=terminal-assets /assets/node_modules/@xterm/addon-fit/lib/addon-fit.js /app/qnb/static/vendor/addon-fit.js
COPY --from=terminal-assets /assets/node_modules/@xterm/xterm/LICENSE /app/qnb/static/vendor/xterm.LICENSE
COPY --from=terminal-assets /assets/node_modules/@xterm/addon-fit/LICENSE /app/qnb/static/vendor/addon-fit.LICENSE
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
ENV QNB_DATABASE=/data/qnb.sqlite3 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["gunicorn", "--bind=0.0.0.0:8080", "--workers=1", "--threads=80", "--timeout=280", "qnb.app:app"]
