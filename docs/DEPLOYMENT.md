# Deploying First Mic on DigitalOcean

First Mic runs as two Docker containers on one small Droplet, set up the same way as LessonHub:

- `firstmic`: the Node server with ffmpeg, plus the built web app. Its data (SQLite database and MP3s) lives on the
  Docker volume `firstmic_data`.
- `cloudflared`: a Cloudflare Tunnel. It connects out to Cloudflare, which serves `https://<domain>` and forwards it
  to `firstmic`. The Droplet opens no web ports and needs no certificate.

Browsers only allow the microphone on HTTPS pages; Cloudflare provides the HTTPS.

Every push to `main` runs **Publish and deploy** (`.github/workflows/deploy.yml`): CI, then the image is built and
published to `ghcr.io/raghadalsaka/firstmic:<commit sha>`, then the workflow logs in to the Droplet over SSH and
runs `deploy/scripts/deploy.sh`, which pulls that image and restarts the stack from `deploy/compose.production.yml`.
Nothing is built on the Droplet.

Do steps 1 to 5 once, in order, before the first push.

## 1. Droplet (as root, once)

A **Basic, 512 MB / 1 vCPU / 10 GB** Droplet is enough for a class (each 3-minute MP3 is about 3 MB). Use your SSH
key when creating it. Then:

```bash
ssh root@<droplet-ip>

# Docker, if the Droplet isn't the "Docker on Ubuntu" image (docker compose must be 2.24 or newer)
docker compose version || curl -fsSL https://get.docker.com | sh
apt-get install -y curl

# swap: the containers are memory-limited, but ffmpeg spikes must not get the server killed
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# firewall: only SSH inbound; the tunnel needs outbound 443 only
ufw allow OpenSSH && ufw --force enable

# deploy user: GitHub Actions logs in as this user and runs docker
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
install -d -o deploy -g deploy -m 750 /opt/firstmic /opt/firstmic/bin
```

If you use a DigitalOcean cloud firewall instead of (or as well as) `ufw`, allow only inbound TCP 22.

## 2. Deploy key and host key

On your own computer, make a key pair just for GitHub Actions. It must have **no passphrase**:

```bash
ssh-keygen -t ed25519 -N "" -C "firstmic-github-deploy" -f ~/.ssh/firstmic_github_deploy
```

Put the public half on the Droplet:

```bash
cat ~/.ssh/firstmic_github_deploy.pub | ssh root@<droplet-ip> \
  "cat >> /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys"
ssh -i ~/.ssh/firstmic_github_deploy deploy@<droplet-ip> docker ps    # must work without a password
```

Read the Droplet's host key (for `DEPLOY_HOST_KEY`), and check it against the Droplet itself:

```bash
ssh-keyscan -t ed25519 <droplet-ip> 2>/dev/null | cut -d' ' -f2-              # the DEPLOY_HOST_KEY value
ssh-keyscan -t ed25519 <droplet-ip> 2>/dev/null | ssh-keygen -lf -            # its fingerprint...
ssh root@<droplet-ip> ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub       # ...must match this one
```

## 3. Cloudflare Tunnel

The domain's DNS must be on Cloudflare.

1. Cloudflare **Zero Trust → Networks → Tunnels → Create a tunnel**, connector **Cloudflared**, name `firstmic-prod`.
2. Copy the **token** from the install command shown (the long string after `--token`). It goes in the Droplet's
   `.env` in step 5. Don't run the install command; the `cloudflared` container uses the token.
3. **Public hostname**: subdomain `firstmic`, domain `raghadalsaka.com`, service type **HTTP**, URL `firstmic:4100`.
   Cloudflare creates the DNS record. Delete any older `A` record for the same name first.

The live call's signalling (`/ws`) is a WebSocket, which tunnels support. The call's audio goes straight between the
two phones, not through the tunnel. Phones that can't reach each other directly need a TURN relay (`ICE_SERVERS`).

## 4. GitHub (repository settings)

1. **Settings → Environments → New environment** `production`. Under **Deployment branches**, allow only `main`.
2. In that environment, add these **secrets**:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | the Droplet's IPv4 address |
   | `DEPLOY_PORT` | `22` (or leave it out) |
   | `DEPLOY_USER` | `deploy` |
   | `DEPLOY_SSH_KEY` | the whole private key file `~/.ssh/firstmic_github_deploy` |
   | `DEPLOY_HOST_KEY` | the `ssh-ed25519 AAAA…` line from step 2 (no host name in front) |

3. **Settings → Secrets and variables → Actions → Variables** (repository, not environment): add
   `VITE_GOOGLE_CLIENT_ID` (step 6). It is built into the web app. It isn't a secret.
4. Workflow permissions can stay "Read repository contents"; the workflow asks for `packages: write` itself.

## 5. Settings on the Droplet

```bash
ssh root@<droplet-ip>
curl -fsSL https://raw.githubusercontent.com/raghadalsaka/firstmic/main/deploy/.env.production.example -o /opt/firstmic/.env
chown deploy:deploy /opt/firstmic/.env && chmod 600 /opt/firstmic/.env
nano /opt/firstmic/.env     # CLOUDFLARE_TUNNEL_TOKEN (step 3) and VITE_GOOGLE_CLIENT_ID (step 6)
```

The workflows never read, copy or print this file.

## 6. Google sign-in for teachers

First Mic uses QuestRush's Google sign-in: the same OAuth client and the same `VITE_GOOGLE_CLIENT_ID` value.

1. Copy the value from QuestRush's `.env` (or its `QUESTRUSH_GOOGLE_CLIENT_ID` repository variable) into the GitHub
   variable `VITE_GOOGLE_CLIENT_ID` (step 4) and the Droplet's `.env` (step 5).
2. In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**, open QuestRush's
   OAuth client and add First Mic under **Authorized JavaScript origins**:
   - `https://<your domain>`
   - for local testing: `http://localhost:18100` (Docker) and `http://localhost:4110` (`pnpm dev`)
3. Check **OAuth consent screen**: it must be published (**In production**) for any Google account to sign in. In
   **Testing** mode only the listed test users can. First Mic asks only for the basic profile (name and email).

## 7. First deployment

1. Push to `main` (or run **Actions → Publish and deploy → Run workflow**). Watch the run.
2. The first image is published as a **private** GHCR package, so the Droplet's `docker pull` can fail with
   "denied". Either:
   - make it public: GitHub → your profile → **Packages → firstmic → Package settings → Change visibility → Public**
     (the image holds nothing secret: the code is public and the Google client ID isn't a secret), then **Re-run
     failed jobs**; or
   - log the Droplet in: as `deploy`, `docker login ghcr.io -u raghadalsaka` with a classic PAT that has only
     `read:packages`, then re-run. Note the PAT's expiry.
3. Check on the Droplet:

   ```bash
   cd /opt/firstmic && docker compose --env-file .env --env-file images.env -f compose.yml ps
   ```

   `firstmic` is `healthy`, `cloudflared` is running, and its log has "Registered tunnel connection".
4. `curl -fsS https://<domain>/api/health` answers `{"ok":true,…}`.

To redeploy or roll back, run **Publish and deploy** manually with a commit SHA that was already published.

## Sign in and create a class

1. Open `https://<your domain>` and click **Sign In** (top right), then pick your Google account.
2. Create a class and add topics. The class appears on the home page, where students tap it.
   **Copy Link** gives a direct link too.

Any Google account can sign in and create classes. Every class is listed on the home page, so anyone with the site
address can open a class and send a recording. Only the teachers of that class can listen to or download recordings.

## Everyday operations

On the Droplet, in `/opt/firstmic`, every compose command passes both env files:
`dc="docker compose --env-file .env --env-file images.env -f compose.yml"`.

| Task | Command |
|---|---|
| See logs | `$dc logs -f firstmic` |
| Restart | `$dc restart firstmic` |
| Update to a new version | push to `main` |
| Roll back | **Publish and deploy** with the previous SHA (`FIRSTMIC_PREVIOUS_TAG` in `images.env`) |
| Change a setting | edit `.env`, then `$dc up -d firstmic` |
| Back up recordings + database | `docker run --rm -v firstmic_data:/data -v "$PWD":/backup busybox tar czf /backup/firstmic-$(date +%F).tgz -C /data .` |

A backup on the Droplet isn't off-site: copy the `.tgz` somewhere else, or turn on DigitalOcean's Droplet backups.

## Configuration

Set these in `/opt/firstmic/.env`; `compose.yml` passes them to the container.

| Variable | Purpose | Default |
|---|---|---|
| `CLOUDFLARE_TUNNEL_TOKEN` | The tunnel's token (step 3) | required |
| `VITE_GOOGLE_CLIENT_ID` | QuestRush's Google OAuth client ID; the server checks sign-ins with it. The web app gets it at build time from the GitHub variable of the same name | required |
| `FIRSTMIC_MAX_SECONDS` | Recording limit; the student's recorder stops here and the server trims to it | `180` |
| `LOG_LEVEL` | `info`, `warn`, `error`, … | `info` |
| `FIRSTMIC_GROUP_UPLOAD_MINUTES` | After a two-person take stops, how long to wait for both voices | `5` |
| `ICE_SERVERS` | Live-call STUN/TURN servers as JSON (a TURN relay helps on strict networks) | Google STUN |
| `PIN_MAX_ATTEMPTS` / `PIN_LOCK_MINUTES` | Wrong PINs before a student is locked out, and for how long | `5` / `15` |
| `PIN_ATTEMPTS_PER_MINUTE_PER_IP` | PIN sign-ins and group joins per minute; behind the tunnel this counts the whole site | `30` |

## Checklist after deploying

- [ ] `https://<domain>` loads (Cloudflare's certificate).
- [ ] **Sign In** opens Google's account picker, and after picking an account you land on "Your classes".
- [ ] A class you create shows up on the home page.
- [ ] A phone on mobile data (not the school Wi-Fi) can open the class link, record, listen, and send.
- [ ] The recording appears in the teacher dashboard, plays, and downloads as an MP3.
- [ ] Two phones can record a two-person podcast (live call connects through the tunnel's `/ws`).
- [ ] `$dc restart firstmic`, then the recording still plays (data is on the volume).

The full manual test is in [TESTING.md](TESTING.md).

## Without Cloudflare: Caddy on its own server

`docker-compose.yml` in the repository root is the self-contained alternative: it builds the image on the server and
puts Caddy (automatic Let's Encrypt HTTPS) in front, so it needs ports 80 and 443 open, an `A` record set to **DNS
only**, and at least 1 GB of RAM plus swap for the build. Set `FIRSTMIC_DOMAIN` and `VITE_GOOGLE_CLIENT_ID` in `.env`
(see `.env.example`), then run `docker compose up -d --build`.
