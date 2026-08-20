# chatbot-rachis

Assistant d'information patient de l'Espace Francilien du Rachis (EFR).

Chatbot RAG (Retrieval Augmented Generation) qui répond aux questions générales des patients sur leur parcours de soins, en s'appuyant exclusivement sur les fiches d'information officielles du cabinet publiées dans [fiches-information-patient](https://github.com/raphaeljameson-png/fiches-information-patient).

## Cadre et limites

Ce chatbot n'est **pas** un dispositif médical. Il ne fait ni diagnostic, ni pronostic, ni prescription. Pour toute question personnelle, il redirige systématiquement vers le secrétariat ou le 15.

Le chatbot ne stocke aucune donnée patient identifiante : pas de nom, pas de prénom, pas de pathologie personnelle. Les conversations sont anonymes, identifiées par un `sessionId` aléatoire généré côté navigateur.

## Architecture

```
[fiches-information-patient (GitHub Pages)]
   └── index.html intègre : <script src=".../widget.js">
                   │
                   │ POST /askChatbot
                   ▼
[Firebase Functions — projet chatbot-rachis]
   askChatbot :
     1. Embed query via Voyage (voyage-multilingual-2)
     2. findNearest sur Firestore → top chunks (priorisation fiche courante)
     3. Build context + call Claude Opus 4.7 (avec prompt caching)
     4. Log anonymisé, retour au widget
                   │
                   │ read/write
                   ▼
[Firestore — chatbot-rachis]
   ├── fiches_chunks         (≈90 docs, embeddings 1024 dims)
   ├── chatbot_rate_limits   (par session, par jour)
   └── chatbot_logs          (anonymes, pour amélioration)
```

## Stack

- **Voyage AI** — modèle `voyage-multilingual-2` (1024 dimensions, français/multilingue, plan gratuit généreux).
- **Anthropic Claude Opus 4.7** (`claude-opus-4-7`) — génération de réponses ancrées sur le contexte fourni, avec prompt caching sur le system prompt pour réduire le coût d'entrée d'environ 45 %.
- **Firebase Functions** (Node.js 20, région `europe-west1`).
- **Firestore vector search** (natif, pas de base vectorielle externe).
- **Widget** vanilla JS sans dépendance.

## Déploiement

Voir [`docs/SETUP.md`](docs/SETUP.md) pour le guide de déploiement pas-à-pas.

Intégration dans le portail des fiches : voir [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Coût estimé

- **Voyage AI** : 0 € (plan gratuit largement suffisant pour le volume attendu)
- **Claude Opus 4.7** : ~10-20 €/mois selon trafic, grâce au prompt caching (le system prompt étant lu depuis le cache à tarif réduit sur la quasi-totalité des requêtes)
- **Firebase** : 0 € (largement sous le quota gratuit du plan Blaze)
- **Total** : ~10-20 €/mois à régime de croisière

## Sécurité

- Clés API stockées dans Firebase Secret Manager, jamais exposées côté client.
- CORS restreint aux domaines EFR (`raphaeljameson-png.github.io`, `rachis.paris`).
- Rate limiting : 30 messages par session et par jour.
- Règles Firestore : tout verrouillé côté client, seules les Functions admin accèdent.
- Logs anonymes : uniquement la question, un preview de réponse et un hash de session.
