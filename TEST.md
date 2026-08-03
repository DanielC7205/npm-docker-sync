# Testing NPM Docker Sync

This guide helps you test the npm-docker-sync service with a complete local stack.

## Quick Start

1. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Start the test stack:**
   ```bash
   docker-compose -f docker-compose.test.yml up --build
   ```

3. **Access NPMplus UI:**
   - URL: http://localhost:8981
   - Default credentials: `admin@example.org` / `changeme`
     (set via `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`, matching `NPM_EMAIL` / `NPM_PASSWORD`)

4. **If you change credentials in the UI**, update `.env` and restart sync:
   ```bash
   docker compose -f docker-compose.test.yml restart npm-docker-sync
   ```

## Test Services

The stack includes 4 test services to demonstrate different scenarios:

### 1. echo-service (Same Network - Auto-detected)
- **Domain**: echo.local.test
- **Network**: On `proxy` network with NPMplus
- **Expected**: `npm.proxy.host` auto-detected as `echo-service`
- **Test**: Should proxy to container via Docker DNS

### 2. echo-service-2 (Multiple Domains)
- **Domains**: echo2.local.test, www.echo2.local.test
- **Network**: On `proxy` network with NPMplus
- **Expected**: `npm.proxy.host` auto-detected as `echo-service-2`
- **Features**: Demonstrates multiple domain names

### 3. echo-external (Different Network - Docker Host IP)
- **Domain**: external.local.test
- **Network**: NOT on `proxy` network
- **Port**: Exposed on host as 5679
- **Expected**: `npm.proxy.host` auto-detected as Docker host IP (e.g., 172.17.0.1)
- **Test**: Should proxy to container via Docker host

### 4. echo-manual (Manual Override)
- **Domain**: manual.local.test
- **Network**: On `proxy` network with NPMplus
- **Expected**: Uses explicitly set `npm.proxy.host: echo-manual`
- **Features**: Demonstrates manual override

## Verifying It Works

### Check Logs

```bash
# Watch npm-docker-sync logs
docker-compose -f docker-compose.test.yml logs -f npm-docker-sync

# Look for messages like:
# - "Network detection initialized"
# - "Container shares network(s) with NPM"
# - "Processing container ... with domains: ..."
# - "Created proxy host X for container Y"
```

### Check NPMplus UI

1. Go to http://localhost:8981
2. Log in with `admin@example.org` / `changeme` (or your `NPM_EMAIL` / `NPM_PASSWORD`)
3. Navigate to "Proxy Hosts"
4. You should see proxy hosts created for the labeled echo services:
   - echo.local.test → echo-service:5678
   - echo2.local.test, www.echo2.local.test → echo-service-2:5678
   - mbtest.jjagd.net → [Docker Host IP]:5679
   - manual.local.test → echo-manual:5678

5. Check metadata in each proxy host (if the UI shows it):
   - `managed_by: npm-docker-sync`
   - `container_id: <container_id>`
   - `created_at: <timestamp>`

### Test Proxying (requires /etc/hosts setup)

Add to `/etc/hosts`:
```
127.0.0.1 echo.local.test
127.0.0.1 echo2.local.test
127.0.0.1 www.echo2.local.test
127.0.0.1 external.local.test
127.0.0.1 manual.local.test
```

Then test:
```bash
curl http://echo.local.test
# Should return: Hello from echo-service on port 5678!

curl http://echo2.local.test
# Should return: Hello from echo-service-2! This one wants SSL.

curl http://external.local.test
# Should return: Hello from echo-external! I'm on a different network.

curl http://manual.local.test
# Should return: Hello from echo-manual with explicit host!
```

## Testing Label Changes

### Test 1: Update Labels on Running Container

```bash
# Update a label (requires docker CLI manipulation or restart)
docker-compose -f docker-compose.test.yml stop echo-service
docker-compose -f docker-compose.test.yml up -d echo-service

# Watch logs - should detect change and update proxy host
```

### Test 2: Remove Labels

Edit `docker-compose.test.yml` and remove all `npm.*` labels from `echo-service`, then:

```bash
docker-compose -f docker-compose.test.yml up -d echo-service

# Watch logs - should detect removal and delete proxy host
# Check NPM UI - echo.local.test proxy should be removed
```

### Test 3: Add New Container with Labels

```bash
# Add a new service to docker-compose.test.yml with npm.* labels
# Run: docker-compose -f docker-compose.test.yml up -d [service-name]
# Watch logs - should detect new container and create proxy host
```

## Cleanup

```bash
# Stop all services
docker-compose -f docker-compose.test.yml down

# Remove volumes (clears NPMplus database — needed if admin credentials were changed)
docker compose -f docker-compose.test.yml down -v
```

## Troubleshooting

### NPM / NPMplus Authentication Fails
- Check NPMplus is running: `docker ps | grep npmplus`
- Verify credentials in .env match NPMplus login (defaults: `admin@example.org` / `changeme`)
- Check NPMplus logs: `docker logs npmplus`
- UI is on host port `8981` when using `docker-compose.test.yml`

### Auto-detection Not Working / Docker socket Permission denied
- Verify `NPM_CONTAINER_NAME=npmplus` matches actual container name
- On **Podman Desktop (macOS)**, `/var/run/docker.sock` is a host symlink and fails inside containers.
  Set in `.env`:
  ```bash
  DOCKER_SOCKET=$HOME/.local/share/containers/podman/machine/podman.sock
  ```
  then recreate: `docker compose -f docker-compose.test.yml up --build`
- Check logs for "Network detection initialized"
- Verify npm-docker-sync can access the Docker/Podman socket

### Proxies Not Created
- Check container has `npm.proxy.domains` and `npm.proxy.port` labels
- Verify npm-docker-sync is running: `docker ps | grep npm-docker-sync`
- Check for errors in logs: `docker logs npm-docker-sync`

### Can't Reach Services via Domain
- Ensure /etc/hosts entries added
- Verify proxy host exists in NPMplus UI (http://localhost:8981)
- Check NPMplus logs for routing errors: `docker logs npmplus`
- Test direct access to echo services first (e.g., `curl http://localhost:5679`)
