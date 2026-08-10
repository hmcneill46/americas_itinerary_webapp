FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py trip_schema.py ./
COPY static/ ./static/
COPY data/itinerary.example.json ./data/itinerary.example.json
RUN mkdir -p /app/data/backups
ENV ITINERARY_HOST=0.0.0.0 ITINERARY_PORT=8765 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8765
CMD ["python", "app.py"]
