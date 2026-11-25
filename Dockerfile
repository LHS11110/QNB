FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY qnb ./qnb
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
ENV QNB_DATABASE=/data/qnb.sqlite3 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["gunicorn", "--bind=0.0.0.0:8080", "--workers=1", "--threads=12", "--timeout=280", "qnb.app:app"]
