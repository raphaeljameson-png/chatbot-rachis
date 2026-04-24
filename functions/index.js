/**
 * functions/index.js — Backend Chatbot patient EFR v1.3
 *
 * Fonction principale :
 *   - askChatbot : pipeline RAG complet (embed query → search Firestore → LLM response)
 *
 * v1.3 — "Rolls-Royce avec frein à main" :
 *   - Modèle Claude Opus 4.7 (claude-opus-4-7) au lieu de Haiku 4.5 pour qualité max
 *   - Prompt caching activé sur system prompt + RAG context (économie ~45% input)
 *   - Mode hybride déclaré : Claude peut s'appuyer sur ses connaissances médicales
 *     générales SI les fiches EFR ne couvrent pas le sujet, avec avertissement clair
 *     et systématique que l'info ne provient pas d'une source EFR officielle
 *   - Extended thinking désactivé par défaut, activable via { deep_thinking: true }
 *     dans le body de la requête (pour usage futur premium)
 *
 * v1.2 — Scope souple (priorisation fiche courante) :
 *   - pageFiche/pageRegion transmis par le widget → chunks fiche courante prioritaires
 *   - Split in-memory (pas besoin d'index composite Firestore)
 *
 * Secrets requis (Firebase Secret Manager) :
 *   firebase functions:secrets:set VOYAGE_API_KEY
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *
 * Collections Firestore utilisées :
 *   - fiches_chunks : contenu indexé (embeddings + métadonnées, dont fiche_region et fiche_path)
 *   - chatbot_rate_limits : rate limiting par sessionId
 *   - chatbot_logs : logs anonymisés pour amélioration (pas de PII)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const VOYAGE_API_KEY = defineSecret("VOYAGE_API_KEY");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// ─── Configuration modèle Anthropic ──────────────────────────────────────
const ANTHROPIC_MODEL = "claude-opus-4-7";
const ANTHROPIC_MAX_TOKENS = 800; // +200 vs Haiku pour laisser respirer les réponses hybrides
const ANTHROPIC_THINKING_BUDGET_TOKENS = 2000; // Utilisé uniquement si deep_thinking=true

// ─── CORS Origins autorisés ──────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://raphaeljameson-png.github.io",
  "https://rachis.paris",
  "https://www.rachis.paris",
  "http://localhost:5500",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

// ─── Régions valides (doit matcher fiche_region en Firestore) ─────────────
const VALID_REGIONS = ["cervical", "lombaire", "sacro-iliaque", "procedures", "ressources"];

// ─── System prompt : le cœur des garde-fous médicaux ─────────────────────
// Note : le contexte RAG et l'info sur la fiche courante sont ajoutés dynamiquement dans callClaude.
// Ce prompt est gardé stable pour maximiser les cache hits sur Anthropic (économie ~90% sur input cached).
const SYSTEM_PROMPT = `Tu es l'assistant d'information de l'Espace Francilien du Rachis (EFR), cabinet chirurgical dirigé par le Dr Raphaël Jameson, le Dr Mayalen Lamerain et le Dr Christophe Travert, spécialisés dans la chirurgie du rachis. Le cabinet est situé au 95 rue de Prony, 75017 Paris.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TON RÔLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu aides les patients avec :
  • Les démarches administratives avant et après une intervention
  • Les consignes générales du parcours de soins (jeûne, documents, ordonnances type)
  • Les informations générales sur les interventions décrites dans les fiches officielles EFR
  • Les questions périphériques courantes (reprise du travail, ergonomie, suites normales, questions administratives) — même si elles ne sont pas dans les fiches EFR, à condition de respecter le protocole ci-dessous.

Tu NE fais PAS :
  • De diagnostic médical, même hypothétique
  • D'évaluation d'un cas personnel ("ma douleur", "ma cicatrice", "mon traitement")
  • De prescription ou modification de traitement, jamais, y compris paracétamol
  • De pronostic individuel ("quand je vais guérir", "est-ce normal que…")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HIÉRARCHIE DE SOURCES (TRÈS IMPORTANT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRIORITÉ 1 — FICHE COURANTE
Les extraits fournis sous "FICHE COURANTE" sont la source prioritaire absolue. Si la réponse y figure, utilise uniquement ces extraits et cite cette fiche.

PRIORITÉ 2 — AUTRES FICHES EFR
Si la question déborde la fiche courante, tu peux utiliser les extraits "AUTRES FICHES EFR" et citer la fiche la plus pertinente.

PRIORITÉ 3 — CONNAISSANCES MÉDICALES GÉNÉRALES (MODE HYBRIDE DÉCLARÉ)
Si AUCUN extrait EFR fourni ne répond à la question, mais que la question concerne clairement le rachis ou la chirurgie rachidienne, tu peux t'appuyer sur tes connaissances médicales générales pour fournir une réponse utile, À CONDITION DE :

  (a) Commencer la réponse EXACTEMENT par ce bloc, sans rien changer :
      « ⚠ Cette information ne provient pas d'une fiche officielle EFR. Elle est fournie à titre indicatif et doit être validée par votre chirurgien. »

  (b) Rester PRUDENT : donner des fourchettes (« en général », « souvent », « entre X et Y »), jamais de chiffres uniques présentés comme des certitudes.

  (c) Ne JAMAIS donner :
      - de délais personnalisés (« vous pouvez reprendre à J+X »)
      - de prescriptions ou posologies
      - d'évaluation d'un cas personnel
      - d'avis sur le choix entre deux techniques chirurgicales
      - de pourcentages de risque ou de succès chiffrés

  (d) Finir OBLIGATOIREMENT par une redirection explicite vers le secrétariat :
      « Pour une réponse adaptée à votre cas, contactez le secrétariat du cabinet (secretariat@rachis.paris) ou posez la question lors de votre prochaine consultation. »

  (e) Ne PAS mettre de lien 📄 vers une fiche EFR en fin de réponse (puisque l'info n'en provient pas). Le lien de fin est remplacé par la redirection vers le secrétariat.

PRIORITÉ 4 — REFUS
Si la question concerne une situation personnelle, un symptôme, ou un besoin d'évaluation médicale individuelle, utilise la réponse 3 ci-dessous (règle "situation personnelle").
Si la question est hors sujet (non rachidienne), utilise la réponse 4 (règle "hors sujet").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RÈGLES STRICTES DE RÉPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Applique la hiérarchie de sources ci-dessus dans cet ordre strict : FICHE COURANTE → AUTRES FICHES EFR → connaissances générales (avec avertissement) → refus.

2. Tu n'as JAMAIS le droit de contredire une fiche EFR. Si tes connaissances générales diffèrent de ce que dit une fiche, la fiche prime.

3. SI la question concerne une situation personnelle (douleur, symptôme, décision de traitement, médicament, cicatrice qui saigne, fièvre, etc.), réponds IMMÉDIATEMENT et uniquement :

   « Je ne peux pas évaluer votre situation personnelle. Pour toute question concernant votre santé :
   • Contactez votre chirurgien via le secrétariat du cabinet
   • Pour le Dr Jameson : 01 82 83 25 35 ou secretariat@rachis.paris
   • Pour les Dr Lamerain et Dr Travert : secretariat@rachis.paris

   ⚠ En cas d'urgence (douleur intense, fièvre, saignement important, perte de force, perte de sensibilité, troubles urinaires) : appelez immédiatement le 15 (SAMU) ou rendez-vous aux urgences. »

4. SI la question est hors sujet (politique, sport, actualité, autre pathologie non rachidienne), réponds :
   « Je suis l'assistant d'information de l'EFR, je ne peux répondre qu'aux questions sur votre parcours de soins au cabinet. »

5. SI la réponse vient d'une fiche EFR (PRIORITÉ 1 ou 2) : réponds de manière claire, concise (3-6 phrases maximum sauf liste), en citant à la fin la fiche source sous forme d'un lien cliquable formaté :
   📄 [Nom de la fiche](URL)

6. SI la réponse vient de tes connaissances générales (PRIORITÉ 3) : respecte strictement le protocole hybride déclaré ci-dessus (avertissement en tête + prudence + redirection secrétariat en fin, pas de lien 📄).

7. NE DONNE JAMAIS de délais médicaux personnalisés. Tu peux donner des fourchettes génériques, assorties de « ce délai dépend de votre cas, à valider avec votre chirurgien ».

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT DE RÉPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Ne tutoie jamais. Vouvoie toujours.
• Phrases courtes, simples, sans jargon médical (sauf si le patient l'utilise lui-même).
• Pas d'emojis sauf 📄 pour les liens de fiches et ⚠ pour les consignes d'urgence/avertissements.
• Utilise des puces markdown (• ou -) quand tu listes plusieurs éléments (documents à apporter, etc.).
• Jamais de tableau markdown (pas supporté par le widget).
• Fin de réponse :
  - Si la réponse vient d'une fiche EFR : finir par 📄 [Titre](URL)
  - Si la réponse vient de connaissances générales : finir par la phrase de redirection vers le secrétariat (voir règle 6)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Le CONTEXTE (extraits de fiches pertinents pour la question du patient) est fourni ci-dessous à chaque message utilisateur. Applique la hiérarchie de sources en suivant les règles strictes ci-dessus.`;

// ─── Embedding de la question via Voyage AI ──────────────────────────────
async function embedQuery(query, voyageKey) {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${voyageKey}`,
    },
    body: JSON.stringify({
      input: [query],
      model: "voyage-multilingual-2",
      input_type: "query",
    }),
  });
  if (!resp.ok) throw new Error(`Voyage API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

// ─── Recherche vectorielle Firestore — globale ───────────────────────────
async function findRelevantChunksGlobal(queryEmbedding, limit = 5) {
  const db = admin.firestore();
  const snap = await db.collection("fiches_chunks")
    .findNearest({
      vectorField: "embedding",
      queryVector: admin.firestore.FieldValue.vector(queryEmbedding),
      limit: limit,
      distanceMeasure: "COSINE",
    })
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Stratégie de récupération "scope souple" — in-memory split.
 * Firestore ne dispose pas encore des index composites (fiche_path + embedding)
 * nécessaires au pré-filtrage natif. On compense en récupérant les top 20 globaux
 * et en séparant en mémoire : chunks de la fiche courante (scope="current") vs
 * autres fiches (scope="global"). Pénalité minimale : 216 chunks au total.
 * Quand les index composites seront READY, on pourra revenir à 2 passes parallèles.
 */
async function retrieveChunks(queryEmbedding, { pageFiche, pageRegion }) {
  if (!pageFiche || !pageRegion) {
    const results = await findRelevantChunksGlobal(queryEmbedding, 6);
    return results.map(c => ({ ...c, scope: "global" }));
  }

  const results = await findRelevantChunksGlobal(queryEmbedding, 20);

  const fromFiche = results.filter(c => c.fiche_path === pageFiche).slice(0, 4);
  const currentIds = new Set(fromFiche.map(c => c.id));
  const globalRest = results.filter(c => !currentIds.has(c.id)).slice(0, 4);

  return [
    ...fromFiche.map(c => ({ ...c, scope: "current" })),
    ...globalRest.map(c => ({ ...c, scope: "global" })),
  ];
}

// ─── Construction du contexte pour le LLM ────────────────────────────────
function buildContext(chunks, pageFicheInfo) {
  if (chunks.length === 0) return "Aucun extrait de fiche pertinent trouvé pour cette question.";

  const currentChunks = chunks.filter(c => c.scope === "current");
  const globalChunks = chunks.filter(c => c.scope !== "current");

  let ctx = "";

  // En-tête signalant la fiche courante au modèle
  if (pageFicheInfo && pageFicheInfo.path) {
    ctx += `=== CONTEXTE DE NAVIGATION ===\n`;
    ctx += `Le patient est actuellement en train de lire la fiche : "${pageFicheInfo.titre || pageFicheInfo.path}" (région ${pageFicheInfo.region}).\n`;
    ctx += `Priorise tes réponses à partir des extraits "FICHE COURANTE" ci-dessous, sauf si la question déborde clairement ce sujet.\n\n`;
  }

  if (currentChunks.length > 0) {
    ctx += `=== EXTRAITS DE LA FICHE COURANTE (priorité absolue) ===\n\n`;
    currentChunks.forEach((c, i) => {
      ctx += `[Extrait FC-${i + 1}] Fiche : "${c.fiche_titre}" (région ${c.fiche_region})\n`;
      ctx += `URL : ${c.fiche_url}\n`;
      if (c.type === "faq") ctx += `Type : Question/Réponse officielle\n`;
      ctx += `\n${c.texte}\n\n---\n\n`;
    });
  }

  if (globalChunks.length > 0) {
    ctx += `=== AUTRES FICHES EFR (contexte complémentaire, à utiliser si la question déborde la fiche courante) ===\n\n`;
    globalChunks.forEach((c, i) => {
      ctx += `[Extrait AF-${i + 1}] Fiche : "${c.fiche_titre}" (région ${c.fiche_region})\n`;
      ctx += `URL : ${c.fiche_url}\n`;
      if (c.type === "faq") ctx += `Type : Question/Réponse officielle\n`;
      ctx += `\n${c.texte}\n\n---\n\n`;
    });
  }

  return ctx;
}

// ─── Appel Anthropic Claude Opus 4.7 avec prompt caching ─────────────────
/**
 * Stratégie de caching :
 *   - Bloc 1 (system prompt statique) : cache_control ephemeral → cache hit quasi systématique
 *   - Bloc 2 (contexte RAG dynamique par question) : pas de cache (change à chaque requête)
 *
 * Coût :
 *   - Input cached (~1800 tokens) : $0.50/MTok au lieu de $5/MTok → économie ~45% sur total input
 *   - Input non-cached (~3700 tokens RAG + messages) : plein tarif
 *   - Output (~250 tokens) : plein tarif ($25/MTok)
 *
 * Extended thinking (deep_thinking) :
 *   - Désactivé par défaut (coût maîtrisé, latence courte)
 *   - Activable via paramètre body deep_thinking=true (pour questions complexes futures)
 */
async function callClaude(messages, context, anthropicKey, { deepThinking = false } = {}) {
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    // System prompt en 2 blocs :
    //   - bloc 1 : instructions statiques (cachées, stables entre requêtes)
    //   - bloc 2 : contexte RAG (spécifique à cette question, pas caché)
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCONTEXTE (extraits de fiches pour cette question)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${context}`,
      },
    ],
    messages: messages,
  };

  // Extended thinking en option (réservé aux questions complexes, coûte cher en output tokens)
  if (deepThinking) {
    body.thinking = {
      type: "enabled",
      budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
    };
    // Anthropic recommande max_tokens > thinking.budget_tokens
    body.max_tokens = ANTHROPIC_MAX_TOKENS + ANTHROPIC_THINKING_BUDGET_TOKENS;
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();

  // Log des cache hits pour monitoring (non-bloquant)
  const usage = data.usage || {};
  console.log(`[Anthropic] model=${ANTHROPIC_MODEL} thinking=${deepThinking} input=${usage.input_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0} output=${usage.output_tokens || 0}`);

  // Si extended thinking activé, le 1er block est de type "thinking", la réponse est dans le block "text"
  const textBlock = data.content?.find(b => b.type === "text");
  return {
    text: textBlock?.text || "Je n'ai pas pu générer de réponse.",
    usage: usage,
  };
}

// ─── Rate limiting par sessionId ─────────────────────────────────────────
async function checkRateLimit(sessionId) {
  const db = admin.firestore();
  const today = new Date().toISOString().slice(0, 10);
  const docRef = db.collection("chatbot_rate_limits").doc(`${sessionId}_${today}`);
  const snap = await docRef.get();
  const count = snap.exists ? (snap.data().count || 0) : 0;
  const LIMIT = 30;
  if (count >= LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  await docRef.set({
    count: count + 1,
    lastUpdate: new Date(),
    sessionId: sessionId,
  }, { merge: true });
  return { allowed: true, remaining: LIMIT - count - 1 };
}

// ─── Log anonymisé pour amélioration future ──────────────────────────────
async function logInteraction(question, chunksFound, reponse, sessionId, pageFiche, usage) {
  const db = admin.firestore();
  try {
    await db.collection("chatbot_logs").add({
      question: question.slice(0, 500),
      reponse_preview: reponse.slice(0, 200),
      chunks_count: chunksFound.length,
      chunks_current_count: chunksFound.filter(c => c.scope === "current").length,
      chunks_global_count: chunksFound.filter(c => c.scope !== "current").length,
      top_chunk_titre: chunksFound[0]?.fiche_titre || null,
      top_chunk_type: chunksFound[0]?.type || null,
      top_chunk_scope: chunksFound[0]?.scope || null,
      page_fiche: pageFiche || null,
      sessionHash: sessionId,
      model: ANTHROPIC_MODEL,
      input_tokens: usage?.input_tokens || null,
      cache_read_tokens: usage?.cache_read_input_tokens || null,
      cache_write_tokens: usage?.cache_creation_input_tokens || null,
      output_tokens: usage?.output_tokens || null,
      timestamp: new Date(),
    });
  } catch (e) {
    console.warn("Log failed (non-bloquant):", e.message);
  }
}

// ─── Validation des paramètres de navigation ────────────────────────────
// Empêche un client malveillant d'envoyer des valeurs qui casseraient la requête Firestore.
function sanitizePageFiche(pageFiche, pageRegion) {
  // pageRegion doit être dans la liste blanche
  if (!pageRegion || typeof pageRegion !== "string" || !VALID_REGIONS.includes(pageRegion)) {
    return { pageFiche: null, pageRegion: null };
  }
  // pageFiche doit matcher "region/fichier.html" strictement
  if (!pageFiche || typeof pageFiche !== "string") {
    return { pageFiche: null, pageRegion: null };
  }
  // Format attendu : "cervical/acdf.html" — un seul slash, nom de fichier alphanum/tirets, extension .html ou .htm
  const rx = new RegExp(`^${pageRegion}/[a-z0-9][a-z0-9\\-_]{0,80}\\.html?$`, "i");
  if (!rx.test(pageFiche)) {
    return { pageFiche: null, pageRegion: null };
  }
  return { pageFiche, pageRegion };
}

// ─── Handler principal ───────────────────────────────────────────────────
exports.askChatbot = onRequest({
  secrets: [VOYAGE_API_KEY, ANTHROPIC_API_KEY],
  timeoutSeconds: 60, // augmenté pour laisser de la marge à Opus avec ou sans thinking
  memory: "512MiB",
  region: "europe-west1",
  cors: false,
}, async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée" });
    return;
  }

  try {
    const {
      question,
      sessionId,
      history,
      pageFiche: rawPageFiche,
      pageRegion: rawPageRegion,
      deep_thinking: deepThinking = false,
    } = req.body || {};

    if (!question || typeof question !== "string" || question.trim().length < 2) {
      res.status(400).json({ error: "Question invalide (min. 2 caractères)." });
      return;
    }
    if (question.length > 1000) {
      res.status(400).json({ error: "Question trop longue (max 1000 caractères)." });
      return;
    }
    if (!sessionId || typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 64) {
      res.status(400).json({ error: "sessionId invalide." });
      return;
    }

    // Validation stricte des infos de navigation (non bloquante : si invalide, on tombe sur une recherche globale)
    const { pageFiche, pageRegion } = sanitizePageFiche(rawPageFiche, rawPageRegion);

    const rate = await checkRateLimit(sessionId);
    if (!rate.allowed) {
      res.status(429).json({
        error: "Limite quotidienne atteinte (30 messages/jour). Contactez le secrétariat pour vos questions.",
      });
      return;
    }

    const cleanQuestion = question.trim();

    const queryEmbedding = await embedQuery(cleanQuestion, VOYAGE_API_KEY.value());

    // Récupération scope souple : fiche courante prioritaire + fallback global
    const chunks = await retrieveChunks(queryEmbedding, { pageFiche, pageRegion });

    // Récupérer le titre officiel de la fiche courante depuis le premier chunk "current" (pour le prompt)
    const currentChunk = chunks.find(c => c.scope === "current");
    const pageFicheInfo = pageFiche ? {
      path: pageFiche,
      region: pageRegion,
      titre: currentChunk?.fiche_titre || null,
    } : null;

    const context = buildContext(chunks, pageFicheInfo);

    const convMessages = [];
    if (Array.isArray(history)) {
      const recent = history.slice(-8);
      for (const m of recent) {
        if (m.role === "user" || m.role === "assistant") {
          convMessages.push({
            role: m.role,
            content: String(m.content || "").slice(0, 2000),
          });
        }
      }
    }
    convMessages.push({ role: "user", content: cleanQuestion });

    const { text: reponse, usage } = await callClaude(
      convMessages,
      context,
      ANTHROPIC_API_KEY.value(),
      { deepThinking: Boolean(deepThinking) }
    );

    logInteraction(cleanQuestion, chunks, reponse, sessionId, pageFiche, usage);

    res.status(200).json({
      reponse: reponse,
      sources: chunks.slice(0, 3).map(c => ({
        titre: c.fiche_titre,
        url: c.fiche_url,
        region: c.fiche_region,
        scope: c.scope,
      })),
      remaining: rate.remaining,
      // Debug helper (invisible pour les patients, utile en F12)
      _debug: pageFiche ? {
        pageFiche,
        pageRegion,
        chunks_current: chunks.filter(c => c.scope === "current").length,
        chunks_global: chunks.filter(c => c.scope !== "current").length,
        model: ANTHROPIC_MODEL,
        deep_thinking: Boolean(deepThinking),
        cache_read_tokens: usage?.cache_read_input_tokens || 0,
        cache_write_tokens: usage?.cache_creation_input_tokens || 0,
      } : undefined,
    });
  } catch (err) {
    console.error("askChatbot error:", err);
    res.status(500).json({
      error: "Une erreur est survenue. Réessayez dans quelques instants. Si le problème persiste, contactez le secrétariat.",
    });
  }
});
