# Workflow: News tygodnia IT / AWS / Programowanie

Cotygodniowy research → post LinkedIn + Instagram → wpis w panelu.

## Jak uruchomić

W Cursorze napisz np.:

```
Przygotuj post z newsów tygodnia IT/AWS na Instagram i LinkedIn
```

Agent użyje skilla `weekly-it-news-post` i:
1. Zrobi research (WebSearch)
2. Napisze dwie wersje posta
3. Doda wpisy do `content-data.js`
4. Zaproponuje brief pod własną grafikę (wymiary w **Formaty graficzne**)

## Harmonogram (sugestia)

| Dzień | Działanie |
|-------|-----------|
| Piątek | Research + draft postów |
| Piątek/sobota | Własna grafika → `media/posty/` |
| Poniedziałek | Publikacja LinkedIn |
| Wtorek | Publikacja Instagram |

## Szablon LinkedIn

```
[Hook — pytanie lub teza o tym, co się dzieje w IT w tym tygodniu]

Oto X rzeczy, które warto śledzić (tydzień DD–DD miesiąc):

1. [NAZWA NEWSU]
[1–2 zdania: co + dlaczego ważne]

2. [NAZWA NEWSU]
[1–2 zdania]

3. [NAZWA NEWSU]
[1–2 zdania]

[Opcjonalnie 4–5]

[Podsumowanie jednym zdaniem + pytanie do dyskusji]

Co Was najbardziej zainteresowało? 👇

#AWS #CloudComputing #DevOps #Programming #TechNews #[specyficzne]
```

## Szablon Instagram

```
[Hook — max 1 linia, mocny]

Tydzień w IT w X punktach 👇

1️⃣ [News — 1–2 linie]
2️⃣ [News — 1–2 linie]
3️⃣ [News — 1–2 linie]
4️⃣ [News — opcjonalnie]
5️⃣ [News — opcjonalnie]

[1 zdanie podsumowania]

💾 Zapisz · 🔁 Udostępnij zespołowi

.
.
.
#programowanie #aws #cloud #devops #technews #developer #software #it #coding #[niszowe]
```

## Wpis w content-data.js

Dwa wpisy (zalecane — różna długość treści):

```javascript
{
  id: "016",
  type: "post",
  title: "News tygodnia IT · 23–27 czerwca 2026",
  date: "2026-06-27",
  platforms: ["li"],
  image: "",
  text: "..."
},
{
  id: "017",
  type: "post",
  title: "News tygodnia IT · IG · 23–27 czerwca 2026",
  date: "2026-06-28",
  platforms: ["ig"],
  image: "",
  text: "..."
}
```

Po przygotowaniu grafiki:

1. Zapisz jako `media/posty/XX-news-tygodnia-RRRR-MM-DD.png`
2. Ustaw `image` w obu wpisach (lub w jednym wspólnym, jeśli ta sama grafika)

## Brief graficzny (przykład)

```
Dark tech social media carousel slide, cool black background #0a0a0f,
indigo #6366f1 accent glow, minimal line icons, headline text:
"NEWS TYGODNIA · IT & AWS", subtext: "23–27 czerwca 2026",
clean typography, no clutter, premium SaaS aesthetic, 1080x1080
```

## Obszary researchu (checklist)

- [ ] AWS: nowe usługi, deprecacje, ceny, re:Invent / summits
- [ ] Kubernetes / CNCF / Terraform
- [ ] Języki: Python, JS/TS, Rust, Go — wydania, LTS
- [ ] GitHub: Copilot, Actions, security advisories
- [ ] AI dla developerów (nowe modele, IDE, agenci) — bez hype'u
- [ ] Bezpieczeństwo: CVE, supply chain
- [ ] Open source: ważne release'y, licencje

## Jakość

- Minimum **3**, maksimum **5** newsów na post
- Każdy news ze **źródłem** (w odpowiedzi agenta, niekoniecznie w poście)
- Daty w tytule posta zawsze aktualne
- Treść po polsku, nazwy techniczne po angielsku (AWS Lambda, nie „AWS Lambda" po polsku)
