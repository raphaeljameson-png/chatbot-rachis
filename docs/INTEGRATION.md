# INTEGRATION.md — Intégrer le widget au portail des fiches

Le widget s'intègre dans le repo [`fiches-information-patient`](https://github.com/raphaeljameson-png/fiches-information-patient) via **une seule ligne** à ajouter dans chaque page HTML où tu veux qu'il apparaisse.

Recommandation : l'ajouter sur **toutes les pages** du portail, c'est le plus simple et c'est cohérent du point de vue du patient.

> **Project ID Firebase** : `chatbot-rachis`
> **URL de la Function askChatbot** : `https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot`

---

## Où héberger le widget.js

Deux options :

### Option A — hébergé depuis chatbot-rachis (GitHub Pages) — recommandée

1. Dans le repo `chatbot-rachis`, **active GitHub Pages** :
   - Settings → Pages → Source : Deploy from a branch → Branch : `main` → Folder : `/ (root)` → Save
2. Le widget sera accessible à :
   ```
   https://raphaeljameson-png.github.io/chatbot-rachis/widget/widget.js
   ```

Avantage : versioning automatique, tu modifies le widget dans le repo, il se met à jour partout après quelques minutes de cache.

### Option B — copié dans fiches-information-patient

1. Copie `widget/widget.js` dans le repo des fiches, par exemple à `assets/chatbot-widget.js`
2. Le chemin devient `./assets/chatbot-widget.js` (relatif)

Avantage : un seul domaine, un seul repo à maintenir côté portail. Inconvénient : à chaque update du widget, il faut le re-copier.

**Recommandation : Option A** — plus propre, plus facile à maintenir.

---

## Patch à appliquer sur `fiches-information-patient/index.html`

Juste **avant** la balise `</body>` de l'index, ajouter :

```html
<script
  src="https://raphaeljameson-png.github.io/chatbot-rachis/widget/widget.js"
  data-api-url="https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot"
  data-context="default"
  defer>
</script>
```

C'est tout. Pas de placeholder à remplacer, le Project ID est déjà intégré.

---

## À appliquer sur toutes les fiches

Pour intégrer le widget sur toutes les pages du portail (et pas seulement l'index), ajouter le même bloc `<script>` avant `</body>` de chaque fiche HTML.

Tu peux le faire manuellement (22 fichiers) ou via un petit script bash :

```bash
cd fiches-information-patient

# macOS (utilise sed -i.bak puis supprime les .bak)
for f in $(find . -name "*.html"); do
  if ! grep -q "chatbot-rachis/widget" "$f"; then
    sed -i.bak 's|</body>|  <script src="https://raphaeljameson-png.github.io/chatbot-rachis/widget/widget.js" data-api-url="https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot" data-context="default" defer></script>\n</body>|' "$f"
  fi
done
find . -name "*.bak" -delete

# Vérifier le résultat
grep -rl "chatbot-rachis/widget" --include="*.html" .
```

Sur Linux remplace `sed -i.bak` par `sed -i` (et supprime la ligne `find -delete`).

---

## Contextes avancés pour QR codes

Le widget accepte un attribut `data-context` qui change les **questions fréquentes** affichées à l'ouverture :

| Contexte | Cas d'usage | Suggestions |
|----------|-------------|-------------|
| `default` | Intégration générale du portail | Documents, anesthésie, conduite |
| `preop-admin` | QR sur courrier de convocation | Documents jour J, jeûne, anticoagulants |
| `postop-hernie` | QR sur ordonnance post-op hernie | Cicatrice, reprise, signes d'alerte |
| `postop-lombaire` | QR sur ordonnance post-op lombaire générale | Cicatrice, travail, rééducation |
| `kine` | QR sur ordonnance kiné | Démarrage, exercices, ordonnance |

Tu peux aussi déclencher l'**ouverture automatique** via `data-auto-open="true"` ou en ajoutant `?chat=open` à l'URL (parfait pour les QR codes).

Exemple pour un QR imprimé sur l'ordonnance post-op hernie :
```
https://raphaeljameson-png.github.io/fiches-information-patient/lombaire/hernie-discale.html?chat=open
```

Il faudra que la page `hernie-discale.html` ait le widget intégré avec `data-context="postop-hernie"`.

---

## Valider l'intégration

1. Push le commit
2. Attends 1-2 minutes que GitHub Pages se redéploie
3. Ouvre le portail dans un navigateur en **navigation privée** (pour éviter les caches)
4. Tu dois voir la bulle bleue en bas à droite
5. Clique dessus → la fenêtre s'ouvre avec le message d'accueil et les 3 suggestions
6. Pose une question de test, vérifie la réponse
7. Teste sur mobile (ou avec les devtools en mode responsive, largeur 375px) — la fenêtre doit passer en plein écran

---

## Retirer le widget

Si tu veux désactiver le chatbot temporairement (maintenance, problème) : retire simplement la balise `<script>` des pages. Pas besoin de toucher Firebase.

Ou plus rapide : supprime tous les domaines de `ALLOWED_ORIGINS` dans `functions/index.js` (le CORS bloquera tous les appels) et redéploie avec `firebase deploy --only functions`.
