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
| `OFFLINE_KEY` | yes      |               | 32 random bytes as 64 hex chars. Key for `pin_hash_offline` (the ESP32 offline list); flash the same value into the ESP32. Must differ from `PIN_PEPPER`. |
| `DB_PATH`     | no       | `data/gym.db` | SQLite file (relative to the project root).                        |
| `LOG_LEVEL`   | no       | `info`        | Pino log level.                                                    |

> **Do not change `PIN_PEPPER` once members exist.** Every stored PIN hash depends on it, so after a change
> no PIN will match and every member has to be given a new PIN.
>
> **The same goes for `OFFLINE_KEY`.** Raw PINs are not stored, so `pin_hash_offline` cannot be recomputed:
> after a change, every member has to be given a new PIN, and the ESP32 has to be flashed with the new key.

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

**Upgrading an existing database.** The server adds the `pin_hash_offline` column on startup. Members created
before that have no offline hash, because raw PINs are not stored. They are left out of the ESP32 offline list
until their PIN is set again (`PATCH /api/members/:id` with `pin`), or, for the sample members, until you
re-run `npm run seed`. At startup the server prints a warning with the number of members still missing it.

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

### `GET /api/dispositivo/membros`: offline member list for the ESP32

So the door keeps working when the server is unreachable, the ESP32 keeps its own copy of the members it may
let in and refreshes it from time to time. Needs `X-Device-Key`, like `/api/acesso` (401 `{"erro":"nao_autorizado"}`
otherwise). `versao` is the list version the device already holds: send `0` (or leave it out) when it has none.

```bash
# First download: the device has no list yet
curl -s "$BASE/api/dispositivo/membros?versao=0" -H "X-Device-Key: $DEVICE_KEY"
# {"versao":43,"membros":[[12,"a1b2c3d4e5f60718",2535],[15,"0f1e2d3c4b5a6978",2600]]}

# Next poll, sending the version it got: nothing changed, so 304 with an empty body
curl -i "$BASE/api/dispositivo/membros?versao=43" -H "X-Device-Key: $DEVICE_KEY"
# HTTP/1.1 304 Not Modified
```

Each entry is `[member_id, pin_hash_offline, validade_dias]`:

- `pin_hash_offline`: 16 hex characters derived from the PIN (see below).
- `validade_dias`: the member's `vencimento` as a day number, counting calendar days from 2020-01-01 (which is
  day 0). The member may enter while today's day number, in `America/Sao_Paulo`, is `<= validade_dias`.

How the list behaves:

- It contains only members that are `ativo`, have a `pin_hash_offline`, and have `vencimento >= today`
  (today in `America/Sao_Paulo`).
- `versao` goes up on every change that can affect the list: a member created or deleted, or their PIN,
  `ativo` or `vencimento` changed. Changing only `nome`, or saving the same value again, does not count.
- `versao` does **not** go up when a date passes. The device must compare `validade_dias` with its own clock,
  so it needs the right time (NTP).
- Any `versao` other than the current one gets the whole list (200), never a diff. Replace the stored list as a whole.
- The body is compact JSON of about 32 bytes per member (about 64 KB for 2,000 members). Parse it as a stream
  on the ESP32 instead of building the whole document in RAM.
- `versao` that is not a non-negative integer gets 400 `{"erro":"requisicao_invalida"}`.
- `/api/acesso` uses the server's local date, while this list uses `America/Sao_Paulo`. Run the server with
  `TZ=America/Sao_Paulo` so both agree around midnight.
- If you delete the database, `versao` starts again from 1. Clear the list stored on the ESP32 too, so it
  cannot keep an old list whose version number happens to match.

Checking a PIN on the device, offline:

```
h       = first 8 bytes of HMAC-SHA256(OFFLINE_KEY bytes, pin), as 16 lowercase hex chars
entry   = the list entry whose pin_hash_offline == h
today   = (unix_seconds - 3*3600) / 86400 - 18262   # Sao Paulo is UTC-3 all year; 18262 = days from 1970-01-01 to 2020-01-01
allowed = entry exists and today <= entry.validade_dias
```

#### Computing `pin_hash_offline` by hand

`pin_hash_offline` is the first 8 bytes of HMAC-SHA256, with the key `OFFLINE_KEY` decoded from hex into its
32 raw bytes and the message being the PIN as UTF-8 text, written as 16 lowercase hex characters.

```bash
npm run offline-hash -- 1234 5678     # uses OFFLINE_KEY from .env
# 1234  <16 hex chars>
# 5678  <16 hex chars>

# The same with OpenSSL only. Use printf '%s', not echo: a trailing newline changes the hash.
printf '%s' 1234 | openssl dgst -sha256 -mac HMAC -macopt hexkey:$OFFLINE_KEY | awk '{print substr($NF,1,16)}'
```

To test the ESP32 code without the real key, use these reference values. They were computed with OpenSSL and
Python, and the test suite checks them. The key is the bytes `00 01 02 … 1f`:
`OFFLINE_KEY=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`

| PIN     | `pin_hash_offline`  |
|---------|---------------------|
| `1234`  | `75a2b0661f593e7c`  |
| `5678`  | `b7b278a6c70adb7b`  |
| `9999`  | `2ca52f41b99ebb28`  |
| `24680` | `3e936c9b116807fd`  |

`OFFLINE_KEY=000102…1f npm run offline-hash -- 1234` (with the full key) prints the same value. Common mistakes on
the device side: using the 64-character hex text as the HMAC key instead of the 32 bytes it encodes, and
hashing the PIN with a trailing newline or as a number.

Reference day numbers: `2020-01-01` → 0, `2021-01-01` → 366, `2026-11-11` → 2506.

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
members:     id, nome, pin_hash (UNIQUE), pin_hash_offline (nullable), ativo (0/1), vencimento (YYYY-MM-DD), created_at
access_logs: id, timestamp, device_id, member_id (nullable), liberado (0/1), motivo
settings:    key, value          (key 'lista_versao': version of the ESP32 offline list)
```

- A PIN alone identifies a member, so PINs are unique. The database enforces this with `UNIQUE(pin_hash)`.
- Raw PINs are never stored or logged. `pin_hash = HMAC-SHA256(PIN_PEPPER, pin)` is deterministic, which is
  what makes lookup by PIN possible. Without the pepper, the hashes are useless to whoever copies the database.
- `lista_versao` is bumped by SQLite triggers on `members`, so every writer (the API, the seed script, manual
  edits with the `sqlite3` CLI) keeps it correct.

## Security notes

- Traffic is plain HTTP on the LAN, so anyone who can sniff the network can see PINs and the device key.
  Keep the ESP32 and the server on a trusted network or a separate VLAN.
- Brute-force limiting is keyed by the `device_id` the client sends. A client that knows `DEVICE_KEY` could
  rotate `device_id`s to get around it, so treat `DEVICE_KEY` as a real secret.
- With only 4-digit PINs, a large gym quickly fills the 10,000 possible codes and random guesses start to
  hit. Prefer 6+ digit PINs.
- **The offline list is weaker than the online check, by design.** PINs have at most 8 digits, so anyone with
  the list and `OFFLINE_KEY` can recover every listed PIN in seconds by trying them all. Both are stored on the
  ESP32, so turn on its flash encryption and treat a lost device as a leak (rotate `OFFLINE_KEY` and the PINs).
  A key separate from `PIN_PEPPER` means a key pulled from the device cannot be used on the server's `pin_hash` column.
- Offline decisions happen only on the device. The server does not log them and its brute-force limit does
  not apply, so the firmware has to limit wrong PINs itself.

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
  security.js        PIN hashing (online and offline HMAC), constant-time secret comparison, auth hooks
  bruteForce.js      per-device wrong-PIN counter and temporary block
  text.js            ASCII / LCD-safe messages
  dates.js           date helpers (local date, date in a timezone, day numbers)
  routes/acesso.js   POST /api/acesso (device endpoint)
  routes/dispositivo.js  GET /api/dispositivo/membros (ESP32 offline list)
  routes/admin.js    /api/members and /api/logs
scripts/seed.js      sample members
scripts/offline-hash.js  prints pin_hash_offline for given PINs
test/api.test.js     API tests
test/offline.test.js offline hash, day numbers, OFFLINE_KEY config, migration
```
