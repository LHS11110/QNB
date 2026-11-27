FROM node:22-slim AS frontend-assets
WORKDIR /assets
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts
COPY frontend/editor.js frontend/graph.js frontend/crdt_daemon.cjs frontend/build.mjs ./
RUN mkdir -p /qnb/static/vendor && QNB_OUT_ROOT=/ node build.mjs

FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=frontend-assets /usr/local/bin/node /usr/local/bin/node
COPY qnb ./qnb
COPY --from=frontend-assets /qnb/static/vendor/editor.js /app/qnb/static/vendor/editor.js
COPY --from=frontend-assets /qnb/static/vendor/graph.js /app/qnb/static/vendor/graph.js
COPY --from=frontend-assets /qnb/static/vendor/katex /app/qnb/static/vendor/katex
COPY --from=frontend-assets /qnb/crdt_daemon.cjs /app/qnb/crdt_daemon.cjs
COPY --from=frontend-assets /assets/node_modules/@xterm/xterm/lib/xterm.js /app/qnb/static/vendor/xterm.js
COPY --from=frontend-assets /assets/node_modules/@xterm/xterm/css/xterm.css /app/qnb/static/vendor/xterm.css
COPY --from=frontend-assets /assets/node_modules/@xterm/addon-fit/lib/addon-fit.js /app/qnb/static/vendor/addon-fit.js
COPY --from=frontend-assets /assets/node_modules/@xterm/xterm/LICENSE /app/qnb/static/vendor/xterm.LICENSE
COPY --from=frontend-assets /assets/node_modules/@xterm/addon-fit/LICENSE /app/qnb/static/vendor/addon-fit.LICENSE
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
ENV QNB_DATABASE=/data/qnb.sqlite3 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["gunicorn", "--bind=0.0.0.0:8080", "--workers=1", "--threads=160", "--timeout=280", "qnb.app:app"]
