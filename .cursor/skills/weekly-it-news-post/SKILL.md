---
name: weekly-it-news-post
description: >-
  Research tygodniowych newsów z branży IT, AWS i programowania; przygotuj post
  na Instagram i LinkedIn oraz dodaj wpis do panelu Content System. Używaj gdy
  użytkownik prosi o newsy tygodnia, weekly digest IT/AWS, post branżowy,
  roundup programistyczny lub cotygodniowy content social media.
---

# Weekly IT News → Post IG / LinkedIn

## Kiedy uruchamiać

Użytkownik może powiedzieć np.:
- „Przygotuj post z newsów tygodnia IT/AWS"
- „Weekly digest — Instagram i LinkedIn"
- „Zrób roundup programistyczny na ten tydzień"

## Procedura (kolejność obowiązkowa)

### 1. Research (WebSearch — minimum 5–8 zapytań)

Przeszukaj **aktualny tydzień** (podaj daty w tytule posta). Obszary:

| Obszar | Przykładowe zapytania |
|--------|----------------------|
| AWS / chmura | `AWS news this week`, `re:Invent announcements`, nowe usługi EC2/Lambda |
| Programowanie | wydania języków, frameworki, GitHub trending, CVE/bezpieczeństwo |
| IT ogólne | AI w dev tools, layoffs/hiring, duże przejęcia, open source |

**Źródła (priorytet):** oficjalne blogi (AWS, GitHub, CNCF), Hacker News / dev.to roundupy, The Register, InfoQ, artykuły z datą z bieżącego tygodnia.

**Zasady researchu:**
- Wybierz **3–5 najważniejszych** newsów (nie więcej — czytelność social media).
- Każdy news: **co się stało + dlaczego to ważne dla developera/ops**.
- Podawaj **konkretne daty i nazwy** (np. „AWS ogłosiło X 24 czerwca").
- Nie wymyślaj newsów — jeśli tydzień jest „cichy", napisz to wprost i skup się na mniejszych, ale zweryfikowanych aktualizacjach.

### 2. Przygotuj dwie wersje treści

#### LinkedIn (`platforms: ["li"]`)

- Długość: **800–1200 znaków** (max ~1300).
- Struktura:
  1. Hook (1–2 zdania, pytanie lub teza)
  2. „Oto 3–5 rzeczy, które warto śledzić w tym tygodniu:"
  3. Każdy news: **pogrubiony nagłówek** (w plain text: WIELKIE LITERY lub emoji punktora — bez markdown w polu `text`)
  4. 1–2 zdania kontekstu pod każdym
  5. Krótkie podsumowanie / pytanie do dyskusji
  6. CTA: „Co Was najbardziej zainteresowało? Dajcie znać w komentarzach."
  7. Hashtagi na końcu (5–8): `#AWS #CloudComputing #DevOps #Programming #TechNews` + specyficzne

#### Instagram (`platforms: ["ig"]`)

- Długość: **max ~2200 znaków**, ale celuj w **600–900** (czytelność).
- Struktura:
  1. Mocny hook w pierwszej linii (widoczny przed „więcej")
  2. Numerowana lista 3–5 newsów — **krótko** (1–2 linie każdy)
  3. Linia podsumowująca
  4. CTA: „Zapisz post · Udostępnij zespołowi"
  5. Hashtagi (8–15, mix popularnych i niszowych)

**Ton:** polski, profesjonalny ale przystępny, bez clickbaitu, bez przesadnego hype'u AI.

### 3. Dodaj do panelu Content System

Dwa osobne wpisy w `Panel/content-data.js` (na **początek** tablicy):

```javascript
{
  id: "XXX",  // kolejny wolny numer
  type: "post",
  title: "News tygodnia IT · tydzień DD–DD miesiąc RRRR",
  date: "RRRR-MM-DD",  // piątek lub dzień publikacji
  platforms: ["li"],  // lub ["ig"] — osobny wpis na platformę
  image: "",  // grafika z HiggsField — patrz CLAUDE.md
  text: "..."
}
```

- **Dwa wpisy** (LinkedIn + Instagram) albo **jeden** z `platforms: ["ig", "li"]` jeśli treść jest identyczna (rzadko — zwykle różne długości).
- `image: ""` dopóki użytkownik nie wgra grafiki z HiggsField.
- Tytuł: np. `News tygodnia · AWS & dev · 23–27 czerwca 2026`

### 4. Opcjonalnie: brief pod grafikę HiggsField

Na końcu odpowiedzi podaj krótki **prompt do HiggsField** (ciemne tło, indygo, lista 3–5 punktów jako tekst na grafice karuzeli slajd 1).

### 5. Weryfikacja

```bash
node --check Panel/content-data.js
```

## Format odpowiedzi dla użytkownika

Po zakończeniu przedstaw:

1. **Podsumowanie researchu** (tabela: news | źródło | data)
2. **Treść LinkedIn** (gotowa do skopiowania)
3. **Treść Instagram** (gotowa do skopiowania)
4. **Info o wpisach w panelu** (id, tytuły)
5. **Prompt HiggsField** (jeśli brak grafiki)

## Czego NIE robić

- Nie publikuj automatycznie w social media.
- Nie twórz fake PNG/SVG — tylko `image: ""` lub realny plik z HiggsField.
- Nie łącz w jednym poście 10 newsów — jakość > ilość.
- Nie kopiuj 1:1 treści LinkedIn na IG (różne formaty).

## Powiązane pliki

- `Panel/CLAUDE.md` — zasady dodawania do panelu
- `Panel/workflows/weekly-it-news.md` — szablony i przykłady
- `Panel/content-data.js` — dane treści
