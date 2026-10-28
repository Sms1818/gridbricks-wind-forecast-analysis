FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .

# Install backend dependencies before copying the application code.
RUN python -m pip install \
    --index-url https://mirrors.aliyun.com/pypi/simple/ \
    --retries 2 \
    --timeout 120 \
    -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
