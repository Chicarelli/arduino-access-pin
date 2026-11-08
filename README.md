# Gym access control: backend

An ESP32 at the gym door reads a PIN from a keypad and asks this server whether to unlock the door.
The stack is Fastify (plain JavaScript, ESM) and SQLite (better-sqlite3), on Node.js 20 or newer.

## Setup

```bash
npm install
cp .env.example .env        # then edit .env, see below
npm run seed                # creates 3 sample members
npm run dev                 # or: npm start
```

Generate a random value for each secret in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable      | Required | Default       | Meaning                                                            |
|---------------|----------|---------------|--------------------------------------------------------------------|
| `PORT`        | no       | `3000`        | TCP port. The server always binds `0.0.0.0` so the LAN can reach it. |
| `DEVICE_KEY`  | yes      |               | Shared secret the ESP32 sends in `X-Device-Key`.                   |
| `ADMIN_TOKEN` | yes      |               | Token for the admin API (`Authorization: Bearer ...`).             |
| `PIN_PEPPER`  | yes      |               | Secret key for `pin_hash = HMAC-SHA256(PIN_PEPPER, pin)`.          |
| `DB_PATH`     | no       | `data/gym.db` | SQLite file (relative to the project root).                        |
| `LOG_LEVEL`   | no       | `info`        | Pino log level.                                                    |

> **Do not change `PIN_PEPPER` once members exist.** Every stored PIN hash depends on it, so after a change
> no PIN will match and every member has to be given a new PIN.

On startup the server prints the addresses to point the ESP32 at:

```
Listening on http://192.168.0.10:3000
Local:        http://localhost:3000
```

`better-sqlite3` is a native module. `npm install` downloads a prebuilt binary for common platforms. If none
exists for yours, it compiles from source, which needs Python and a C++ toolchain (on Windows, the
"Desktop development with C++" workload of Visual Studio Build Tools).

### Sample members (`npm run seed`)

| PIN    | Name         | Status                                          | Door answer          |
|--------|--------------|-------------------------------------------------|----------------------|
| `1234` | Joao Silva   | active, paid until today + 30 days              | `OK`                 |
| `5678` | Maria Souza  | active, `vencimento` was 10 days ago            | `PAGAMENTO_PENDENTE` |
| `9999` | Pedro Santos | inactive                                        | `USUARIO_INATIVO`    |

The seed is safe to re-run: it resets these three members and leaves everything else alone.

## Network: making the ESP32 reach the server

The ESP32 has to be on the same LAN as this machine and use the IP printed at startup (not `localhost`).

### Windows firewall

**On Windows, allow Node.js through Windows Defender Firewall on _Private_ networks, or the ESP32 can't connect.**

- The first time Node listens on a port, Windows shows a prompt. Tick **Private networks** and click *Allow*.
- Check that your Wi-Fi or Ethernet network profile is set to **Private** (Settings → Network & Internet → your network → Network profile type).
- If you dismissed the prompt, add the rule by hand in an **Administrator** PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "Gym API (TCP 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
  ```

### Running under WSL2

By default WSL2 runs behind NAT. The address it prints (for example `172.25.x.x`) is internal to the
Windows machine, so the ESP32 cannot reach it. Pick one of these options:

1. **Mirrored networking (Windows 11 22H2+, simplest).** Add this to `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

   Run `wsl --shutdown`, then reopen WSL. The server now prints the Windows machine's real LAN IP. Inbound
   traffic is also filtered by the Hyper-V firewall, so allow the port in an **Administrator** PowerShell:

   ```powershell
   New-NetFirewallHyperVRule -Name "GymAPI3000" -DisplayName "Gym API (TCP 3000)" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 3000
   ```

2. **Port forwarding (NAT mode).** In an **Administrator** PowerShell, forward the port and open the firewall.
   `<WSL_IP>` is the address the server printed, or the output of `wsl hostname -I`. The WSL IP can change
   after a reboot, and then the forwarding has to be redone.

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3000 connectaddress=<WSL_IP> connectport=3000
   New-NetFirewallRule -DisplayName "Gym API (TCP 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```

   Point the ESP32 at the **Windows** LAN IP (from `ipconfig`).

3. **Run Node directly on Windows** instead of inside WSL. Only the firewall note above then applies.

## API

The examples assume:

```bash
export BASE=http://localhost:3000          # or the LAN address printed at startup
export DEVICE_KEY=...                      # values from your .env
export ADMIN_TOKEN=...
```

(On Windows PowerShell, call `curl.exe` and adapt the quoting, or run the examples from Git Bash or WSL.)

### `GET /api/health`: connectivity test (no auth)

```bash
curl $BASE/api/health
# {"status":"ok"}
```

### `POST /api/acesso`: the ESP32 request

This is the contract the firmware depends on.

```bash
curl -X POST $BASE/api/acesso \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: $DEVICE_KEY" \
  -d '{"device_id":"porta-principal","senha":"1234"}'
```

| Field       | Type   | Rule              |
|-------------|--------|-------------------|
| `device_id` | string | 1–32 characters   |
| `senha`     | string | 4–8 digits only   |

**Every business decision is HTTP 200.** The body always has exactly these 4 flat fields:

```json
{ "liberado": true,  "motivo": "OK",                   "mensagem": "Bem-vindo, Joao!",        "tempo_abertura_ms": 3000 }
{ "liberado": false, "motivo": "SENHA_INVALIDA",       "mensagem": "Senha invalida",          "tempo_abertura_ms": 0 }
{ "liberado": false, "motivo": "PAGAMENTO_PENDENTE",   "mensagem": "Mensalidade em atraso",   "tempo_abertura_ms": 0 }
{ "liberado": false, "motivo": "USUARIO_INATIVO",      "mensagem": "Cadastro inativo",        "tempo_abertura_ms": 0 }
{ "liberado": false, "motivo": "BLOQUEADO_TEMPORARIO", "mensagem": "Aguarde e tente de novo", "tempo_abertura_ms": 0 }
```

- Checks run in this order: brute-force block → PIN lookup → `ativo` → `vencimento >= today`. "Today" is the
  server's local date (set `TZ` if the machine's timezone is wrong). A membership is valid through the whole
  `vencimento` day.
- `mensagem` is ASCII only and at most 32 characters, so it fits a 16x2 LCD. The welcome message uses the
  member's first name with accents removed ("João" becomes "Joao").
- **Brute-force protection:** 5 wrong PINs from the same `device_id` within 60 s block that device for 30 s.
  While blocked, every attempt gets `BLOQUEADO_TEMPORARIO`, including a correct PIN. Only wrong PINs count:
  overdue or inactive members do not. The counters live in memory, so a restart clears them.
- Every attempt, allowed or denied, is written to `access_logs` with its `motivo`.

Technical errors use non-200 codes. The ESP32 treats any non-200 answer as "deny".

| Status | Body                            | When                                                     |
|--------|---------------------------------|----------------------------------------------------------|
| 401    | `{"erro":"nao_autorizado"}`     | `X-Device-Key` missing or wrong (checked before the body) |
| 400    | `{"erro":"requisicao_invalida"}`| Body fails validation or is not valid JSON               |
| 413 / 415 | `{"erro":"requisicao_invalida"}` | Body over 1 KB / `Content-Type` is not JSON          |
| 500    | `{"erro":"erro_interno"}`       | Unexpected error                                         |

The other door answers, using the seed data:

```bash
for pin in 5678 9999 0000; do
  curl -s -X POST $BASE/api/acesso -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" \
    -d "{\"device_id\":\"porta-principal\",\"senha\":\"$pin\"}"; echo
done

# 401: no device key
curl -i -X POST $BASE/api/acesso -H "Content-Type: application/json" -d '{"device_id":"porta-principal","senha":"1234"}'

# 400: PIN too short
curl -i -X POST $BASE/api/acesso -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" \
  -d '{"device_id":"porta-principal","senha":"12"}'

# Brute force: 5 wrong PINs, then even the right one is blocked for 30 s
for i in 1 2 3 4 5 6; do
  curl -s -X POST $BASE/api/acesso -H "Content-Type: application/json" -H "X-Device-Key: $DEVICE_KEY" \
    -d '{"device_id":"teste-bf","senha":"0000"}'; echo
done
```

### Admin API

Every admin route needs `Authorization: Bearer <ADMIN_TOKEN>` and returns 401 `{"erro":"nao_autorizado"}`
without it. Responses never include PINs or PIN hashes. `vencimento` is a `YYYY-MM-DD` date.

**Create a member.** `ativo` is optional and defaults to `true`. Returns 201, or 409 `{"erro":"pin_em_uso"}` if the PIN is taken.

```bash
curl -X POST $BASE/api/members \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"nome":"Ana Costa","pin":"4321","vencimento":"2026-12-31","ativo":true}'
# {"id":4,"nome":"Ana Costa","ativo":true,"vencimento":"2026-12-31","created_at":"2026-11-08T15:00:00.000Z"}
```

**List members**

```bash
curl $BASE/api/members -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Update a member.** Send any subset of `nome`, `pin`, `vencimento`, `ativo`. Returns 404 if the member does
not exist and 409 if the new PIN is taken.

```bash
# Record a payment: extend the membership
curl -X PATCH $BASE/api/members/2 \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"vencimento":"2027-01-31"}'

# Deactivate and change the PIN
curl -X PATCH $BASE/api/members/2 \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"ativo":false,"pin":"24680"}'
```

**Delete a member.** Returns 204, or 404 if the member does not exist. Their past access logs are kept, with `member_id` set to `null`.

```bash
curl -X DELETE $BASE/api/members/4 -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Latest access attempts.** Newest first. `limit` is 1–1000 and defaults to 50.

```bash
curl "$BASE/api/logs?limit=50" -H "Authorization: Bearer $ADMIN_TOKEN"
# [{"id":12,"timestamp":"2026-11-08T15:33:43.112Z","device_id":"porta-principal","member_id":null,
#   "nome":null,"liberado":false,"motivo":"SENHA_INVALIDA"}, ...]
```

Log timestamps are ISO 8601 in UTC.

## Data model

```
members:     id, nome, pin_hash (UNIQUE), ativo (0/1), vencimento (YYYY-MM-DD), created_at
access_logs: id, timestamp, device_id, member_id (nullable), liberado (0/1), motivo
```

- A PIN alone identifies a member, so PINs are unique. The database enforces this with `UNIQUE(pin_hash)`.
- Raw PINs are never stored or logged. `pin_hash = HMAC-SHA256(PIN_PEPPER, pin)` is deterministic, which is
  what makes lookup by PIN possible. Without the pepper, the hashes are useless to whoever copies the database.

## Security notes

- Traffic is plain HTTP on the LAN, so anyone who can sniff the network can see PINs and the device key.
  Keep the ESP32 and the server on a trusted network or a separate VLAN.
- Brute-force limiting is keyed by the `device_id` the client sends. A client that knows `DEVICE_KEY` could
  rotate `device_id`s to get around it, so treat `DEVICE_KEY` as a real secret.
- With only 4-digit PINs, a large gym quickly fills the 10,000 possible codes and random guesses start to
  hit. Prefer 6+ digit PINs.

## Development

```bash
npm test      # node:test suite, uses an in-memory database
npm run dev   # restarts on file changes
```

```
src/
  server.js          entry point: loads .env, listens on 0.0.0.0, prints LAN addresses
  app.js             builds the Fastify app (error handling, route registration)
  config.js          env parsing, constants (door open time, brute-force limits)
  db.js              SQLite schema and all SQL queries
  security.js        PIN hashing (HMAC), constant-time secret comparison, auth hooks
  bruteForce.js      per-device wrong-PIN counter and temporary block
  text.js            ASCII / LCD-safe messages
  dates.js           local-date helpers
  routes/acesso.js   POST /api/acesso (device endpoint)
  routes/admin.js    /api/members and /api/logs
scripts/seed.js      sample members
test/api.test.js     API tests
```
