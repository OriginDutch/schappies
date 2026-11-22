# Boodschappen

Boodschappenlijst per winkel, gesorteerd op gangpad. PWA (vanilla JS) op GitHub Pages, data in Cloud Firestore.

## Lokaal draaien

```
npx serve .
```

Open daarna `http://localhost:3000` (gebruik `localhost`, niet `127.0.0.1`: alleen `localhost` mag standaard inloggen bij Firebase).
Lokaal draait er bewust geen service worker, zodat je wijzigingen direct ziet.

## Security rules deployen

```
firebase deploy --only firestore:rules
```

Doe dit na elke wijziging aan `firestore.rules`. Zonder deploy staan de rules in Firebase nog op "alles dicht".

## Release

1. Hoog het versienummer op in `js/version.js`.
2. Nieuw JS/CSS-bestand toegevoegd? Zet het ook in de `SHELL`-lijst in `sw.js`.
3. Commit en push. GitHub Pages zet het binnen ongeveer een minuut live.
4. Op de telefoon verschijnt "Nieuwe versie beschikbaar · Vernieuwen".

## Structuur

- `index.html`: schil
- `css/app.css`: styling en thema's
- `js/version.js`: het versienummer (één plek)
- `js/firebase.js`: Firebase-config en init
- `js/data.js`: alle Firestore-toegang
- `js/theme.js`: licht/donker/systeem
- `js/app.js`: schermen, navigatie, PWA-updates
- `sw.js`: service worker
- `firestore.rules`: wie mag wat
