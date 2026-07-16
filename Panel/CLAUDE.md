# Content System — zasady automatyzacji

Każdy nowy post trafia do panelu **automatycznie** według tej procedury:

## 1. Zapisz grafikę

- Do `media/posty/` trafiają **własne grafiki** przygotowane poza panelem.
- **Nie twórz** placeholderów, makiet ani podrobionych plików PNG/SVG.
- Jeśli grafika nie jest jeszcze na dysku, ustaw `image: ""` — panel pokaże fallback „brak grafiki · wgraj własną".

### Ścieżki i nazwy plików

Grafiki postów zapisuj w `media/posty/`.

Nazwa pliku: małe litery, myślniki, numer z przodu, bez polskich znaków i spacji.

Przykład: `media/posty/01-kampania-letnia.png`

## 2. Dopisz wpis do content-data.js

Na **początek** tablicy `window.CONTENT` w `content-data.js`:

```javascript
{
  id: "016",                          // unikalny, kolejny numer
  type: "post",                       // zawsze "post"
  title: "Tytuł treści",
  date: "2026-06-26",                 // RRRR-MM-DD
  platforms: ["ig", "fb"],            // ig, fb, tt, yt, li, x
  image: "media/posty/01-nazwa.png",    // lub "" gdy brak grafiki
  text: "Pełna treść.\n\nDrugi akapit."
}
```

## 3. Zachowaj pełną treść

- Pole `text` zawiera **całą** treść (nagłówki, opisy, CTA, wymiary itp.).
- Akapity oddzielaj `\n` (w pliku — rzeczywiste nowe linie w stringu).

## Marka panelu vs treść

- Panel to narzędzie generyczne — w chrome UI używaj **„Content System"**, nie nazwy marki klienta.
- Nazwa marki może występować wyłącznie w samej treści (`title`, `text`).

## Workflow: News tygodnia IT / AWS / Programowanie

**Trigger:** użytkownik prosi o research newsów tygodnia i post na Instagram / LinkedIn.

Pełna procedura: `workflows/weekly-it-news.md` + skill Cursor `.cursor/skills/weekly-it-news-post/`.

Skrót:
1. **Research** (WebSearch) — 3–5 zweryfikowanych newsów z bieżącego tygodnia (AWS, cloud, programowanie, dev tools).
2. **Dwa formaty treści** — LinkedIn (dłuższy, 800–1200 zn.) i Instagram (krótszy, hook + lista).
3. **Panel** — dwa wpisy `type: "post"` na początku `content-data.js` (`platforms: ["li"]` i `["ig"]`).
4. **Grafika** — opcjonalnie własna grafika; bez pliku → `image: ""`.
5. **Weryfikacja** — `node --check content-data.js`.

Przykładowe polecenie: *„Przygotuj post z newsów tygodnia IT/AWS na IG i LinkedIn"*.

## Weryfikacja po dodaniu

1. Składnia `content-data.js` — `node --check content-data.js`
2. Każda niepusta ścieżka `image` musi wskazywać istniejący plik w `media/`
3. Otwórz `index.html` dwuklikiem i sprawdź kartę oraz panel szczegółów
