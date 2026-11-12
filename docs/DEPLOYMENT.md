# Deploying First Mic on DigitalOcean

First Mic runs as two Docker containers on one Droplet:

- `firstmic`: the Node server with ffmpeg, plus the built web app. Its data (SQLite database and MP3s) lives on a
  Docker volume.
- `caddy`: HTTPS with an automatic Let's Encrypt certificate, in front of `firstmic`.

Browsers only allow the microphone on HTTPS pages, so a domain with HTTPS is required.

## 1. Create the Droplet

1. In DigitalOcean choose **Create → Droplets**, then **Marketplace → Docker on Ubuntu**.
2. A **Basic, 1 GB RAM / 1 vCPU** Droplet is enough for a class. Each 3-minute MP3 is about 3 MB.
3. Add your SSH key, then create the Droplet and note its IPv4 address.
4. Optional: under **Backups**, enable weekly backups. They cover the Docker volume with the recordings.

## 2. Point a domain at it

Create a DNS **A record**, for example `firstmic.yourschool.org`, pointing at the Droplet's IPv4 address. If your DNS is
on Cloudflare, set it to **DNS only** (grey cloud) so Caddy can get its certificate.

## 3. Open the firewall

Under **Networking → Firewalls**, allow inbound TCP 22 (SSH), TCP 80 and TCP 443, plus UDP 443 for HTTP/3. Attach the
firewall to the Droplet.

Two-person podcasts don't need more ports: the live call's signalling goes through Caddy on 443 (`/ws`), and the
audio goes straight between the two phones. Phones that can't reach each other directly need a TURN relay (see
`ICE_SERVERS` in `.env.example`); First Mic doesn't run one.

## 4. Install and start

```bash
ssh root@<droplet-ip>
git clone <your First Mic repository URL> /opt/firstmic
cd /opt/firstmic
cp .env.example .env
nano .env        # set FIRSTMIC_DOMAIN and VITE_GOOGLE_CLIENT_ID (step 5)
docker compose up -d --build
docker compose logs -f firstmic   # wait for "Server listening", then Ctrl+C
```

Open `https://<your domain>`. The certificate is issued on the first visit, which can take up to a minute.

## 5. Set up Google sign-in for teachers

First Mic uses QuestRush's Google sign-in: the same OAuth client and the same `VITE_GOOGLE_CLIENT_ID` value.

1. Copy the `VITE_GOOGLE_CLIENT_ID=...` line from QuestRush's `.env` (or the value of QuestRush's
   `QUESTRUSH_GOOGLE_CLIENT_ID` repository variable) into First Mic's `.env`.
2. In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**, open QuestRush's
   OAuth client and add First Mic under **Authorized JavaScript origins**:
   - `https://<your domain>`
   - for local testing: `http://localhost:18100` (Docker) and `http://localhost:4110` (`pnpm dev`)
3. Check **OAuth consent screen**: it must be published (**In production**) for any Google account to sign in. In
   **Testing** mode only the listed test users can. First Mic asks only for the basic profile (name and email).
4. Rebuild so the web app picks up the client ID: `docker compose up -d --build`.

## 6. Sign in and create a class

1. Open `https://<your domain>` and click **Sign In** (top right), then pick your Google account.
2. Create a class and add topics. The class appears on the home page, where students tap it.
   **Copy Link** gives a direct link too.

Any Google account can sign in and create classes. Every class is listed on the home page, so anyone with the site
address can open a class and send a recording. Only the teachers of that class can listen to or download recordings.

## Everyday operations

| Task | Command (in `/opt/firstmic`) |
|---|---|
| See logs | `docker compose logs -f firstmic` |
| Restart | `docker compose restart firstmic` |
| Update to a new version | `git pull && docker compose up -d --build` |
| Back up recordings + database | `docker run --rm -v firstmic_firstmic-data:/data -v "$PWD":/backup busybox tar czf /backup/firstmic-$(date +%F).tgz -C /data .` |
| Free disk space | `docker image prune -f` |

The volume is named `firstmic_firstmic-data` when the folder is `/opt/firstmic`. `docker volume ls` shows the
exact name.

## Configuration

Set these in `.env`; `docker compose` passes them to the container.

| Variable | Purpose | Default |
|---|---|---|
| `FIRSTMIC_DOMAIN` | Domain Caddy serves and gets a certificate for | required |
| `VITE_GOOGLE_CLIENT_ID` | QuestRush's Google OAuth client ID for teacher sign-in (step 5); built into the web app, so change it with `--build` | required |
| `FIRSTMIC_MAX_SECONDS` | Recording limit; the student's recorder stops here and the server trims to it | `180` |
| `LOG_LEVEL` | `info`, `warn`, `error`, … | `info` |

## Checklist after deploying

- [ ] `https://<domain>` loads with a valid certificate.
- [ ] **Sign In** opens Google's account picker, and after picking an account you land on "Your classes".
- [ ] A class you create shows up on the home page.
- [ ] A phone on mobile data (not the school Wi-Fi) can open the class link, record, listen, and send.
- [ ] The recording appears in the teacher dashboard, plays, and downloads as an MP3.
- [ ] `docker compose restart firstmic`, then the recording still plays (data is on the volume).

The full manual test is in [TESTING.md](TESTING.md).
