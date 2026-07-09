# Containerized test runner for the pure Logic.gs module.
# Google Apps Script server code cannot execute here; only framework-free
# logic is unit-tested.
FROM node:20-alpine

WORKDIR /app

# Copy manifest first for layer caching.
COPY tests/package.json ./tests/package.json

# No third-party deps — node --test is built in.
COPY Logic.gs ./Logic.gs
COPY tests ./tests

WORKDIR /app/tests

CMD ["node", "--test"]
