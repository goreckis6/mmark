# Content System — panel publikacji

Prosty panel do przygotowania postów na LinkedIn, Facebook i Instagram. Publikacja odbywa się **ręcznie poza panelem** — panel trzyma treści, grafiki i checklistę.

## Struktura folderów

```
Panel/
├── index.html          # Panel (HTML + CSS + JS)
├── content-data.js     # Dane treści: window.CONTENT = [ ... ]
├── post-manager.js     # Formularz postów, statusy, 3 wersje tekstu
├── brand-kit.js        # Motyw marki, tematy, URL uploadu
├── image-formats.js    # Wymiary grafik dla platform social
├── publish-server.mjs  # Lokalny serwer uploadu (port 8787)
├── CLAUDE.md           # Zasady automatyzacji dla agentów AI
├── Panel-README.md     # Ten plik
└── media/
    ├── posty/          # Grafiki do postów
    └── brand/          # Logo marki (referencja wizualna)
```

## Uruchomienie

**Podgląd bez uploadu:** otwórz `Panel/index.html` w przeglądarce (dwuklik).

**Z uploadem grafik i tłumaczeniem Bedrock (lokalnie):**

```bash
cd Panel
cp .env.example .env          # uzupełnij region / model (klucze przez aws configure)
npm install
npm start                     # port 8787
python3 -m http.server 8080    # panel w drugim terminalu
```

Panel: `http://localhost:8080`

**AWS Bedrock** — credentials **nigdy** w przeglądarce ani w repo. Serwer lokalny (`publish-server.mjs`) woła Bedrock z `.env` lub profilu `~/.aws/credentials`. IAM: uprawnienie `bedrock:InvokeModel` dla wybranego modelu w regionie (np. `eu-central-1`).

Tłumaczenie w generatorze: najpierw Bedrock (jeśli `/health` zwraca `bedrock: true`), fallback na darmowe API MyMemory.

## Workflow

1. **Temat + tekst źródłowy (master)** — w formularzu posta
2. **Obróbka** → 3 wersje: LinkedIn / Facebook / Instagram (przyciski „Rozłóż master”, „Dopasuj …”)
3. **Status:** Szkic → Gotowy
4. **Grafika** — własna grafika wg **Formatów graficznych**; logo/kolory w **Motyw marki**
5. **Ręczne wrzucenie** na social media + oznaczenie „Wrzucone na …” w szczegółach posta

## Dodawanie treści

### Krok 1 — Grafika

Wgraj własną grafikę do `media/posty/` (przeciągnij w formularzu posta lub skopiuj plik ręcznie).

Konwencja nazw: `01-nazwa-tresci.png` (małe litery, myślniki, numer z przodu).

W **Motyw marki** ustaw logo i kolory jako odniesienie przy tworzeniu grafik.

### Wymiary grafik (social media)

W panelu: **Formaty graficzne** (menu boczne) — tabela wymiarów dla IG, FB, LinkedIn.

| Preset | Wymiary | Platformy |
|--------|---------|-----------|
| Post pionowy IG | 1080×1350 (4:5) | Instagram feed |
| Kwadrat uniwersalny | 1080×1080 (1:1) | IG, FB, LinkedIn |
| Poziomy LI / FB | 1200×627 (1.91:1) | LinkedIn, Facebook |
| Story / Reels | 1080×1920 (9:16) | IG, FB |

Pliki: **JPG, PNG lub WEBP**, zwykle do **8 MB**.

### Krok 2 — Post w panelu

Przycisk **Nowy post** — zapis trafia do przeglądarki (localStorage).

| Pole | Opis |
|------|------|
| `title` | Tytuł wewnętrzny (na karcie) |
| `topic` | Temat z listy (np. IT/AWS, News tygodnia) |
| `date` | Data: `RRRR-MM-DD` |
| `platforms` | Tablica: `li`, `fb`, `ig` |
| `textMaster` | Tekst źródłowy |
| `textLi` / `textFb` / `textIg` | Wersje per platforma |
| `image` | Ścieżka względem `Panel/` lub `""` |
| `status` | `"draft"` lub `"ready"` |
| `donePlatforms` | `["li"]` — platformy już wrzucone ręcznie |

Opcjonalnie możesz też dodawać wpisy do `content-data.js` (tablica `window.CONTENT`).

### Upload grafiki

1. Uruchom `node publish-server.mjs` i otwórz panel przez HTTP
2. W formularzu posta przeciągnij JPG, PNG lub WEBP na pole grafiki
3. Plik zapisze się w `media/posty/` automatycznie

## Funkcje panelu

- **Nowy post:** master + 3 wersje tekstu (LI / FB / IG)
- **Statusy:** Szkic → Gotowy → Opublikowany (po oznaczeniu wszystkich platform)
- **Checklist** przed wrzuceniem (teksty, grafika, status)
- **Do publikacji:** filtr postów gotowych (status Gotowy, nieoznaczone platformy)
- **Kopiuj treść** per platforma z karty lub szczegółów
- **Motyw marki:** logo, kolory, tematy postów
- **Filtry:** platformy, tematy, wyszukiwarka
- **Widoki:** siatka kart lub kalendarz miesiąca
- **Generator newsów:** jeden szkic z wersjami LI/IG (temat: News tygodnia)

## News tygodnia (IT / AWS / programowanie)

### W panelu (Generator)

1. W lewym pasku kliknij **Generator newsów**
2. **Pobierz newsy i wygeneruj post** — newsy w oryginale; tłumaczenie opcjonalnie przyciskiem **Tłumacz na PL**
3. **Zapisz szkic w panelu** — jeden post z wersjami per platforma
4. Wgraj własną grafikę, ustaw status Gotowy, wrzuć ręcznie i oznacz w panelu

### W Cursorze (pełny research AI)

Agent może cotygodniowo przygotować newsy i dodać wpis do panelu lub `content-data.js`.

**Jak uruchomić w Cursorze:** *„Przygotuj post z newsów tygodnia IT/AWS"*

Szczegóły: `workflows/weekly-it-news.md`
