# Deploy Content System + WSAD na **rekinybiznesu.shop**

Panel (generator newsów, Bedrock, baza użytkowników, `/wsad`) działa jako **jedna aplikacja Node.js** na Hostingerze. Po podpięciu domeny wszystko jest pod tym samym originem — auth i API działają bez dodatkowej konfiguracji CORS.

## 1. Domena w Hostinger (hPanel)

1. **Websites** → dodaj lub wybierz stronę dla `rekinybiznesu.shop`.
2. **Domains** → przypisz `rekinybiznesu.shop` (i opcjonalnie `www` → przekierowanie na apex).
3. Włącz **SSL** (Let’s Encrypt) — wymagane do logowania i API w przeglądarce.

## 2. Node.js Web App (to samo repo co GitHub)

| Ustawienie | Wartość |
|------------|---------|
| **Repository** | `github.com/goreckis6/mmark` (branch `main`) |
| **Root katalogu aplikacji** | **katalog główny repozytorium** (tam jest `app.js` w root) |
| **Plik startowy** | `app.js` |
| **Build** | `npm install` (lub `npm run build` — robi to samo) |
| **Start** | `npm start` → `node app.js` |
| **Node** | ≥ 20 |

> Jeśli masz starą konfigurację z **root: `Panel`** — też działa (`Panel/app.js`). Preferowany wariant: **root repo** + `app.js` w root (importuje `Panel/publish-server.mjs`).

Po deployu sprawdź:

- `https://rekinybiznesu.shop/health` → JSON z `"ok": true`, `"auth": true`
- `https://rekinybiznesu.shop/` → panel Content System
- `https://rekinybiznesu.shop/wsad` → generator blogów (ukryty URL)
- `https://rekinybiznesu.shop/login.html` → logowanie (jeśli używasz)

## 3. Zmienne środowiskowe (Environment variables)

Skopiuj z działającego środowiska (np. poprzednia domena) i uzupełnij:

```env
AWS_REGION=eu-central-1
BEDROCK_MODEL_ID=eu.anthropic.claude-opus-4-8
BEDROCK_IMAGE_ENGINE=svg

PUBLIC_SITE_URL=https://rekinybiznesu.shop

ADMIN_USERNAME=admin
ADMIN_PASSWORD=<silne_hasło>

BOOTSTRAP_USERS=rekinybiznesu:<hasło_użytkownika>

# AWS — klucze IAM lub rola (tylko na serwerze, NIE w repo)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Opcjonalnie lepszy research WSAD
# BRAVE_SEARCH_API_KEY=...
# SERPER_API_KEY=...
```

**Nie commituj** `.env` — tylko hPanel → Environment variables.

## 4. AWS Bedrock

- Region **eu-central-1 (Frankfurt)** — tekst (Claude Opus 4.8).
- Thumbnails: **SVG przez Claude** (`BEDROCK_IMAGE_ENGINE=svg`) — w Frankfurt nie ma modeli image Titan/Nova.
- IAM: `bedrock:InvokeModel` dla `eu.anthropic.claude-opus-4-8`.

## 5. Baza WSAD (tytuły / posty)

Dane kont użytkowników i biblioteka WSAD są w `Panel/data/store.json` na serwerze (persist po redeploy, jeśli Hostinger nie czyści dysku). Po pierwszym logowaniu na nowej domenie lokalne dane z przeglądarki mogą się **zmigrować** do bazy (pusty stan na serwerze + dane w localStorage).

## 6. Przeniesienie z innej domeny

1. W hPanel: **nowa strona** albo **dodatkowa domena** na tej samej Node app (zależnie od planu Hostinger).
2. Te same env + **Redeploy** z `main`.
3. Opcjonalnie skopiuj `Panel/data/` ze starego hostingu (backup `store.json` + `media/posty/`).
4. Stara domenę możesz zostawić jako redirect 301 → `https://rekinybiznesu.shop` (DNS / hPanel Redirects).

## 7. Checklist po starcie

- [ ] `/health` → `bedrock: true` (jeśli false — credentials / IAM)
- [ ] Logowanie działa
- [ ] Generator newsów + tłumaczenie Bedrock
- [ ] `/wsad` — analyze, generate, zapis w DB, ten sam login na drugim urządzeniu
- [ ] Upload grafiki → `media/posty/`

## 8. Landing (opcjonalnie)

Folder `Landing/` nie jest domyślnie serwowany przez Express (root = `Panel/`). Jeśli chcesz stronę marketingową na `/` a panel pod `/panel`, trzeba osobno ustawić routing — na razie **domyślnie panel jest na `/`**.
