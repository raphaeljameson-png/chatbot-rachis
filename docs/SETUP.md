# SETUP.md — Déploiement pas-à-pas du chatbot EFR

Guide complet pour passer d'un repo vide à un chatbot en production. Durée estimée : **45 minutes** si tout se passe bien.

Ce guide suppose que tu es sur macOS ou Linux. Sur Windows, utilise Git Bash ou WSL.

> **Rappel des identifiants Firebase**
> - Project ID : `chatbot-rachis`
> - Numéro du projet : `243734560305`
> - Organisation GCP : `rachis.paris`
> - Région Functions : `europe-west1`
> - URL finale de la Function : `https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot`

---

## Prérequis

Tu dois avoir :
- Un compte **GitHub** (déjà fait : `raphaeljameson-png`)
- Un compte **Anthropic** avec clé API (déjà fait via Optim'CCAM)
- Un projet **Firebase `chatbot-rachis`** créé (déjà fait — voir plus haut)
- Le plan Firebase **Blaze** activé sur ce projet (nécessaire pour Cloud Functions)
- **Node.js 20+** installé localement
- **Firebase CLI** installé : `npm install -g firebase-tools`
- **git** installé

---

## Étape 1 — Créer un compte Voyage AI (5 min)

1. Va sur [voyageai.com](https://www.voyageai.com/)
2. Sign up (email + mot de passe, ou Google)
3. Dans le dashboard, clique **API Keys** dans la sidebar
4. Clique **Create new secret key**, nomme-la `chatbot-rachis`
5. **Copie la clé** (commence par `pa-...`) et garde-la dans ton gestionnaire de mots de passe
6. Le plan gratuit donne 200M tokens/mois — largement plus que ce dont on a besoin (~50k tokens pour indexer toutes tes fiches + quelques centaines par conversation)

---

## Étape 2 — Vérifier le projet Firebase (2 min)

Projet `chatbot-rachis` déjà créé. Confirme juste dans la console :

1. [console.firebase.google.com/project/chatbot-rachis](https://console.firebase.google.com/project/chatbot-rachis)
2. Active **Firestore Database** si ce n'est pas déjà fait :
   - Menu gauche → Firestore Database → Create database → **production mode** → région **europe-west1** (Belgique)
3. Vérifie que le projet est bien en plan **Blaze** (sinon, Usage and billing → Modify plan → Blaze)
4. Active une **alerte budget à 5 €/mois** par sécurité : Google Cloud Console → Billing → Budgets & Alerts

---

## Étape 3 — Cloner le repo et configurer Firebase CLI (3 min)

```bash
# Clone le repo localement
git clone https://github.com/raphaeljameson-png/chatbot-rachis.git
cd chatbot-rachis

# Le fichier .firebaserc est déjà pré-configuré avec chatbot-rachis, rien à faire.

# Connecte Firebase CLI à ton compte Google
firebase login

# Vérifie que le projet est bien pris en compte
firebase use chatbot-rachis
firebase projects:list
```

---

## Étape 4 — Déployer Firestore rules + index (2 min)

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

⚠ **L'index vectoriel prend 5-10 minutes à se construire en arrière-plan.** C'est Firebase qui le fait, tu n'as pas besoin d'attendre pour continuer. Par contre, l'indexation (étape 6) échouera si tu la lances trop vite.

Pour vérifier l'état de l'index :
- Console Firebase → Firestore → onglet **Indexes** → sous-onglet **Vector**
- L'index sur `fiches_chunks.embedding` doit passer de `Building` à `Ready`

---

## Étape 5 — Configurer les secrets Firebase (3 min)

```bash
firebase functions:secrets:set VOYAGE_API_KEY
# → colle ta clé pa-... quand demandé

firebase functions:secrets:set ANTHROPIC_API_KEY
# → colle ta clé sk-ant-... quand demandé
```

Les clés sont stockées dans **Google Secret Manager** et ne sont accessibles qu'aux Functions, jamais au code client.

---

## Étape 6 — Indexer les fiches (5 min)

Attends d'abord que l'index vectoriel soit **Ready** (étape 4).

Pour que le script puisse écrire dans Firestore, il lui faut un **service account** :

1. Console Firebase → Paramètres du projet (roue crantée en haut à gauche) → **Service accounts**
2. Clique **Generate new private key** → confirme
3. Un fichier JSON est téléchargé. Renomme-le `firebase-service-account.json` et place-le **en dehors** du repo (par exemple dans `~/keys/`) — ce fichier ne doit JAMAIS être commité. Le `.gitignore` du projet le bloque déjà par sécurité.

Puis :

```bash
# Install des dépendances du script d'indexation
cd scripts
npm install
cd ..

# Lancement de l'indexation
VOYAGE_API_KEY=pa-TA-CLE-ICI \
GOOGLE_APPLICATION_CREDENTIALS=~/keys/firebase-service-account.json \
node scripts/index-fiches.js
```

Tu dois voir défiler :

```
=== Indexation 22 fiches EFR ===

1. Nettoyage de l'ancienne collection fiches_chunks...
   (collection vide)

2. Téléchargement et extraction des fiches...
   ✓ cervical/acdf.html — 0 FAQ + 4 chunks corps
   ✓ cervical/prothese-discale.html — 3 FAQ + 5 chunks corps
   ...

   Total chunks : environ 90

3. Génération des embeddings Voyage AI...
   ✓ batch 1 — 64 embeddings
   ✓ batch 2 — 26 embeddings

4. Écriture vers Firestore collection `fiches_chunks`...
   ✓ écrit 90/90

=== Indexation terminée : 90 chunks ===
```

En cas d'erreur `VectorSearch index is not ready`, attends quelques minutes et relance.

---

## Étape 7 — Tester la recherche vectorielle AVANT de déployer le chatbot (2 min)

```bash
VOYAGE_API_KEY=pa-TA-CLE \
GOOGLE_APPLICATION_CREDENTIALS=~/keys/firebase-service-account.json \
node scripts/test-query.js "quels documents apporter le jour de l'opération"
```

Tu dois voir les 5 chunks les plus pertinents avec leur source. Si les résultats n'ont rien à voir avec la question, arrête et ré-indexe — il y a un problème.

Teste avec 3-4 questions variées pour valider :
- `"je dois arrêter mes anticoagulants"` → devrait pointer sur le livret transversal
- `"canal cervical"` → devrait pointer sur la fiche cervicale
- `"reprise sport hernie"` → devrait pointer sur hernie discale ou rééducation

---

## Étape 8 — Déployer la Cloud Function (5 min)

```bash
cd functions
npm install
cd ..

firebase deploy --only functions
```

À la fin tu verras l'URL de la fonction, qui doit être **exactement** :

```
Function URL (askChatbot): https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot
```

---

## Étape 9 — Test rapide de la Function (1 min)

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: https://raphaeljameson-png.github.io" \
  -d '{"question":"quels documents apporter","sessionId":"test_session_123"}' \
  https://europe-west1-chatbot-rachis.cloudfunctions.net/askChatbot
```

Tu dois recevoir une réponse JSON avec `reponse`, `sources`, `remaining`.

---

## Étape 10 — Intégrer le widget au portail

Voir [`INTEGRATION.md`](INTEGRATION.md) pour le patch à appliquer au repo `fiches-information-patient`.

---

## Maintenance courante

### Quand tu modifies une fiche

Relance simplement l'étape 6 (indexation). Le script efface et ré-indexe tout, c'est idempotent. Durée : ~2 minutes.

### Quand tu modifies le system prompt

Re-déploie seulement la Function : `firebase deploy --only functions`. Durée : ~2 minutes.

### Monitoring

- **Coûts** : Firebase Console → Usage
- **Logs** : Firebase Console → Functions → askChatbot → Logs
- **Conversations** : Firebase Console → Firestore → `chatbot_logs` (anonymisé)
- **Utilisation par session** : Firestore → `chatbot_rate_limits`

### Purge des logs anciens

Les logs Firestore s'accumulent. Tous les ~6 mois, il est sain de purger ceux de plus de 90 jours :
- Console Firestore → `chatbot_logs` → requête par date → suppression en batch
- Ou on ajoutera une Cloud Function planifiée si besoin.

---

## Dépannage

| Symptôme | Cause probable | Solution |
|----------|----------------|----------|
| `VectorSearch index is not ready` | L'index Firestore n'a pas fini de se construire | Attendre 5-10 min, vérifier dans la console → Firestore → Indexes |
| `Voyage API 401` | Mauvaise clé VOYAGE_API_KEY | Vérifier dans voyageai.com → API Keys |
| `Anthropic API 401` | Mauvaise clé ANTHROPIC_API_KEY | Vérifier console.anthropic.com → API Keys |
| `CORS error` dans la console navigateur | L'origine du site n'est pas dans `ALLOWED_ORIGINS` de `functions/index.js` | Ajouter l'origine, redéployer |
| Widget ne s'affiche pas | `data-api-url` manquante ou mauvaise | Ouvrir la console navigateur, lire l'erreur |
| Le bot répond toujours « je ne trouve pas » | Pas de chunks indexés OU index pas encore Ready | Relancer `test-query.js`, vérifier |
