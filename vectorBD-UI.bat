@echo off
setlocal

set "IMAGE_NAME=vector-db-ui"
set "CONTAINER_NAME=vectorBD-UI"
set "HOST_PORT=8787"

docker image inspect %IMAGE_NAME% >nul 2>&1
if errorlevel 1 (
  echo Docker image %IMAGE_NAME% was not found. Building it now...
  docker build -t %IMAGE_NAME% .
  if errorlevel 1 exit /b %errorlevel%
)

docker rm -f %CONTAINER_NAME% >nul 2>&1

set "DOCKER_ARGS=--rm -p %HOST_PORT%:8787 --name %CONTAINER_NAME%"

if defined QDRANT_API_KEY set "DOCKER_ARGS=%DOCKER_ARGS% -e QDRANT_API_KEY=%QDRANT_API_KEY%"
if defined WEAVIATE_API_KEY set "DOCKER_ARGS=%DOCKER_ARGS% -e WEAVIATE_API_KEY=%WEAVIATE_API_KEY%"
if defined VECTOR_UI_MAX_COLLECTIONS set "DOCKER_ARGS=%DOCKER_ARGS% -e VECTOR_UI_MAX_COLLECTIONS=%VECTOR_UI_MAX_COLLECTIONS%"
if defined VECTOR_UI_SAMPLE_PER_COLLECTION set "DOCKER_ARGS=%DOCKER_ARGS% -e VECTOR_UI_SAMPLE_PER_COLLECTION=%VECTOR_UI_SAMPLE_PER_COLLECTION%"

echo Starting %CONTAINER_NAME% on http://localhost:%HOST_PORT%
docker run %DOCKER_ARGS% %IMAGE_NAME%