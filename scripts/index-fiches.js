/**
 * index-fiches.js — Indexation des fiches patient EFR vers Firestore
 *
 * Source : repo GitHub fiches-information-patient (branch main)
 * Pipeline :
 *   1. Fetch de la liste des fiches HTML depuis GitHub (raw)
 *   2. Extraction du JSON-LD FAQPage (gold standard, Q/R validées)
 *   3. Extraction du texte principal
 *   4. Chunking en ~300 mots avec overlap
 *   5. Embedding via Voyage AI (voyage-multilingual-2, 1024 dims)
 *   6. Écriture dans Firestore collection `fiches_chunks`
 *
 * Usage :
 *   VOYAGE_API_KEY=pa-xxx \
 *   GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json \
 *   node scripts/index-fiches.js
 *
 * Peut être relancé : il fait un upsert (efface puis réécrit tout).
 *
 * Gestion des rate limits :
 *   - Par défaut : batches de 8 chunks avec pause de 22s entre batches (adapté au tier gratuit
 *     Voyage sans CB : 3 RPM / 10k TPM). Durée totale : ~10 min pour ~220 chunks.
 *   - Si tu ajoutes une CB sur Voyage (= rate limits standard 300 RPM / 1M TPM) :
 *     set VOYAGE_FAST=1 pour passer à des batches de 64 et une pause de 0.3s (durée ~30s).
 *   - Retry automatique avec backoff exponentiel si 429 reçu malgré tout.
 */

const admin = require("firebase-admin");

// ─── Configuration ────────────────────────────────────────────────────────
const FICHES_REPO = "raphaeljameson-png/fiches-information-patient";
const FICHES_BRANCH = "main";
const FICHES_BASE_URL = `https://raw.githubusercontent.com/${FICHES_REPO}/${FICHES_BRANCH}`;
const PORTAL_BASE_URL = `https://raphaeljameson-png.github.io/fiches-information-patient`;

const FICHES = [
  { path: "cervical/acdf.html",                    titre: "Arthrodèse cervicale ACDF",          region: "cervical" },
  { path: "cervical/prothese-discale.html",        titre: "Prothèse discale cervicale",         region: "cervical" },
  { path: "cervical/laminectomie.html",            titre: "Canal cervical étroit (voie postérieure)", region: "cervical" },
  { path: "cervical/livret-kine.html",             titre: "Livret kiné cervical",               region: "cervical" },
  { path: "lombaire/hernie-discale.html",          titre: "Hernie discale lombaire",            region: "lombaire" },
  { path: "lombaire/alif.html",                    titre: "Arthrodèse ALIF",                    region: "lombaire" },
  { path: "lombaire/tlif.html",                    titre: "Arthrodèse TLIF mini-invasive",      region: "lombaire" },
  { path: "lombaire/arthrodese-posterieure.html",  titre: "Arthrodèse postérieure conventionnelle", region: "lombaire" },
  { path: "lombaire/stenose-mini-invasive.html",   titre: "Sténose lombaire mini-invasive",     region: "lombaire" },
  { path: "lombaire/laminectomie.html",            titre: "Canal lombaire étroit (open)",       region: "lombaire" },
  { path: "lombaire/prothese-discale.html",        titre: "Prothèse discale lombaire",          region: "lombaire" },
  { path: "lombaire/neurolyse.html",               titre: "Neurolyse lombaire",                 region: "lombaire" },
  { path: "lombaire/reeducation-post-op.html",     titre: "Rééducation post-opératoire lombaire", region: "lombaire" },
  { path: "lombaire/reprise-travail.html",         titre: "Reprise du travail après chirurgie lombaire", region: "lombaire" },
  { path: "lombaire/ube-endoscopie.html",          titre: "Endoscopie UBE du rachis",           region: "lombaire" },
  { path: "lombaire/livret-kine.html",             titre: "Livret kiné lombaire",               region: "lombaire" },
  { path: "sacro-iliaque/arthrodese.html",         titre: "Arthrodèse sacro-iliaque",           region: "sacro-iliaque" },
  { path: "procedures/cimentoplastie-spinejack.html", titre: "Cimentoplastie / SpineJack",      region: "procedures" },
  { path: "procedures/infiltrations.html",         titre: "Infiltrations rachidiennes",         region: "procedures" },
  { path: "ressources/livret-transversal.html",    titre: "Livret transversal (préparation)",   region: "ressources" },
  { path: "ressources/conseils-kine.html",         titre: "Conseils pour le kinésithérapeute",  region: "ressources" },
  { path: "ressources/ecole-du-dos.html",          titre: "École du dos — bonnes postures",     region: "ressources" },
];

const CHUNK_WORDS = 300;
const CHUNK_OVERLAP = 50;

// Rate limit config
// Tier gratuit Voyage (sans CB) : 3 RPM, 10k TPM. On reste TRÈS conservateur pour éviter les 429.
// Tier payant (avec CB enregistrée) : 300 RPM, 1M TPM.
const SLOW_MODE = process.env.VOYAGE_FAST !== "1";
const BATCH_SIZE = SLOW_MODE ? 8 : 64;
const SLEEP_BETWEEN_BATCHES_MS = SLOW_MODE ? 22000 : 300;

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractBalancedElement(html, openingTagRegex) {
  const m = html.match(openingTagRegex);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  let depth = 1;
  let i = startIdx;
  const tagName = m[0].match(/^<(\w+)/)[1].toLowerCase();
  const openRx = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const closeRx = new RegExp(`</${tagName}\\s*>`, "gi");
  while (depth > 0 && i < html.length) {
    openRx.lastIndex = i;
    closeRx.lastIndex = i;
    const nextOpen = openRx.exec(html);
    const nextClose = closeRx.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) return html.slice(startIdx, nextClose.index);
      i = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<div[^>]+class=["'][^"']*\btoolbar\b[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\s+class=["'][^"']*\btop\b[^"']*["'][\s\S]*?<\/header>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z0-9]+;/gi, " ")
    .replace(/\[cite:\s*[\d,\s]+\]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function extractFAQ(html) {
  const faqs = [];
  const jsonLdMatches = html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data["@type"] === "FAQPage" && Array.isArray(data.mainEntity)) {
        for (const q of data.mainEntity) {
          if (q["@type"] === "Question" && q.name && q.acceptedAnswer?.text) {
            faqs.push({
              question: q.name.trim(),
              reponse: q.acceptedAnswer.text.trim(),
            });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }
  return faqs;
}

function extractBody(html) {
  let content = extractBalancedElement(html, /<div[^>]+class=["'][^"']*\bpage\b[^"']*["'][^>]*>/i);
  if (!content) {
    content = extractBalancedElement(html, /<div[^>]+class=["'][^"']*\bwrap\b[^"']*["'][^>]*>/i);
  }
  if (!content) {
    const m = html.match(/<main[^>]*>([\s\S]+?)<\/main>/i);
    content = m ? m[1] : null;
  }
  if (!content) {
    const m = html.match(/<body[^>]*>([\s\S]+?)<\/body>/i);
    content = m ? m[1] : html;
  }
  return stripHtml(content);
}

function chunkText(text, wordsPerChunk = CHUNK_WORDS, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= wordsPerChunk) return [text];
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + wordsPerChunk, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlap;
  }
  return chunks;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Appel Voyage avec retry automatique sur 429 (rate limit).
 * Backoff exponentiel : 30s, 60s, 120s.
 */
async function embedBatchWithRetry(texts, voyageApiKey, inputType = "document", maxRetries = 4) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${voyageApiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: "voyage-multilingual-2",
          input_type: inputType,
        }),
      });
      if (resp.status === 429) {
        if (attempt >= maxRetries) {
          const err = await resp.text();
          throw new Error(`Voyage 429 après ${maxRetries} retries: ${err}`);
        }
        const waitMs = 30000 * Math.pow(2, attempt);
        console.log(`      ⏳ 429 rate limit, attente ${Math.round(waitMs / 1000)}s puis retry...`);
        await sleep(waitMs);
        attempt++;
        continue;
      }
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Voyage API error ${resp.status}: ${err}`);
      }
      const data = await resp.json();
      return data.data.map(d => d.embedding);
    } catch (err) {
      if (attempt < maxRetries && /fetch failed|ETIMEDOUT|ECONNRESET/.test(String(err))) {
        const waitMs = 5000 * (attempt + 1);
        console.log(`      ⏳ erreur réseau, attente ${waitMs / 1000}s puis retry...`);
        await sleep(waitMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// ─── Pipeline principal ───────────────────────────────────────────────────

async function main() {
  const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
  if (!VOYAGE_API_KEY) {
    console.error("ERREUR : VOYAGE_API_KEY manquante dans l'environnement.");
    process.exit(1);
  }

  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  console.log(`\n=== Indexation ${FICHES.length} fiches EFR ===`);
  console.log(`Mode : ${SLOW_MODE ? "LENT (tier gratuit Voyage, ~10min)" : "RAPIDE (tier payant, ~30s)"}`);
  console.log(`  Batch size : ${BATCH_SIZE} | Pause entre batches : ${SLEEP_BETWEEN_BATCHES_MS}ms\n`);

  console.log("1. Nettoyage de l'ancienne collection fiches_chunks...");
  const oldSnap = await db.collection("fiches_chunks").get();
  if (!oldSnap.empty) {
    for (let i = 0; i < oldSnap.docs.length; i += 400) {
      const batch = db.batch();
      oldSnap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    console.log(`   Supprimé ${oldSnap.size} anciens chunks.\n`);
  } else {
    console.log("   (collection vide)\n");
  }

  console.log("2. Téléchargement et extraction des fiches...");
  const allChunks = [];
  let totalBodyWords = 0;
  for (const fiche of FICHES) {
    const url = `${FICHES_BASE_URL}/${fiche.path}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`   ⚠ ${fiche.path} : HTTP ${resp.status}, sauté.`);
      continue;
    }
    const html = await resp.text();
    const faqs = extractFAQ(html);
    const body = extractBody(html);
    const bodyWords = body.split(/\s+/).filter(Boolean).length;
    totalBodyWords += bodyWords;

    const ficheUrl = `${PORTAL_BASE_URL}/${fiche.path}`;
    const ficheId = fiche.path.replace(/[\/\.]/g, "_").replace(/_html$/, "");

    for (let i = 0; i < faqs.length; i++) {
      const f = faqs[i];
      allChunks.push({
        id: `${ficheId}__faq_${i}`,
        texte: `Question : ${f.question}\nRéponse : ${f.reponse}`,
        type: "faq",
        question: f.question,
        fiche_titre: fiche.titre,
        fiche_url: ficheUrl,
        fiche_region: fiche.region,
        fiche_path: fiche.path,
      });
    }

    const bodyChunks = chunkText(body);
    for (let i = 0; i < bodyChunks.length; i++) {
      const textePrefixe = `[${fiche.titre}]\n\n${bodyChunks[i]}`;
      allChunks.push({
        id: `${ficheId}__body_${i}`,
        texte: textePrefixe,
        type: "body",
        fiche_titre: fiche.titre,
        fiche_url: ficheUrl,
        fiche_region: fiche.region,
        fiche_path: fiche.path,
      });
    }

    console.log(`   ✓ ${fiche.path} — ${faqs.length} FAQ + ${bodyChunks.length} chunks corps (${bodyWords} mots)`);
  }
  console.log(`\n   Total chunks : ${allChunks.length}`);
  console.log(`   Total mots corps indexé : ${totalBodyWords}\n`);

  const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);
  const estimatedSec = Math.round((totalBatches * SLEEP_BETWEEN_BATCHES_MS) / 1000);
  console.log(`3. Génération des embeddings Voyage AI (voyage-multilingual-2)...`);
  console.log(`   ${totalBatches} batches à traiter — durée estimée ~${estimatedSec}s`);

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.texte);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const embeddings = await embedBatchWithRetry(texts, VOYAGE_API_KEY, "document");
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = embeddings[j];
    }
    console.log(`   ✓ batch ${batchNum}/${totalBatches} — ${batch.length} embeddings`);

    // Écriture incrémentale dans Firestore (pas d'attente finale, et si le script plante plus tard,
    // au moins une partie des chunks sont en base).
    const writeBatch = db.batch();
    for (const c of batch) {
      const { id, embedding, ...rest } = c;
      writeBatch.set(db.collection("fiches_chunks").doc(id), {
        ...rest,
        embedding: admin.firestore.FieldValue.vector(embedding),
        indexedAt: new Date(),
      });
    }
    await writeBatch.commit();

    // Pause avant le prochain batch (sauf dernier)
    if (i + BATCH_SIZE < allChunks.length) {
      await sleep(SLEEP_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`\n=== Indexation terminée : ${allChunks.length} chunks écrits dans Firestore ===\n`);
  console.log("Prochaines étapes :");
  console.log("  1. Tester avec : node scripts/test-query.js \"ma question\"");
  console.log("  2. Déployer les Functions : firebase deploy --only functions");
}

main().catch(err => {
  console.error("\nÉCHEC :", err);
  process.exit(1);
});
