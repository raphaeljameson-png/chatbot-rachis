/**
 * functions/index.js — Backend Chatbot patient EFR v1.0
 *
 * Fonction principale :
 *   - askChatbot : pipeline RAG complet (embed query → search Firestore → LLM response)
 *
 * Secrets requis (Firebase Secret Manager) :
 *   firebase functions:secrets:set VOYAGE_API_KEY
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *
 * Collections Firestore utilisées :
 *   - fiches_chunks : contenu indexé (embeddings + métadonnées)
 *   - chatbot_rate_limits : rate limiting par sessionId
 *   - chatbot_logs : logs anonymisés pour amélioration (pas de PII)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const VOYAGE_API_KEY = defineSecret("VOYAGE_API_KEY");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

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

// ─── System prompt : le cœur des garde-fous médicaux ─────────────────────
const SYSTEM_PROMPT = `Tu es l'assistant d'information de l'Espace Francilien du Rachis (EFR), cabinet chirurgical dirigé par le Dr Raphaël Jameson, le Dr Mayalen Lamerain et le Dr Christophe Travert, spécialisés dans la chirurgie du rachis. Le cabinet est situé au 95 rue de Prony, 75017 Paris.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TON RÔLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu aides les patients avec :
  • Les démarches administratives avant et après une intervention
  • Les consignes générales du parcours de soins (jeûne, documents, ordonnances type)
  • Les informations générales sur les interventions décrites dans les fiches officielles EFR

Tu NE fais PAS :
  • De diagnostic médical, même hypothétique
  • D'évaluation d'un cas personnel ("ma douleur", "ma cicatrice", "mon traitement")
  • De prescription ou modification de traitement, jamais, y compris paracétamol
  • De pronostic individuel ("quand je vais guérir", "est-ce normal que…")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RÈGLES STRICTES DE RÉPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. UTILISE UNIQUEMENT les extraits de fiches EFR fournis ci-dessous dans la section CONTEXTE. Tu n'as PAS le droit d'inventer des informations qui n'y figurent pas, ni d'utiliser des connaissances générales médicales qui pourraient contredire les fiches.

2. SI la question concerne une situation personnelle (douleur, symptôme, décision de traitement, médicament, cicatrice qui saigne, fièvre, etc.), réponds IMMÉDIATEMENT et uniquement :

   « Je ne peux pas évaluer votre situation personnelle. Pour toute question concernant votre santé, contactez :
   • Le secrétariat du cabinet : [numéro à compléter]
   • En cas de douleur intense, fièvre, saignement important ou signe neurologique nouveau (perte de force, perte de sensibilité, troubles urinaires) : appelez le 15 (SAMU) ou rendez-vous aux urgences. »

3. SI la question est hors sujet (politique, sport, actualité, autre pathologie non rachidienne), réponds :
   « Je suis l'assistant d'information de l'EFR, je ne peux répondre qu'aux questions sur votre parcours de soins au cabinet. »

4. SI la réponse est dans les fiches : réponds de manière claire, concise (3-6 phrases maximum sauf liste), en citant à la fin la fiche source sous forme d'un lien cliquable formaté :
   📄 [Nom de la fiche](URL)

5. SI tu ne trouves pas la réponse dans le contexte fourni :
   « Je ne trouve pas cette information dans les fiches EFR. Pour une réponse précise, contactez le secrétariat ou posez la question lors de votre prochaine consultation. »

6. NE DONNE JAMAIS de délais médicaux personnalisés (reprise du sport, reprise du travail, arrêt médicaments). Tu peux donner des fourchettes génériques indiquées dans les fiches, mais toujours assorties de « ce délai dépend de votre cas, à valider avec votre chirurgien ».

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT DE RÉPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Ne tutoie jamais. Vouvoie toujours.
• Phrases courtes, simples, sans jargon médical (sauf si le patient l'utilise lui-même).
• Pas d'emojis sauf 📄 pour les liens de fiches et ⚠ pour les consignes d'urgence.
• Utilise des puces markdown (• ou -) quand tu listes plusieurs éléments (documents à apporter, etc.).
• Jamais de tableau markdown (pas supporté par le widget).
• Finis TOUJOURS par le lien vers la fiche source sous la forme : 📄 [Titre](URL)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Le CONTEXTE (extraits de fiches pertinents pour la question du patient) est fourni ci-dessous à chaque message utilisateur. Utilise-le strictement.`;

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

// ─── Recherche vectorielle Firestore ─────────────────────────────────────
async function findRelevantChunks(queryEmbedding, limit = 5) {
  const db = admin.firestore();
  const snap = await db.collection("fiches_chunks")
    .findNearest({
      vectorField: "embedding",
      queryVector: admin.firestore.FieldValue.vector(queryEmbedding),
      limit: limit,
      distanceMeasure: "COSINE",
    })
    .get();
  return snap.docs.map(d => d.data());
}

// ─── Construction du contexte pour le LLM ────────────────────────────────
function buildContext(chunks) {
  if (chunks.length === 0) return "Aucun extrait de fiche pertinent trouvé pour cette question.";
  let ctx = "=== EXTRAITS DE FICHES EFR PERTINENTS ===\n\n";
  chunks.forEach((c, i) => {
    ctx += `[Extrait ${i + 1}] Fiche : "${c.fiche_titre}" (région ${c.fiche_region})\n`;
    ctx += `URL : ${c.fiche_url}\n`;
    if (c.type === "faq") {
      ctx += `Type : Question/Réponse officielle\n`;
    }
    ctx += `\n${c.texte}\n\n---\n\n`;
  });
  return ctx;
}

// ─── Appel Anthropic Claude Haiku ────────────────────────────────────────
async function callClaude(messages, context, anthropicKey) {
  const systemWithContext = `${SYSTEM_PROMPT}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCONTEXTE (extraits de fiches pour cette question)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${context}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: systemWithContext,
      messages: messages,
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.content?.[0]?.text || "Je n'ai pas pu générer de réponse.";
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
async function logInteraction(question, chunksFound, reponse, sessionId) {
  const db = admin.firestore();
  try {
    await db.collection("chatbot_logs").add({
      question: question.slice(0, 500),
      reponse_preview: reponse.slice(0, 200),
      chunks_count: chunksFound.length,
      top_chunk_titre: chunksFound[0]?.fiche_titre || null,
      top_chunk_type: chunksFound[0]?.type || null,
      sessionHash: sessionId,
      timestamp: new Date(),
    });
  } catch (e) {
    console.warn("Log failed (non-bloquant):", e.message);
  }
}

// ─── Handler principal ───────────────────────────────────────────────────
exports.askChatbot = onRequest({
  secrets: [VOYAGE_API_KEY, ANTHROPIC_API_KEY],
  timeoutSeconds: 30,
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
    const { question, sessionId, history } = req.body || {};

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

    const rate = await checkRateLimit(sessionId);
    if (!rate.allowed) {
      res.status(429).json({
        error: "Limite quotidienne atteinte (30 messages/jour). Contactez le secrétariat pour vos questions.",
      });
      return;
    }

    const cleanQuestion = question.trim();

    const queryEmbedding = await embedQuery(cleanQuestion, VOYAGE_API_KEY.value());
    const chunks = await findRelevantChunks(queryEmbedding, 5);
    const context = buildContext(chunks);

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

    const reponse = await callClaude(convMessages, context, ANTHROPIC_API_KEY.value());

    logInteraction(cleanQuestion, chunks, reponse, sessionId);

    res.status(200).json({
      reponse: reponse,
      sources: chunks.slice(0, 3).map(c => ({
        titre: c.fiche_titre,
        url: c.fiche_url,
        region: c.fiche_region,
      })),
      remaining: rate.remaining,
    });
  } catch (err) {
    console.error("askChatbot error:", err);
    res.status(500).json({
      error: "Une erreur est survenue. Réessayez dans quelques instants. Si le problème persiste, contactez le secrétariat.",
    });
  }
});
